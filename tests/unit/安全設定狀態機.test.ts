import { describe, test, expect } from "vitest";
import {
  initialSecurityState,
  reduceSecurity,
  selectNavigationLocked,
  selectWriteInProgress,
  type ReadySecurityState,
  type SecurityEvent,
  type SecurityState,
} from "../../src/ui/security/securityMachine";

/**
 * 模組：安全設定狀態機（純 reducer）
 * 對應規格 §4.1.2 變更主密碼、§4.2 2FA 開啟／關閉／救援碼補發、§5.3 匯出。
 * 重點：同時只能進行一項操作；寫入中不可關閉；秘鑰／救援碼顯示中只能經「放棄 → 再確認」離開；
 * 開啟 2FA 未勾選「已保存救援碼」不可前進到輸入驗證碼；完成或放棄後秘密自狀態移除。
 */

const SETUP = { secret: "SECRET-XYZ", qrCodeDataUrl: "data:image/png;base64,QQ==", recoveryCodes: ["CODE-1", "CODE-2"] };

function ready(twoFactorEnabled = false): ReadySecurityState {
  const state = reduceSecurity(initialSecurityState, {
    type: "LOADED",
    status: { twoFactorEnabled, unusedRecoveryCodes: twoFactorEnabled ? 10 : 0 },
  });
  if (state.phase !== "ready") throw new Error("應為 ready");
  return state;
}

function apply(state: SecurityState, ...events: SecurityEvent[]): ReadySecurityState {
  const next = events.reduce(reduceSecurity, state);
  if (next.phase !== "ready") throw new Error(`預期 ready，實際為 ${next.phase}`);
  return next;
}

const enableWithSetup = () =>
  apply(ready(false), { type: "OPENED", kind: "enableTwoFactor" }, { type: "TWO_FACTOR_SETUP_READY", setup: SETUP });

const regenerateWithCodes = () =>
  apply(
    ready(true),
    { type: "OPENED", kind: "regenerateRecoveryCodes" },
    { type: "SUBMITTING", progress: null },
    { type: "RECOVERY_CODES_READY", recoveryCodes: ["NEW-1", "NEW-2"] }
  );

describe("載入", () => {
  test("loading → ready（無操作、無提示）；載入失敗 → error；ready 後晚到的 LOADED 忽略", () => {
    expect(initialSecurityState).toEqual({ phase: "loading" });
    expect(ready()).toEqual({
      phase: "ready",
      status: { twoFactorEnabled: false, unusedRecoveryCodes: 0 },
      operation: null,
      notice: null,
      sessionLost: false,
    });
    expect(reduceSecurity(initialSecurityState, { type: "LOAD_FAILED", error: "x" })).toEqual({ phase: "error", error: "x" });
    const state = ready();
    expect(reduceSecurity(state, { type: "LOADED", status: { twoFactorEnabled: true, unusedRecoveryCodes: 1 } })).toBe(state);
  });
});

describe("開啟操作", () => {
  test("依 2FA 狀態限制：未開啟時只能開啟 2FA；已開啟時只能關閉或補發", () => {
    const off = ready(false);
    expect(reduceSecurity(off, { type: "OPENED", kind: "disableTwoFactor" })).toBe(off);
    expect(reduceSecurity(off, { type: "OPENED", kind: "regenerateRecoveryCodes" })).toBe(off);
    expect(apply(off, { type: "OPENED", kind: "enableTwoFactor" }).operation).toMatchObject({
      kind: "enableTwoFactor",
      step: "scan",
      setup: null,
      acknowledged: false,
    });

    const on = ready(true);
    expect(reduceSecurity(on, { type: "OPENED", kind: "enableTwoFactor" })).toBe(on);
    expect(apply(on, { type: "OPENED", kind: "disableTwoFactor" }).operation).toMatchObject({
      kind: "disableTwoFactor",
      method: "totp",
    });
    expect(apply(on, { type: "OPENED", kind: "regenerateRecoveryCodes" }).operation).toMatchObject({
      kind: "regenerateRecoveryCodes",
      step: "verify",
      recoveryCodes: null,
    });
  });

  test("同時只能有一項操作；開啟新操作時清除舊提示", () => {
    const withNotice = { ...ready(), notice: "舊提示" };
    const opened = apply(withNotice, { type: "OPENED", kind: "changePassword" });
    expect(opened.notice).toBeNull();
    expect(opened.operation).toEqual({ kind: "changePassword", busy: false, progress: null, error: null, lockedUntil: null });
    expect(reduceSecurity(opened, { type: "OPENED", kind: "export" })).toBe(opened);
  });
});

