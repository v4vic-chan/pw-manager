import { describe, test, expect } from "vitest";
import { initialAuthState, reduceAuth, type AuthState } from "../../src/ui/auth/authMachine";

/**
 * 模組：登入／解鎖流程狀態機（純 reducer，UI 層）
 * 對應規格 §4.1 首次設定與登入、§4.2 第二因素、§5.1.4 登出與閒置逾時、§5.3 登入頁匯入。
 */

type LoginState = Extract<AuthState, { phase: "login" }>;
type SecondFactorState = Extract<AuthState, { phase: "secondFactor" }>;

const login = (overrides: Partial<LoginState> = {}): LoginState => ({
  phase: "login",
  busy: false,
  error: null,
  notice: null,
  lockedUntil: null,
  ...overrides,
});

const secondFactor = (overrides: Partial<SecondFactorState> = {}): SecondFactorState => ({
  phase: "secondFactor",
  method: "totp",
  busy: false,
  error: null,
  lockedUntil: null,
  ...overrides,
});

describe("登入流程狀態機（reducer）", () => {
  test("啟動：依是否已初始化進入首次設定或登入；資料庫無法開啟時進入 fatal", () => {
    expect(initialAuthState).toEqual({ phase: "booting" });
    expect(reduceAuth(initialAuthState, { type: "BOOTED", initialized: false })).toEqual({
      phase: "setup",
      busy: false,
      error: null,
    });
    expect(reduceAuth(initialAuthState, { type: "BOOTED", initialized: true })).toEqual(login());
    expect(reduceAuth(initialAuthState, { type: "BOOT_FAILED", error: "db" })).toEqual({ phase: "fatal", error: "db" });
  });

  test("首次設定：送出中 → 失敗保留畫面並顯示錯誤 → 完成後進入登入並帶提示", () => {
    const setup: AuthState = { phase: "setup", busy: false, error: "old" };
    const busy = reduceAuth(setup, { type: "SUBMITTED" });
    expect(busy).toEqual({ phase: "setup", busy: true, error: null });
    expect(reduceAuth(busy, { type: "FAILED", error: "bad" })).toEqual({ phase: "setup", busy: false, error: "bad" });
    expect(reduceAuth(busy, { type: "SETUP_COMPLETED", notice: "done" })).toEqual(login({ notice: "done" }));
  });

  test("登入：主密碼通過後依是否需要第二因素進入 authenticated 或 secondFactor（預設 TOTP）", () => {
    const busy = reduceAuth(login(), { type: "SUBMITTED" });
    expect(reduceAuth(busy, { type: "PASSWORD_VERIFIED", requiresSecondFactor: false })).toEqual({
      phase: "authenticated",
    });
    expect(reduceAuth(busy, { type: "PASSWORD_VERIFIED", requiresSecondFactor: true })).toEqual(secondFactor());
  });

  test("登入失敗與鎖定：錯誤與鎖定期限分開記錄；再次送出時清除錯誤、提示與過期鎖定", () => {
    const failed = reduceAuth(login({ busy: true }), { type: "FAILED", error: "wrong" });
    expect(failed).toEqual(login({ error: "wrong" }));

    const locked = reduceAuth(login({ busy: true }), { type: "FAILED", error: null, lockedUntil: 5_000 });
    expect(locked).toEqual(login({ lockedUntil: 5_000 }));

    expect(reduceAuth(login({ error: "x", notice: "y", lockedUntil: 1 }), { type: "SUBMITTED" })).toEqual(
      login({ busy: true })
    );
  });

  test("第二因素：切換方式清除錯誤但保留鎖定期限（兩種方式共用 totpFailureState）；通過後進入 authenticated", () => {
    const state = secondFactor({ error: "wrong", lockedUntil: 9_000 });
    expect(reduceAuth(state, { type: "SECOND_FACTOR_METHOD_SELECTED", method: "recovery" })).toEqual(
      secondFactor({ method: "recovery", lockedUntil: 9_000 })
    );
    expect(reduceAuth(secondFactor({ busy: true }), { type: "FAILED", error: "bad", lockedUntil: null })).toEqual(
      secondFactor({ error: "bad" })
    );
    expect(reduceAuth(secondFactor({ busy: true }), { type: "SECOND_FACTOR_VERIFIED" })).toEqual({
      phase: "authenticated",
    });
  });

  test("匯入：登入 → 確認字串 → 選檔；檔案被拒時清除檔名；失去許可時回到確認步驟", () => {
    const confirm = reduceAuth(login({ error: "x" }), { type: "IMPORT_REQUESTED" });
    expect(confirm).toEqual({ phase: "importConfirm", busy: false, error: null });
    expect(reduceAuth(confirm, { type: "FAILED", error: "mismatch" })).toEqual({
      phase: "importConfirm",
      busy: false,
      error: "mismatch",
    });

    const file = reduceAuth(confirm, { type: "IMPORT_CONFIRMED" });
    expect(file).toEqual({ phase: "importFile", busy: false, error: null, fileName: null });

    const accepted = reduceAuth(file, { type: "IMPORT_FILE_ACCEPTED", fileName: "backup.json" });
    expect(accepted).toEqual({ phase: "importFile", busy: false, error: null, fileName: "backup.json" });
    expect(reduceAuth(accepted, { type: "IMPORT_FILE_REJECTED", error: "format" })).toEqual({
      phase: "importFile",
      busy: false,
      error: "format",
      fileName: null,
    });
    const submitting: AuthState = { phase: "importFile", busy: true, error: null, fileName: "backup.json" };
    expect(reduceAuth(submitting, { type: "FAILED", error: "decrypt" })).toEqual({
      phase: "importFile",
      busy: false,
      error: "decrypt",
      fileName: "backup.json",
    });
    expect(reduceAuth(accepted, { type: "IMPORT_PERMISSION_LOST", error: "expired" })).toEqual({
      phase: "importConfirm",
      busy: false,
      error: "expired",
    });
  });

  test("已解鎖、第二因素與匯入畫面皆可回到登入（登出、逾時、取消、匯入完成）", () => {
    const back = { type: "RETURNED_TO_LOGIN", notice: "bye" } as const;
    for (const state of [
      { phase: "authenticated" } as AuthState,
      secondFactor({ busy: true, error: "x" }),
      { phase: "importConfirm", busy: false, error: null } as AuthState,
      { phase: "importFile", busy: true, error: null, fileName: "f" } as AuthState,
      login({ error: "x" }),
    ]) {
      expect(reduceAuth(state, back)).toEqual(login({ notice: "bye" }));
    }
  });

  test("不適用於目前畫面的事件一律忽略，回傳原狀態", () => {
    const state = login();
    expect(reduceAuth(state, { type: "SECOND_FACTOR_VERIFIED" })).toBe(state);
    expect(reduceAuth(state, { type: "IMPORT_CONFIRMED" })).toBe(state);

    const authenticated: AuthState = { phase: "authenticated" };
    expect(reduceAuth(authenticated, { type: "SUBMITTED" })).toBe(authenticated);

    const setup: AuthState = { phase: "setup", busy: false, error: null };
    expect(reduceAuth(setup, { type: "RETURNED_TO_LOGIN", notice: null })).toBe(setup);
    expect(reduceAuth(initialAuthState, { type: "RETURNED_TO_LOGIN", notice: null })).toBe(initialAuthState);
  });
});
