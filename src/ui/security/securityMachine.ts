import type { SecurityStatus } from "../../services/storage";

/**
 * 安全設定狀態機（純 reducer，不含副作用）。
 * 對應規格 §4.1.2 變更主密碼、§4.2 2FA 開啟／關閉／救援碼補發、§5.3 匯出。
 *
 * 關鍵保證（由 reducer 強制，不依賴按鈕停用）：
 * - 同時只能進行一項操作；依 2FA 狀態限制可開啟的操作（避免重複開啟覆蓋既有秘鑰）。
 * - 寫入中（busy）不可關閉、不可放棄、不可切換步驟。
 * - 秘鑰／救援碼顯示中不可直接關閉，只能「要求放棄 → 再次確認」離開。
 * - 開啟 2FA：未勾選「已保存救援碼」不可前進到輸入驗證碼步驟。
 * - 完成、放棄或關閉後，秘密隨操作一併自狀態移除。
 * 不適用於目前狀態的事件一律回傳原狀態。
 */

export type { SecurityStatus };

export type OperationKind = "changePassword" | "enableTwoFactor" | "disableTwoFactor" | "regenerateRecoveryCodes" | "export";
export type EnableStep = "scan" | "codes" | "verify";
export type SecondFactorMethod = "totp" | "recovery";