describe("關閉與寫入中保護", () => {
  test("一般操作可關閉；寫入中（busy）不可關閉", () => {
    const opened = apply(ready(), { type: "OPENED", kind: "changePassword" });
    expect(apply(opened, { type: "OPERATION_CLOSED" }).operation).toBeNull();

    const busy = apply(opened, { type: "SUBMITTING", progress: "處理中" });
    expect(busy.operation).toMatchObject({ busy: true, progress: "處理中", error: null });
    expect(reduceSecurity(busy, { type: "OPERATION_CLOSED" })).toBe(busy);
    expect(apply(busy, { type: "PROGRESS_CHANGED", progress: "第二階段" }).operation?.progress).toBe("第二階段");

    const failed = apply(busy, { type: "FAILED", error: "壞了", lockedUntil: 123 });
    expect(failed.operation).toMatchObject({ busy: false, progress: null, error: "壞了", lockedUntil: 123 });
  });

  test("秘鑰／救援碼顯示中不可直接關閉，只能放棄並再次確認", () => {
    for (const state of [enableWithSetup(), regenerateWithCodes()]) {
      expect(reduceSecurity(state, { type: "OPERATION_CLOSED" })).toBe(state);
      expect(reduceSecurity(state, { type: "ABANDON_CONFIRMED", notice: "x" })).toBe(state);

      const asking = apply(state, { type: "ABANDON_REQUESTED" });
      expect(asking.operation).toMatchObject({ confirmingAbandon: true });
      expect(apply(asking, { type: "ABANDON_CANCELLED" }).operation).toMatchObject({ confirmingAbandon: false });

      const abandoned = apply(asking, { type: "ABANDON_CONFIRMED", notice: "已放棄" });
      expect(abandoned.operation).toBeNull();
      expect(abandoned.notice).toBe("已放棄");
    }
  });

  test("秘密尚未顯示前（開啟流程產生中失敗、補發驗證階段）可正常關閉", () => {
    const failedStart = apply(
      ready(false),
      { type: "OPENED", kind: "enableTwoFactor" },
      { type: "SUBMITTING", progress: null },
      { type: "FAILED", error: "x" }
    );
    expect(apply(failedStart, { type: "OPERATION_CLOSED" }).operation).toBeNull();
    const verifying = apply(ready(true), { type: "OPENED", kind: "regenerateRecoveryCodes" });
    expect(apply(verifying, { type: "OPERATION_CLOSED" }).operation).toBeNull();
    expect(reduceSecurity(verifying, { type: "ABANDON_REQUESTED" })).toBe(verifying);
  });

  test("寫入中不可要求放棄", () => {
    const busy = apply(enableWithSetup(), { type: "STEP_CHANGED", step: "codes" }, { type: "ACKNOWLEDGED_CHANGED", acknowledged: true }, { type: "STEP_CHANGED", step: "verify" }, { type: "SUBMITTING", progress: null });
    expect(reduceSecurity(busy, { type: "ABANDON_REQUESTED" })).toBe(busy);
  });
});

describe("開啟 2FA 步驟", () => {
  test("秘鑰就緒後進入掃描步驟；未勾選已保存救援碼不可前進到輸入驗證碼", () => {
    const scan = enableWithSetup();
    expect(scan.operation).toMatchObject({ step: "scan", setup: SETUP, busy: false });

    const codes = apply(scan, { type: "STEP_CHANGED", step: "codes" });
    expect(codes.operation).toMatchObject({ step: "codes" });
    expect(reduceSecurity(codes, { type: "STEP_CHANGED", step: "verify" })).toBe(codes);

    const acked = apply(codes, { type: "ACKNOWLEDGED_CHANGED", acknowledged: true });
    expect(apply(acked, { type: "STEP_CHANGED", step: "verify" }).operation).toMatchObject({ step: "verify" });
  });

  test("勾選只能在救援碼步驟變更；可回上一步查看 QR code，勾選狀態保留", () => {
    const scan = enableWithSetup();
    expect(reduceSecurity(scan, { type: "ACKNOWLEDGED_CHANGED", acknowledged: true })).toBe(scan);

    const verify = apply(
      scan,
      { type: "STEP_CHANGED", step: "codes" },
      { type: "ACKNOWLEDGED_CHANGED", acknowledged: true },
      { type: "STEP_CHANGED", step: "verify" }
    );
    expect(reduceSecurity(verify, { type: "ACKNOWLEDGED_CHANGED", acknowledged: false })).toBe(verify);
    expect(apply(verify, { type: "STEP_CHANGED", step: "scan" }).operation).toMatchObject({ step: "scan", acknowledged: true });
  });

  test("秘鑰尚未就緒時不可切換步驟", () => {
    const starting = apply(ready(false), { type: "OPENED", kind: "enableTwoFactor" });
    expect(reduceSecurity(starting, { type: "STEP_CHANGED", step: "codes" })).toBe(starting);
  });
});

