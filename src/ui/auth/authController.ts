import type { IdleTimer } from "../../services/idleTimer";
import { ImportError, parseExportFile } from "../../services/importExport";
import { assertValidMasterPassword } from "../../services/masterPassword";
import {
  StorageError,
  type LoginResult,
  type PreLoginImportTicket,
  type SecondFactorInput,
  type SecondFactorResult,
  type VaultStorage,
} from "../../services/storage";
import { initialAuthState, reduceAuth, type AuthEvent, type AuthState, type SecondFactorMethod } from "./authMachine";
import { MESSAGES, importErrorMessage, storageErrorMessage } from "./messages";

/**
 * 登入／解鎖流程控制器：持有狀態機、呼叫 Service Layer（storage.ts）並管理閒置計時的生命週期。
 * 不處理任何密文；主密碼與備份密碼只作為參數轉交 storage，不保存於狀態中。
 */

export type AuthStorage = Pick<
  VaultStorage,
  "isInitialized" | "initialize" | "login" | "verifySecondFactor" | "logout" | "startPreLoginImport" | "importVault"
>;

export interface AuthControllerDeps {
  storage: AuthStorage;
  idleTimer: Pick<IdleTimer, "start" | "stop">;
  /** 綁定使用者活動監聽並回傳解除綁定函式（瀏覽器中為 bindIdleActivity(timer, window, document)） */
  bindActivity: () => () => void;
  now?: () => number;
}

export interface ImportFileSource {
  name: string;
  text(): Promise<string>;
}

export interface AuthController {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  boot(): Promise<void>;
  submitSetup(password: string, confirmation: string): Promise<void>;
  submitLogin(password: string): Promise<void>;
  submitSecondFactor(code: string): Promise<void>;
  switchSecondFactorMethod(method: SecondFactorMethod): void;
  /** 第二因素畫面「返回登入」：清除暫存金鑰 */
  cancelSecondFactor(): void;
  /** §5.1.4 手動登出 */
  logout(): void;
  /** §5.1.4 閒置逾時（由 idleTimer 的 onTimeout 呼叫） */
  handleIdleTimeout(): void;
  beginImport(): void;
  submitImportConfirmation(confirmation: string): Promise<void>;
  selectImportFile(file: ImportFileSource): Promise<void>;
  submitImport(password: string): Promise<void>;
  cancelImport(): void;
}

function describeError(error: unknown): string {
  if (error instanceof ImportError) return importErrorMessage(error.code);
  if (error instanceof StorageError) return storageErrorMessage(error.code);
  return MESSAGES.unexpected;
}

