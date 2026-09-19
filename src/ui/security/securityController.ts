import {
  StorageError,
  type ReverificationFailure,
  type SecurityStatus,
  type StorageErrorCode,
  type VaultStorage,
} from "../../services/storage";
import type { RecoveryCodesBatch, TwoFactorSetup } from "../../services/twoFactor";
import { storageErrorMessage } from "../auth/messages";
import { SESSION_LOST_LOGOUT_MS } from "../entries/entriesController";
import { downloadFile, fileTimestamp, type DownloadFile } from "./download";
import {
  initialSecurityState,
  reduceSecurity,
  type EnableStep,
  type Operation,
  type OperationKind,
  type SecondFactorMethod,
  type SecurityEvent,
  type SecurityState,
} from "./securityMachine";
import {
  SECURITY_MESSAGES,
  changePasswordFailed,
  exportedMessage,
} from "./messages";

export type { DownloadFile };

/**
 * 安全設定控制器：持有狀態機、呼叫 Service Layer（storage.ts），並管理秘密與計時器的生命週期。
 *
 * 順序保證（皆在控制器層強制，不只是停用按鈕）：
 * - 變更主密碼：先 reverifyMasterPassword 通過，才呼叫 changeMasterPassword；任何失敗都明確告知「主密碼未變更」。
 * - 開啟 2FA：beginTwoFactorSetup 不寫入；必須在「輸入驗證碼」步驟、且已勾選「已保存救援碼」才呼叫
 *   confirmTwoFactorSetup（唯一的寫入點），因此寫入前使用者一定已經確認保存救援碼。
 * - 補發救援碼：begin 只產生新碼不寫入；必須勾選已保存才呼叫 commitRecoveryCodes，失敗時舊碼仍有效。
 * - 寫入中（busy）一律拒絕再次送出，狀態機也拒絕關閉。
 * - Argon2id 會佔住主執行緒：呼叫前先讓出一個繪製週期，確保「處理中」已顯示。
 *
 * 秘密處理：TOTP 秘鑰與救援碼明文只存在於本閉包（TwoFactorSetup／RecoveryCodesBatch 物件）
 * 與顯示期間的狀態中；完成、放棄、dispose 時捨棄。輸入的密碼只當參數傳遞。不使用 console。
 */

export type SecurityStorage = Pick<
  VaultStorage,
  | "getSecurityStatus"
  | "reverifyMasterPassword"
  | "changeMasterPassword"
  | "beginTwoFactorSetup"
  | "confirmTwoFactorSetup"
  | "disableTwoFactor"
  | "beginRecoveryCodesRegeneration"
  | "commitRecoveryCodes"
  | "exportVault"
>;

export interface SecurityControllerDeps {
  storage: SecurityStorage;
  /** 預設以 Blob 觸發瀏覽器下載；測試可注入 */
  download?: (file: DownloadFile) => void;
  /** session 已失效：先顯示提示，經 SESSION_LOST_LOGOUT_MS 後呼叫（瀏覽器中為 authController.logout()） */
  onSessionLost?: () => void;
  now?: () => number;
  /** 呼叫耗時的 Argon2id 前讓畫面先繪出「處理中」；測試可注入立即完成的版本 */
  yieldToPaint?: () => Promise<void>;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmation: string;
}

export interface SecurityController {
  getState(): SecurityState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;

  openChangePassword(): void;
  submitChangePassword(input: ChangePasswordInput): Promise<void>;

  /** 開啟並立即產生秘鑰與救援碼（尚未寫入）；2FA 已開啟時無效 */
  openEnableTwoFactor(): Promise<void>;
  goToEnableStep(step: EnableStep): void;
  setAcknowledged(acknowledged: boolean): void;
  submitEnableTwoFactor(totpCode: string): Promise<void>;

  openDisableTwoFactor(): void;
  switchDisableMethod(method: SecondFactorMethod): void;
  submitDisableTwoFactor(input: { password: string; code: string }): Promise<void>;

  openRegenerateRecoveryCodes(): void;
  submitRegenerateVerification(input: { password: string; totpCode: string }): Promise<void>;
  commitRecoveryCodes(): Promise<void>;

  /** 以 .txt 下載目前顯示的救援碼（開啟 2FA 或補發流程） */
  downloadRecoveryCodes(): void;