/** 開啟 2FA 時需讓使用者抄錄的內容；僅在該操作進行中存在 */
export interface TwoFactorSetupView {
  secret: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

interface OperationBase {
  busy: boolean;
  /** 處理中的階段說明（例如 rekey 需要較長時間） */
  progress: string | null;
  error: string | null;
  /** 驗證被鎖定時的解除時間（epoch ms） */
  lockedUntil: number | null;
}

export type Operation =
  | (OperationBase & { kind: "changePassword" })
  | (OperationBase & {
      kind: "enableTwoFactor";
      step: EnableStep;
      setup: TwoFactorSetupView | null;
      acknowledged: boolean;
      confirmingAbandon: boolean;
    })
  | (OperationBase & { kind: "disableTwoFactor"; method: SecondFactorMethod })
  | (OperationBase & {
      kind: "regenerateRecoveryCodes";
      step: "verify" | "codes";
      recoveryCodes: string[] | null;
      acknowledged: boolean;
      confirmingAbandon: boolean;
    })
  | (OperationBase & { kind: "export" });

export type SecurityState =
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | {
      phase: "ready";
      status: SecurityStatus;
      operation: Operation | null;
      notice: string | null;
      /** storage 已清除 session：之後任何操作都不會成功，等待自動登出 */
      sessionLost: boolean;
    }
  | { phase: "closed" };

export type ReadySecurityState = Extract<SecurityState, { phase: "ready" }>;

export type SecurityEvent =
  | { type: "LOADED"; status: SecurityStatus }
  | { type: "LOAD_FAILED"; error: string }
  | { type: "OPENED"; kind: OperationKind }
  | { type: "OPERATION_CLOSED" }
  | { type: "SUBMITTING"; progress: string | null }
  | { type: "PROGRESS_CHANGED"; progress: string }
  | { type: "FAILED"; error: string | null; lockedUntil?: number | null }
  | { type: "TWO_FACTOR_SETUP_READY"; setup: TwoFactorSetupView }
  | { type: "STEP_CHANGED"; step: EnableStep }
  | { type: "ACKNOWLEDGED_CHANGED"; acknowledged: boolean }
  | { type: "RECOVERY_CODES_READY"; recoveryCodes: string[] }
  | { type: "METHOD_CHANGED"; method: SecondFactorMethod }
  | { type: "ABANDON_REQUESTED" }
  | { type: "ABANDON_CANCELLED" }
  | { type: "ABANDON_CONFIRMED"; notice: string }
  | { type: "COMPLETED"; status: SecurityStatus; notice: string }
  | { type: "SESSION_LOST"; error: string }
  | { type: "NOTICE_DISMISSED" }
  | { type: "CLOSED" };

export const initialSecurityState: SecurityState = { phase: "loading" };

const IDLE: OperationBase = { busy: false, progress: null, error: null, lockedUntil: null };

function openOperation(kind: OperationKind): Operation {
  switch (kind) {
    case "changePassword":
      return { kind, ...IDLE };
    case "enableTwoFactor":
      return { kind, ...IDLE, step: "scan", setup: null, acknowledged: false, confirmingAbandon: false };
    case "disableTwoFactor":
      return { kind, ...IDLE, method: "totp" };
    case "regenerateRecoveryCodes":
      return { kind, ...IDLE, step: "verify", recoveryCodes: null, acknowledged: false, confirmingAbandon: false };
    case "export":
      return { kind, ...IDLE };
  }
}

function canOpen(state: ReadySecurityState, kind: OperationKind): boolean {
  if (state.operation !== null || state.sessionLost) return false;
  switch (kind) {
    case "enableTwoFactor":
      return !state.status.twoFactorEnabled;
    case "disableTwoFactor":
    case "regenerateRecoveryCodes":
      return state.status.twoFactorEnabled;
    default:
      return true;
  }
}

/** 秘鑰或救援碼正顯示在畫面上（尚未完成或放棄） */
export function hasDisplayedSecrets(operation: Operation | null): boolean {
  if (operation === null) return false;
  if (operation.kind === "enableTwoFactor") return operation.setup !== null;
  if (operation.kind === "regenerateRecoveryCodes") return operation.recoveryCodes !== null;
  return false;
}

export function reduceSecurity(state: SecurityState, event: SecurityEvent): SecurityState {
  if (state.phase === "closed") return state;
  if (event.type === "CLOSED") return { phase: "closed" };

  switch (state.phase) {
    case "loading":
      if (event.type === "LOADED") {
        return { phase: "ready", status: event.status, operation: null, notice: null, sessionLost: false };
      }
      if (event.type === "LOAD_FAILED") return { phase: "error", error: event.error };
      return state;
    case "error":
      return state;
    case "ready":
      return reduceReady(state, event);
  }
}

function withOperation(state: ReadySecurityState, operation: Operation): ReadySecurityState {
  return { ...state, operation };
}

function reduceReady(state: ReadySecurityState, event: SecurityEvent): SecurityState {
  const { operation } = state;

  switch (event.type) {
    case "OPENED":
      return canOpen(state, event.kind) ? { ...state, operation: openOperation(event.kind), notice: null } : state;

    case "OPERATION_CLOSED":
      if (operation === null || operation.busy || hasDisplayedSecrets(operation)) return state;
      return { ...state, operation: null };

    case "SUBMITTING":
      if (operation === null) return state;
      return withOperation(state, { ...operation, busy: true, progress: event.progress, error: null, lockedUntil: null });

    case "PROGRESS_CHANGED":
      if (operation === null || !operation.busy) return state;
      return withOperation(state, { ...operation, progress: event.progress });

    case "FAILED":
      if (operation === null) return state;
      return withOperation(state, {
        ...operation,
        busy: false,
        progress: null,
        error: event.error,
        lockedUntil: event.lockedUntil ?? null,
      });

    case "TWO_FACTOR_SETUP_READY":
      if (operation?.kind !== "enableTwoFactor" || operation.setup !== null) return state;
      return withOperation(state, { ...operation, ...IDLE, step: "scan", setup: event.setup });

    case "STEP_CHANGED": {
      if (operation?.kind !== "enableTwoFactor" || operation.setup === null) return state;
      if (operation.busy || operation.confirmingAbandon || operation.step === event.step) return state;
      // 未確認已保存救援碼，不得進入輸入驗證碼（寫入）步驟
      if (event.step === "verify" && !operation.acknowledged) return state;
      return withOperation(state, { ...operation, step: event.step, error: null });
    }

    case "ACKNOWLEDGED_CHANGED": {
      const onCodesStep =
        (operation?.kind === "enableTwoFactor" && operation.setup !== null && operation.step === "codes") ||
        (operation?.kind === "regenerateRecoveryCodes" && operation.step === "codes");
      if (!onCodesStep || operation === null || operation.busy) return state;
      if (operation.kind !== "enableTwoFactor" && operation.kind !== "regenerateRecoveryCodes") return state;
      return withOperation(state, { ...operation, acknowledged: event.acknowledged });
    }

    case "RECOVERY_CODES_READY":
      if (operation?.kind !== "regenerateRecoveryCodes" || operation.step !== "verify") return state;
      return withOperation(state, {
        ...operation,
        ...IDLE,
        step: "codes",
        recoveryCodes: event.recoveryCodes,
        acknowledged: false,
      });

    case "METHOD_CHANGED":
      if (operation?.kind !== "disableTwoFactor" || operation.busy) return state;
      return withOperation(state, { ...operation, method: event.method, error: null });

    case "ABANDON_REQUESTED":
      if (operation === null || operation.busy || !hasDisplayedSecrets(operation)) return state;
      if (operation.kind !== "enableTwoFactor" && operation.kind !== "regenerateRecoveryCodes") return state;
      return withOperation(state, { ...operation, confirmingAbandon: true });

    case "ABANDON_CANCELLED":
      if (operation?.kind !== "enableTwoFactor" && operation?.kind !== "regenerateRecoveryCodes") return state;
      if (!operation.confirmingAbandon) return state;
      return withOperation(state, { ...operation, confirmingAbandon: false });

    case "ABANDON_CONFIRMED":
      if (operation?.kind !== "enableTwoFactor" && operation?.kind !== "regenerateRecoveryCodes") return state;
      if (!operation.confirmingAbandon || operation.busy) return state;
      return { ...state, operation: null, notice: event.notice };

    case "COMPLETED":
      if (operation === null) return state;
      return { ...state, operation: null, status: event.status, notice: event.notice };

    case "SESSION_LOST":
      if (operation === null) return { ...state, sessionLost: true, notice: event.error };
      return {
        ...state,
        sessionLost: true,
        operation: { ...operation, busy: false, progress: null, error: event.error },
      };

    case "NOTICE_DISMISSED":
      return state.notice === null ? state : { ...state, notice: null };

    default:
      return state;
  }
}

/**
 * 導覽（分頁切換、登出）鎖定：寫入中，或秘鑰／救援碼顯示中（避免不小心離開而看不到這批碼）。
 * session 已失效時不鎖定，讓自動登出能進行。
 */
export function selectNavigationLocked(state: SecurityState): boolean {
  if (state.phase !== "ready" || state.sessionLost || state.operation === null) return false;
  return state.operation.busy || hasDisplayedSecrets(state.operation);
}

/** 寫入（或驗證）進行中：供 beforeunload 離頁警告使用 */
export function selectWriteInProgress(state: SecurityState): boolean {
  return state.phase === "ready" && state.operation !== null && state.operation.busy;
}