describe("補發救援碼步驟", () => {
  test("驗證通過後顯示新碼，未勾選為預設；勾選可切換", () => {
    const codes = regenerateWithCodes();
    expect(codes.operation).toMatchObject({ step: "codes", recoveryCodes: ["NEW-1", "NEW-2"], acknowledged: false, busy: false });
    expect(apply(codes, { type: "ACKNOWLEDGED_CHANGED", acknowledged: true }).operation).toMatchObject({ acknowledged: true });
  });

  test("驗證階段不可勾選", () => {
    const verifying = apply(ready(true), { type: "OPENED", kind: "regenerateRecoveryCodes" });
    expect(reduceSecurity(verifying, { type: "ACKNOWLEDGED_CHANGED", acknowledged: true })).toBe(verifying);
  });
});

describe("關閉 2FA 的第二因素切換", () => {
  test("可在 TOTP 與救援碼之間切換並清除錯誤；寫入中不可切換", () => {
    const opened = apply(ready(true), { type: "OPENED", kind: "disableTwoFactor" }, { type: "FAILED", error: "x" });
    expect(apply(opened, { type: "METHOD_CHANGED", method: "recovery" }).operation).toMatchObject({
      method: "recovery",
      error: null,
    });
    const busy = apply(opened, { type: "SUBMITTING", progress: null });
    expect(reduceSecurity(busy, { type: "METHOD_CHANGED", method: "recovery" })).toBe(busy);
  });
});

describe("完成、提示與 session 失效", () => {
  test("完成後關閉操作、更新狀態並顯示提示；秘密不再存在於狀態中", () => {
    const done = apply(
      enableWithSetup(),
      { type: "COMPLETED", status: { twoFactorEnabled: true, unusedRecoveryCodes: 2 }, notice: "已開啟" }
    );
    expect(done).toMatchObject({ operation: null, notice: "已開啟", status: { twoFactorEnabled: true, unusedRecoveryCodes: 2 } });
    expect(JSON.stringify(done)).not.toContain("SECRET-XYZ");
    expect(JSON.stringify(done)).not.toContain("CODE-1");
    expect(apply(done, { type: "NOTICE_DISMISSED" }).notice).toBeNull();
  });

  test("session 失效：錯誤顯示在目前操作上並停止忙碌；之後不可開啟任何操作", () => {
    const busy = apply(ready(), { type: "OPENED", kind: "export" }, { type: "SUBMITTING", progress: null });
    const lost = apply(busy, { type: "SESSION_LOST", error: "請重新登入" });
    expect(lost.sessionLost).toBe(true);
    expect(lost.operation).toMatchObject({ busy: false, error: "請重新登入" });

    const closed = apply(lost, { type: "OPERATION_CLOSED" });
    expect(reduceSecurity(closed, { type: "OPENED", kind: "changePassword" })).toBe(closed);

    const idleLost = apply(ready(), { type: "SESSION_LOST", error: "請重新登入" });
    expect(idleLost).toMatchObject({ operation: null, notice: "請重新登入", sessionLost: true });
  });

  test("CLOSED 後進入 closed，秘密一併捨棄，之後所有事件忽略", () => {
    const closed = reduceSecurity(regenerateWithCodes(), { type: "CLOSED" });
    expect(closed).toEqual({ phase: "closed" });
    expect(reduceSecurity(closed, { type: "LOADED", status: { twoFactorEnabled: false, unusedRecoveryCodes: 0 } })).toBe(closed);
  });
});

describe("導覽鎖定與寫入進行中（供分頁切換、登出與 beforeunload 使用）", () => {
  test("寫入中與秘密顯示中鎖定導覽；只有寫入中才算寫入進行中；session 失效後解除鎖定", () => {
    const idle = ready();
    expect(selectNavigationLocked(idle)).toBe(false);
    expect(selectWriteInProgress(idle)).toBe(false);

    const form = apply(idle, { type: "OPENED", kind: "changePassword" });
    expect(selectNavigationLocked(form)).toBe(false);

    const busy = apply(form, { type: "SUBMITTING", progress: null });
    expect(selectNavigationLocked(busy)).toBe(true);
    expect(selectWriteInProgress(busy)).toBe(true);

    const secrets = enableWithSetup();
    expect(selectNavigationLocked(secrets)).toBe(true);
    expect(selectWriteInProgress(secrets)).toBe(false);

    expect(selectNavigationLocked(apply(secrets, { type: "SESSION_LOST", error: "x" }))).toBe(false);
    expect(selectNavigationLocked(initialSecurityState)).toBe(false);
  });
});