  openExport(): void;
  submitExport(): Promise<void>;

  /** 一般操作的「取消」；寫入中或秘密顯示中無效 */
  closeOperation(): void;
  requestAbandon(): void;
  cancelAbandon(): void;
  confirmAbandon(): void;
  dismissNotice(): void;

  dispose(): void;
}

/** §4.1：主密碼最短長度（與 services/masterPassword.ts 一致，該常數未匯出） */
const MIN_MASTER_PASSWORD_LENGTH = 12;

function defaultYieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

function sessionLostCode(error: unknown): StorageErrorCode | null {
  if (error instanceof StorageError && (error.code === "NOT_AUTHENTICATED" || error.code === "KEY_GENERATION_MISMATCH")) {
    return error.code;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof StorageError) return storageErrorMessage(error.code);
  return SECURITY_MESSAGES.writeFailed;
}

function validateChangePassword({ currentPassword, newPassword, confirmation }: ChangePasswordInput): string | null {
  if (currentPassword.length === 0) return SECURITY_MESSAGES.currentPasswordRequired;
  if (newPassword.length < MIN_MASTER_PASSWORD_LENGTH) return SECURITY_MESSAGES.newPasswordTooShort;
  if (newPassword !== confirmation) return SECURITY_MESSAGES.newPasswordMismatch;
  if (newPassword === currentPassword) return SECURITY_MESSAGES.newPasswordSameAsCurrent;
  return null;
}

function recoveryCodesText(codes: string[], generatedAt: number, pendingCommit: boolean): string {
  const lines = [
    "Password Keeper 救援碼",
    `產生時間：${new Date(generatedAt).toISOString()}`,
    "每組救援碼只能使用一次，請存放在安全的地方。",
  ];
  if (pendingCommit) lines.push("注意：須在畫面上按下「確認取代」後，這批救援碼才會生效。");
  lines.push("", ...codes.map((code, index) => `${index + 1}. ${code}`), "");
  return lines.join("\n");
}