export function createAuthController(deps: AuthControllerDeps): AuthController {
  const { storage, idleTimer, bindActivity } = deps;
  const now = deps.now ?? (() => Date.now());

  let state: AuthState = initialAuthState;
  const listeners = new Set<() => void>();
  let booting = false;
  let unbindActivity: (() => void) | null = null;
  let importTicket: PreLoginImportTicket | null = null;
  let importFileContent: string | null = null;

  function dispatch(event: AuthEvent): void {
    const next = reduceAuth(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  /** §5.1.4：主密碼通過當下（含等待第二因素，記憶體中已有金鑰）即開始計時並綁定活動監聽；不重複綁定 */
  function startIdleTracking(): void {
    idleTimer.start();
    if (unbindActivity === null) unbindActivity = bindActivity();
  }

  function stopIdleTracking(): void {
    idleTimer.stop();
    unbindActivity?.();
    unbindActivity = null;
  }

  /** 清除記憶體中的金鑰（含等待第二因素的暫存金鑰），停止閒置計時、解除綁定並回到登入 */
  function endSession(notice: string | null): void {
    storage.logout();
    stopIdleTracking();
    dispatch({ type: "RETURNED_TO_LOGIN", notice });
  }

  function clearImport(): void {
    importTicket = null;
    importFileContent = null;
  }

  function isLocked(lockedUntil: number | null): boolean {
    return lockedUntil !== null && lockedUntil > now();
  }

  function lockedUntilAfter(waitSeconds: number): number {
    return now() + waitSeconds * 1000;
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async boot() {
      if (state.phase !== "booting" || booting) return;
      booting = true;
      try {
        dispatch({ type: "BOOTED", initialized: await storage.isInitialized() });
      } catch {
        dispatch({ type: "BOOT_FAILED", error: MESSAGES.bootFailed });
      } finally {
        booting = false;
      }
    },

    async submitSetup(password, confirmation) {
      if (state.phase !== "setup" || state.busy) return;
      if (password !== confirmation) {
        dispatch({ type: "FAILED", error: MESSAGES.setupMismatch });
        return;
      }
      try {
        assertValidMasterPassword(password);
      } catch {
        dispatch({ type: "FAILED", error: MESSAGES.setupTooShort });
        return;
      }

      dispatch({ type: "SUBMITTED" });
      try {
        await storage.initialize(password);
        dispatch({ type: "SETUP_COMPLETED", notice: MESSAGES.setupCompleted });
      } catch (error) {
        dispatch({ type: "FAILED", error: error instanceof RangeError ? MESSAGES.setupTooShort : MESSAGES.unexpected });
      }
    },

    async submitLogin(password) {
      if (state.phase !== "login" || state.busy || isLocked(state.lockedUntil)) return;
      dispatch({ type: "SUBMITTED" });

      let result: LoginResult;
      try {
        result = await storage.login(password);
      } catch {
        dispatch({ type: "FAILED", error: MESSAGES.unexpected });
        return;
      }

      if (result.ok) {
        startIdleTracking();
        dispatch({ type: "PASSWORD_VERIFIED", requiresSecondFactor: result.requiresSecondFactor });
      } else if (result.reason === "LOCKED") {
        dispatch({ type: "FAILED", error: null, lockedUntil: lockedUntilAfter(result.waitSeconds) });
      } else {
        dispatch({ type: "FAILED", error: MESSAGES.loginInvalid });
      }
    },

    async submitSecondFactor(code) {
      if (state.phase !== "secondFactor" || state.busy || isLocked(state.lockedUntil)) return;
      const input: SecondFactorInput =
        state.method === "totp" ? { totpCode: code.replace(/\s/g, "") } : { recoveryCode: code };
      dispatch({ type: "SUBMITTED" });

      let result: SecondFactorResult;
      try {
        result = await storage.verifySecondFactor(input);
      } catch (error) {
        if (
          error instanceof StorageError &&
          (error.code === "NOT_AUTHENTICATED" || error.code === "KEY_GENERATION_MISMATCH")
        ) {
          endSession(storageErrorMessage(error.code));
        } else {
          dispatch({ type: "FAILED", error: describeError(error) });
        }
        return;
      }

      if (result.ok) {
        dispatch({ type: "SECOND_FACTOR_VERIFIED" });
      } else if (result.reason === "LOCKED") {
        dispatch({ type: "FAILED", error: null, lockedUntil: lockedUntilAfter(result.waitSeconds) });
      } else {
        dispatch({
          type: "FAILED",
          error: result.reason === "INVALID_TOTP_CODE" ? MESSAGES.totpInvalid : MESSAGES.recoveryCodeInvalid,
        });
      }
    },

    switchSecondFactorMethod(method) {
      if (state.phase !== "secondFactor" || state.busy) return;
      dispatch({ type: "SECOND_FACTOR_METHOD_SELECTED", method });
    },

    cancelSecondFactor() {
      if (state.phase !== "secondFactor") return;
      endSession(null);
    },

    logout() {
      if (state.phase !== "authenticated") return;
      endSession(MESSAGES.loggedOut);
    },

    handleIdleTimeout() {
      if (state.phase !== "authenticated" && state.phase !== "secondFactor") return;
      endSession(MESSAGES.idleTimeout);
    },

    beginImport() {
      if (state.phase !== "login" || state.busy) return;
      clearImport();
      dispatch({ type: "IMPORT_REQUESTED" });
    },

    async submitImportConfirmation(confirmation) {
      if (state.phase !== "importConfirm" || state.busy) return;
      dispatch({ type: "SUBMITTED" });
      try {
        importTicket = await storage.startPreLoginImport({ confirmation });
        dispatch({ type: "IMPORT_CONFIRMED" });
      } catch (error) {
        dispatch({ type: "FAILED", error: describeError(error) });
      }
    },

    async selectImportFile(file) {
      if (state.phase !== "importFile" || state.busy) return;
      importFileContent = null;

      let content: string;
      try {
        content = await file.text();
        // §5.3 步驟 1：先檢查格式與版本，再要求輸入備份密碼
        parseExportFile(content);
      } catch (error) {
        dispatch({ type: "IMPORT_FILE_REJECTED", error: describeError(error) });
        return;
      }
      if (state.phase !== "importFile") return;
      importFileContent = content;
      dispatch({ type: "IMPORT_FILE_ACCEPTED", fileName: file.name });
    },

    async submitImport(password) {
      if (state.phase !== "importFile" || state.busy) return;
      const ticket = importTicket;
      const fileContent = importFileContent;
      if (ticket === null || fileContent === null) return;

      dispatch({ type: "SUBMITTED" });
      try {
        await storage.importVault({ fileContent, password, ticket });
      } catch (error) {
        if (error instanceof ImportError && error.code === "CONFIRMATION_REQUIRED") {
          clearImport();
          dispatch({ type: "IMPORT_PERMISSION_LOST", error: importErrorMessage(error.code) });
        } else {
          dispatch({ type: "FAILED", error: describeError(error) });
        }
        return;
      }

      // §5.3 步驟 7：storage 已清除 session；此處再確保閒置計時停止並回到登入
      clearImport();
      endSession(MESSAGES.importSucceeded);
    },

    cancelImport() {
      if ((state.phase !== "importConfirm" && state.phase !== "importFile") || state.busy) return;
      clearImport();
      dispatch({ type: "RETURNED_TO_LOGIN", notice: null });
    },
  };
}
