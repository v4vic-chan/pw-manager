/**
 * 登入／解鎖流程狀態機（純 reducer，不含副作用）。
 * 對應規格 §4.1 首次設定與登入、§4.2 第二因素、§5.1.4 登出與閒置逾時、§5.3 登入頁匯入。
 * 不適用於目前畫面的事件一律忽略並回傳原狀態，避免非同步結果晚到時覆寫已切換的畫面。
 */

export type SecondFactorMethod = "totp" | "recovery";

export type AuthState =
  | { phase: "booting" }
  | { phase: "fatal"; error: string }
  | { phase: "setup"; busy: boolean; error: string | null }
  | { phase: "login"; busy: boolean; error: string | null; notice: string | null; lockedUntil: number | null }
  | {
      phase: "secondFactor";
      method: SecondFactorMethod;
      busy: boolean;
      error: string | null;
      /** 兩種第二因素共用 totpFailureState，切換方式時保留 */
      lockedUntil: number | null;
    }
  | { phase: "importConfirm"; busy: boolean; error: string | null }
  | { phase: "importFile"; busy: boolean; error: string | null; fileName: string | null }
  | { phase: "authenticated" };

export type AuthEvent =
  | { type: "BOOTED"; initialized: boolean }
  | { type: "BOOT_FAILED"; error: string }
  | { type: "SUBMITTED" }
  | { type: "FAILED"; error: string | null; lockedUntil?: number | null }
  | { type: "SETUP_COMPLETED"; notice: string }
  | { type: "PASSWORD_VERIFIED"; requiresSecondFactor: boolean }
  | { type: "SECOND_FACTOR_METHOD_SELECTED"; method: SecondFactorMethod }
  | { type: "SECOND_FACTOR_VERIFIED" }
  | { type: "IMPORT_REQUESTED" }
  | { type: "IMPORT_CONFIRMED" }
  | { type: "IMPORT_FILE_ACCEPTED"; fileName: string }
  | { type: "IMPORT_FILE_REJECTED"; error: string }
  | { type: "IMPORT_PERMISSION_LOST"; error: string }
  | { type: "RETURNED_TO_LOGIN"; notice: string | null };

export const initialAuthState: AuthState = { phase: "booting" };

function loginState(notice: string | null = null): AuthState {
  return { phase: "login", busy: false, error: null, notice, lockedUntil: null };
}

export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  if (event.type === "RETURNED_TO_LOGIN") {
    if (state.phase === "booting" || state.phase === "fatal" || state.phase === "setup") return state;
    return loginState(event.notice);
  }

  switch (state.phase) {
    case "booting":
      if (event.type === "BOOTED") {
        return event.initialized ? loginState() : { phase: "setup", busy: false, error: null };
      }
      if (event.type === "BOOT_FAILED") return { phase: "fatal", error: event.error };
      return state;

    case "setup":
      if (event.type === "SUBMITTED") return { ...state, busy: true, error: null };
      if (event.type === "FAILED") return { ...state, busy: false, error: event.error };
      if (event.type === "SETUP_COMPLETED") return loginState(event.notice);
      return state;

    case "login":
      switch (event.type) {
        case "SUBMITTED":
          return { ...state, busy: true, error: null, notice: null, lockedUntil: null };
        case "FAILED":
          return { ...state, busy: false, error: event.error, lockedUntil: event.lockedUntil ?? null };
        case "PASSWORD_VERIFIED":
          return event.requiresSecondFactor
            ? { phase: "secondFactor", method: "totp", busy: false, error: null, lockedUntil: null }
            : { phase: "authenticated" };
        case "IMPORT_REQUESTED":
          return { phase: "importConfirm", busy: false, error: null };
        default:
          return state;
      }

    case "secondFactor":
      switch (event.type) {
        case "SUBMITTED":
          return { ...state, busy: true, error: null, lockedUntil: null };
        case "FAILED":
          return { ...state, busy: false, error: event.error, lockedUntil: event.lockedUntil ?? null };
        case "SECOND_FACTOR_METHOD_SELECTED":
          return { ...state, method: event.method, error: null };
        case "SECOND_FACTOR_VERIFIED":
          return { phase: "authenticated" };
        default:
          return state;
      }

    case "importConfirm":
      switch (event.type) {
        case "SUBMITTED":
          return { ...state, busy: true, error: null };
        case "FAILED":
          return { ...state, busy: false, error: event.error };
        case "IMPORT_CONFIRMED":
          return { phase: "importFile", busy: false, error: null, fileName: null };
        default:
          return state;
      }

    case "importFile":
      switch (event.type) {
        case "SUBMITTED":
          return { ...state, busy: true, error: null };
        case "FAILED":
          return { ...state, busy: false, error: event.error };
        case "IMPORT_FILE_ACCEPTED":
          return { ...state, error: null, fileName: event.fileName };
        case "IMPORT_FILE_REJECTED":
          return { ...state, error: event.error, fileName: null };
        case "IMPORT_PERMISSION_LOST":
          return { phase: "importConfirm", busy: false, error: event.error };
        default:
          return state;
      }

    case "fatal":
    case "authenticated":
      return state;
  }
}