export function createSecurityController(deps: SecurityControllerDeps): SecurityController {
  const { storage } = deps;
  const download = deps.download ?? downloadFile;
  const now = deps.now ?? (() => Date.now());
  const yieldToPaint = deps.yieldToPaint ?? defaultYieldToPaint;

  let state: SecurityState = initialSecurityState;
  const listeners = new Set<() => void>();
  let started = false;
  let disposed = false;
  let sessionLostTimer: ReturnType<typeof setTimeout> | null = null;
  /** 開啟 2FA 流程中的設定（含秘鑰與救援碼明文）；confirmTwoFactorSetup 須傳入同一物件 */
  let pendingSetup: TwoFactorSetup | null = null;
  /** 補發流程中的新救援碼批次；commitRecoveryCodes 須傳入同一物件 */
  let pendingBatch: RecoveryCodesBatch | null = null;

  function dispatch(event: SecurityEvent): void {
    const next = reduceSecurity(state, event);
    if (next === state) return;
    state = next;
    // 操作結束（完成、放棄、關閉）時一併捨棄閉包內的秘密
    if (state.phase !== "ready" || state.operation === null) {
      pendingSetup = null;
      pendingBatch = null;
    }
    for (const listener of listeners) listener();
  }

  function currentOperation(): Operation | null {
    return state.phase === "ready" ? state.operation : null;
  }

  function currentStatus(): SecurityStatus {
    return state.phase === "ready" ? state.status : { twoFactorEnabled: false, unusedRecoveryCodes: 0 };
  }

  /** 可送出：未關閉、session 有效、目前正是該操作、未在寫入中、未被鎖定 */
  function submittable<K extends OperationKind>(kind: K): Extract<Operation, { kind: K }> | null {
    if (disposed || state.phase !== "ready" || state.sessionLost) return null;
    const operation = state.operation;
    if (operation === null || operation.kind !== kind || operation.busy) return null;
    if (operation.lockedUntil !== null && operation.lockedUntil > now()) return null;
    return operation as Extract<Operation, { kind: K }>;
  }

  /** 非同步步驟之後確認：未關閉，且該操作仍在進行中 */
  function stillCurrent(kind: OperationKind): boolean {
    return !disposed && currentOperation()?.kind === kind;
  }

  function scheduleSessionLostLogout(): void {
    if (sessionLostTimer !== null) return;
    sessionLostTimer = setTimeout(() => {
      sessionLostTimer = null;
      deps.onSessionLost?.();
    }, SESSION_LOST_LOGOUT_MS);
  }

  /** 失敗回報：session 已失效時先提示再自動登出；其他錯誤依文案回報在目前操作上 */
  function fail(error: unknown, format: (message: string) => string = (message) => message): void {
    if (disposed) return;
    const code = sessionLostCode(error);
    if (code === null) {
      dispatch({ type: "FAILED", error: format(describeError(error)) });
      return;
    }
    dispatch({ type: "SESSION_LOST", error: `${format(storageErrorMessage(code))}${SECURITY_MESSAGES.sessionLostSuffix}` });
    scheduleSessionLostLogout();
  }

  function failVerification(result: ReverificationFailure): void {
    if (result.reason === "LOCKED") {
      dispatch({ type: "FAILED", error: null, lockedUntil: now() + result.waitSeconds * 1000 });
      return;
    }
    const messages = {
      INVALID_MASTER_PASSWORD: SECURITY_MESSAGES.masterPasswordInvalid,
      INVALID_TOTP_CODE: SECURITY_MESSAGES.totpInvalid,
      INVALID_RECOVERY_CODE: SECURITY_MESSAGES.recoveryCodeInvalid,
    } as const;
    dispatch({ type: "FAILED", error: messages[result.reason] });
  }

  /** 寫入成功後重新讀取狀態；讀取失敗時使用依操作結果推算的值（寫入已成功，不可回報為失敗） */
  async function refreshStatus(fallback: SecurityStatus): Promise<SecurityStatus> {
    try {
      return await storage.getSecurityStatus();
    } catch {
      return fallback;
    }
  }

  function open(kind: OperationKind): boolean {
    if (disposed) return false;
    const before = state;
    dispatch({ type: "OPENED", kind });
    return state !== before;
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load() {
      if (started || disposed) return;
      started = true;
      try {
        const status = await storage.getSecurityStatus();
        if (!disposed) dispatch({ type: "LOADED", status });
      } catch (error) {
        if (disposed) return;
        const code = sessionLostCode(error);
        if (code === null) {
          dispatch({ type: "LOAD_FAILED", error: SECURITY_MESSAGES.loadFailed });
        } else {
          dispatch({ type: "LOAD_FAILED", error: `${storageErrorMessage(code)}${SECURITY_MESSAGES.sessionLostSuffix}` });
          scheduleSessionLostLogout();
        }
      }
    },

    openChangePassword: () => void open("changePassword"),

    async submitChangePassword(input) {
      if (submittable("changePassword") === null) return;
      const invalid = validateChangePassword(input);
      if (invalid !== null) {
        dispatch({ type: "FAILED", error: invalid });
        return;
      }

      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.verifyingCurrentPassword });
      await yieldToPaint();
      if (!stillCurrent("changePassword")) return;

      let verification: Awaited<ReturnType<SecurityStorage["reverifyMasterPassword"]>>;
      try {
        verification = await storage.reverifyMasterPassword(input.currentPassword);
      } catch (error) {
        fail(error, changePasswordFailed);
        return;
      }
      if (!stillCurrent("changePassword")) return;
      if (!verification.ok) {
        if (verification.reason === "LOCKED") {
          dispatch({ type: "FAILED", error: null, lockedUntil: now() + verification.waitSeconds * 1000 });
        } else {
          dispatch({ type: "FAILED", error: changePasswordFailed(SECURITY_MESSAGES.currentPasswordInvalid) });
        }
        return;
      }

      // §4.1.1：rekey（Argon2id + 全部條目重新加密 + 單一交易）；storage 自行設定寫入鎖定並暫停閒置計時
      dispatch({ type: "PROGRESS_CHANGED", progress: SECURITY_MESSAGES.rekeying });
      await yieldToPaint();
      if (!stillCurrent("changePassword")) return;

      try {
        await storage.changeMasterPassword(input.newPassword);
      } catch (error) {
        if (error instanceof RangeError) {
          if (!disposed) dispatch({ type: "FAILED", error: changePasswordFailed(SECURITY_MESSAGES.newPasswordTooShort) });
        } else {
          fail(error, changePasswordFailed);
        }
        return;
      }
      if (disposed) return;
      // storage 已在原地換成新金鑰與新快照，session 維持登入
      dispatch({ type: "COMPLETED", status: currentStatus(), notice: SECURITY_MESSAGES.passwordChanged });
    },

    async openEnableTwoFactor() {
      if (!open("enableTwoFactor")) return;
      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.preparingSetup });

      let setup: TwoFactorSetup;
      try {
        setup = await storage.beginTwoFactorSetup();
      } catch (error) {
        fail(error);
        return;
      }
      if (!stillCurrent("enableTwoFactor")) return;
      pendingSetup = setup;
      dispatch({
        type: "TWO_FACTOR_SETUP_READY",
        setup: {
          secret: setup.secret,
          qrCodeDataUrl: setup.qrCodeDataUrl,
          recoveryCodes: [...setup.recoveryCodesPlaintext],
        },
      });
    },

    goToEnableStep: (step) => dispatch({ type: "STEP_CHANGED", step }),
    setAcknowledged: (acknowledged) => dispatch({ type: "ACKNOWLEDGED_CHANGED", acknowledged }),

    async submitEnableTwoFactor(totpCode) {
      const operation = submittable("enableTwoFactor");
      const setup = pendingSetup;
      // 唯一的寫入點：必須在輸入驗證碼步驟、且已確認保存救援碼
      if (operation === null || setup === null || operation.step !== "verify" || !operation.acknowledged) return;

      const code = totpCode.replace(/\s/g, "");
      if (code.length === 0) {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.totpRequired });
        return;
      }

      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.enabling });
      let result: Awaited<ReturnType<SecurityStorage["confirmTwoFactorSetup"]>>;
      try {
        result = await storage.confirmTwoFactorSetup(code, setup);
      } catch (error) {
        fail(error);
        return;
      }
      if (!stillCurrent("enableTwoFactor")) return;
      if (!result.ok) {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.enableTotpInvalid });
        return;
      }

      const status = await refreshStatus({
        twoFactorEnabled: true,
        unusedRecoveryCodes: setup.recoveryCodesPlaintext.length,
      });
      if (disposed) return;
      dispatch({ type: "COMPLETED", status, notice: SECURITY_MESSAGES.twoFactorEnabled });
    },

    openDisableTwoFactor: () => void open("disableTwoFactor"),
    switchDisableMethod: (method) => dispatch({ type: "METHOD_CHANGED", method }),

    async submitDisableTwoFactor({ password, code }) {
      const operation = submittable("disableTwoFactor");
      if (operation === null) return;
      const { method } = operation;
      if (password.length === 0) {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.masterPasswordRequired });
        return;
      }
      const secondFactorCode = method === "totp" ? code.replace(/\s/g, "") : code.trim();
      if (secondFactorCode.length === 0) {
        dispatch({
          type: "FAILED",
          error: method === "totp" ? SECURITY_MESSAGES.totpRequired : SECURITY_MESSAGES.recoveryCodeRequired,
        });
        return;
      }

      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.disabling });
      await yieldToPaint();
      if (!stillCurrent("disableTwoFactor")) return;

      let result: Awaited<ReturnType<SecurityStorage["disableTwoFactor"]>>;
      try {
        result = await storage.disableTwoFactor(
          password,
          method === "totp" ? { totpCode: secondFactorCode } : { recoveryCode: secondFactorCode }
        );
      } catch (error) {
        fail(error);
        return;
      }
      if (!stillCurrent("disableTwoFactor")) return;
      if (!result.ok) {
        failVerification(result);
        return;
      }

      const status = await refreshStatus({ twoFactorEnabled: false, unusedRecoveryCodes: 0 });
      if (disposed) return;
      dispatch({ type: "COMPLETED", status, notice: SECURITY_MESSAGES.twoFactorDisabled });
    },

    openRegenerateRecoveryCodes: () => void open("regenerateRecoveryCodes"),

    async submitRegenerateVerification({ password, totpCode }) {
      const operation = submittable("regenerateRecoveryCodes");
      if (operation === null || operation.step !== "verify") return;
      if (password.length === 0) {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.masterPasswordRequired });
        return;
      }
      const code = totpCode.replace(/\s/g, "");
      if (code.length === 0) {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.totpRequired });
        return;
      }

      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.regenerateVerifying });
      await yieldToPaint();
      if (!stillCurrent("regenerateRecoveryCodes")) return;

      let result: Awaited<ReturnType<SecurityStorage["beginRecoveryCodesRegeneration"]>>;
      try {
        result = await storage.beginRecoveryCodesRegeneration(password, code);
      } catch (error) {
        fail(error);
        return;
      }
      if (!stillCurrent("regenerateRecoveryCodes")) return;
      if (!result.ok) {
        failVerification(result);
        return;
      }
      // 只產生新碼，尚未寫入；舊碼在 commitRecoveryCodes 成功前仍然有效
      pendingBatch = result.batch;
      dispatch({ type: "RECOVERY_CODES_READY", recoveryCodes: [...result.batch.recoveryCodesPlaintext] });
    },

    async commitRecoveryCodes() {
      const operation = submittable("regenerateRecoveryCodes");
      const batch = pendingBatch;
      if (operation === null || batch === null || operation.step !== "codes" || !operation.acknowledged) return;

      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.committingCodes });
      try {
        await storage.commitRecoveryCodes(batch);
      } catch (error) {
        fail(error, (message) => `${message}${SECURITY_MESSAGES.commitFailedSuffix}`);
        return;
      }
      if (disposed) return;

      const status = await refreshStatus({
        twoFactorEnabled: true,
        unusedRecoveryCodes: batch.recoveryCodesPlaintext.length,
      });
      if (disposed) return;
      dispatch({ type: "COMPLETED", status, notice: SECURITY_MESSAGES.codesReplaced });
    },

    downloadRecoveryCodes() {
      const operation = currentOperation();
      let codes: string[] | null = null;
      let pendingCommit = false;
      if (operation?.kind === "enableTwoFactor" && operation.setup !== null) {
        codes = operation.setup.recoveryCodes;
      } else if (operation?.kind === "regenerateRecoveryCodes" && operation.recoveryCodes !== null) {
        codes = operation.recoveryCodes;
        pendingCommit = true;
      }
      if (codes === null || disposed) return;

      const generatedAt = now();
      try {
        download({
          fileName: `password-keeper-recovery-codes-${fileTimestamp(generatedAt)}.txt`,
          content: recoveryCodesText(codes, generatedAt, pendingCommit),
          mimeType: "text/plain;charset=utf-8",
        });
      } catch {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.downloadFailed });
      }
    },

    openExport: () => void open("export"),

    async submitExport() {
      if (submittable("export") === null) return;
      dispatch({ type: "SUBMITTING", progress: SECURITY_MESSAGES.exporting });

      let file: Awaited<ReturnType<SecurityStorage["exportVault"]>>;
      try {
        file = await storage.exportVault();
      } catch (error) {
        fail(error);
        return;
      }
      if (!stillCurrent("export")) return;

      const fileName = `password-keeper-backup-${fileTimestamp(now())}.json`;
      try {
        download({ fileName, content: JSON.stringify(file), mimeType: "application/json" });
      } catch {
        dispatch({ type: "FAILED", error: SECURITY_MESSAGES.downloadFailed });
        return;
      }
      dispatch({ type: "COMPLETED", status: currentStatus(), notice: exportedMessage(fileName) });
    },

    closeOperation: () => dispatch({ type: "OPERATION_CLOSED" }),
    requestAbandon: () => dispatch({ type: "ABANDON_REQUESTED" }),
    cancelAbandon: () => dispatch({ type: "ABANDON_CANCELLED" }),

    confirmAbandon() {
      const operation = currentOperation();
      if (operation?.kind === "enableTwoFactor") {
        dispatch({ type: "ABANDON_CONFIRMED", notice: SECURITY_MESSAGES.enableAbandoned });
      } else if (operation?.kind === "regenerateRecoveryCodes") {
        dispatch({ type: "ABANDON_CONFIRMED", notice: SECURITY_MESSAGES.regenerateAbandoned });
      }
    },

    dismissNotice: () => dispatch({ type: "NOTICE_DISMISSED" }),

    dispose() {
      if (disposed) return;
      disposed = true;
      pendingSetup = null;
      pendingBatch = null;
      if (sessionLostTimer !== null) clearTimeout(sessionLostTimer);
      sessionLostTimer = null;
      dispatch({ type: "CLOSED" });
    },
  };
}
