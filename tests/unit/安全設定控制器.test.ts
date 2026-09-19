import { describe, test, expect, vi, afterEach } from "vitest";
import {
  createSecurityController,
  type DownloadFile,
  type SecurityStorage,
} from "../../src/ui/security/securityController";
import type { ReadySecurityState } from "../../src/ui/security/securityMachine";
import { SESSION_LOST_LOGOUT_MS } from "../../src/ui/entries/entriesController";
import { StorageError } from "../../src/services/storage";
import {
  ALL_SECRETS,
  CURRENT_PASSWORD,
  EXPORT_FILE,
  NEW_BATCH_CODES,
  NEW_PASSWORD,
  SETUP_CODES,
  SETUP_QR,
  SETUP_SECRET,
  VALID_RECOVERY_CODE,
  VALID_TOTP,
  createFakeSecurity,
} from "./_shared/securityFakes";
import { deferred } from "./_shared/entriesFakes";

/**
 * 模組：安全設定控制器（UI 層，以假 storage／假下載／固定時鐘注入）
 * 對應規格 §4.1.2、§4.1.1（rekey 期間的忙碌狀態）、§4.2、§5.3、§5.1.5。
 * 重點：每個操作的前置條件在控制器層強制（不只是停用按鈕）；寫入中不可重複送出；
 * 失敗時明確告知「未變更」；秘鑰與救援碼只在顯示期間存在於狀態，完成／放棄／關閉後清除；不使用 console。
 */

const NOW = Date.UTC(2026, 8, 19, 1, 2, 3);

async function setup(options: Parameters<typeof createFakeSecurity>[0] = {}) {
  const fake = createFakeSecurity(options);
  const download = vi.fn<(file: DownloadFile) => void>();
  const onSessionLost = vi.fn();
  const yieldToPaint = vi.fn(async () => undefined);
  const controller = createSecurityController({
    storage: fake.storage,
    download,
    onSessionLost,
    now: () => NOW,
    yieldToPaint,
  });
  await controller.load();
  return { ...fake, controller, download, onSessionLost, yieldToPaint };
}

function ready(controller: { getState(): unknown }): ReadySecurityState {
  const state = controller.getState() as ReadySecurityState;
  if (state.phase !== "ready") throw new Error(`預期 ready，實際為 ${state.phase}`);
  return state;
}

const op = (controller: { getState(): unknown }) => ready(controller).operation;

function stateHasSecrets(controller: { getState(): unknown }): boolean {
  const json = JSON.stringify(controller.getState());
  return ALL_SECRETS.some((secret) => json.includes(secret));
}

async function openEnableToVerify(controller: Awaited<ReturnType<typeof setup>>["controller"]) {
  await controller.openEnableTwoFactor();
  controller.goToEnableStep("codes");
  controller.setAcknowledged(true);
  controller.goToEnableStep("verify");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("載入狀態", () => {
  test("讀取 getSecurityStatus；失敗時顯示錯誤；session 失效時同樣排程自動登出", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true, unusedRecoveryCodes: 2 });
    expect(ready(controller).status).toEqual({ twoFactorEnabled: true, unusedRecoveryCodes: 2 });
    expect(storage.getSecurityStatus).toHaveBeenCalledTimes(1);

    const failing = await setup({ overrides: { getSecurityStatus: vi.fn(async () => Promise.reject(new Error("x"))) } });
    expect(failing.controller.getState()).toEqual({ phase: "error", error: "無法載入安全設定，請重新整理後再試" });

    vi.useFakeTimers();
    const lost = await setup({
      overrides: { getSecurityStatus: vi.fn(async () => Promise.reject(new StorageError("NOT_AUTHENTICATED", "x"))) },
    });
    expect(lost.controller.getState()).toEqual({ phase: "error", error: "驗證已逾時，請重新輸入主密碼（即將自動登出）" });
    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    expect(lost.onSessionLost).toHaveBeenCalledTimes(1);
  });
});

describe("變更主密碼（§4.1.2）", () => {
  const input = { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD };

  test("成功：先重新驗證目前主密碼，再以新密碼 rekey；兩段皆先讓畫面繪出處理中；完成後提示並維持登入", async () => {
    const { controller, storage, yieldToPaint, getPassword } = await setup();
    controller.openChangePassword();
    await controller.submitChangePassword(input);

    expect(storage.reverifyMasterPassword).toHaveBeenCalledWith(CURRENT_PASSWORD);
    expect(storage.changeMasterPassword).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(vi.mocked(storage.reverifyMasterPassword).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(storage.changeMasterPassword).mock.invocationCallOrder[0]
    );
    expect(yieldToPaint).toHaveBeenCalledTimes(2);
    expect(getPassword()).toBe(NEW_PASSWORD);
    expect(ready(controller)).toMatchObject({
      operation: null,
      notice: "主密碼已變更。先前匯出的備份檔仍需以舊主密碼還原，建議重新匯出備份。",
      sessionLost: false,
    });
    expect(stateHasSecrets(controller)).toBe(false);
  });

  test("處理中的兩個階段顯示不同進度文案；rekey 進行中重複送出與關閉皆無效，只呼叫一次", async () => {
    const gate = deferred<void>();
    const { controller, storage } = await setup({
      overrides: { changeMasterPassword: vi.fn(() => gate.promise) },
    });
    controller.openChangePassword();
    const first = controller.submitChangePassword(input);

    await vi.waitFor(() => expect(storage.changeMasterPassword).toHaveBeenCalled());
    expect(op(controller)).toMatchObject({
      busy: true,
      progress: "正在以新主密碼重新加密所有資料，請勿關閉或重新整理分頁…",
    });
    await controller.submitChangePassword(input);
    controller.closeOperation();
    expect(op(controller)).toMatchObject({ kind: "changePassword", busy: true });
    expect(storage.reverifyMasterPassword).toHaveBeenCalledTimes(1);
    expect(storage.changeMasterPassword).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;
    expect(op(controller)).toBeNull();
  });

  test("提交前驗證：目前密碼空白、新密碼 < 12、兩次不一致、與目前相同，皆不呼叫 storage", async () => {
    const { controller, storage } = await setup();
    controller.openChangePassword();
    const cases: [typeof input, string][] = [
      [{ ...input, currentPassword: "" }, "請輸入目前主密碼"],
      [{ ...input, newPassword: "short", confirmation: "short" }, "新主密碼至少需要 12 個字元"],
      [{ ...input, confirmation: `${NEW_PASSWORD}!` }, "兩次輸入的新主密碼不一致"],
      [{ currentPassword: CURRENT_PASSWORD, newPassword: CURRENT_PASSWORD, confirmation: CURRENT_PASSWORD }, "新主密碼不可與目前主密碼相同"],
    ];
    for (const [values, message] of cases) {
      await controller.submitChangePassword(values);
      expect(op(controller)?.error).toBe(message);
    }
    expect(storage.reverifyMasterPassword).not.toHaveBeenCalled();
    expect(storage.changeMasterPassword).not.toHaveBeenCalled();
  });

  test("目前主密碼錯誤：不呼叫 changeMasterPassword，明確告知未變更", async () => {
    const { controller, storage, getPassword } = await setup();
    controller.openChangePassword();
    await controller.submitChangePassword({ ...input, currentPassword: "wrong current password" });

    expect(storage.changeMasterPassword).not.toHaveBeenCalled();
    expect(op(controller)).toMatchObject({ busy: false, error: "主密碼未變更：目前主密碼錯誤" });
    expect(getPassword()).toBe(CURRENT_PASSWORD);
  });

  test("驗證被鎖定：記錄 lockedUntil；鎖定期間送出被控制器拒絕", async () => {
    const { controller, storage } = await setup({
      overrides: {
        reverifyMasterPassword: vi.fn<SecurityStorage["reverifyMasterPassword"]>(async () => ({
          ok: false,
          reason: "LOCKED",
          waitSeconds: 4,
        })),
      },
    });
    controller.openChangePassword();
    await controller.submitChangePassword(input);
    expect(op(controller)).toMatchObject({ error: null, lockedUntil: NOW + 4000 });

    await controller.submitChangePassword(input);
    expect(storage.reverifyMasterPassword).toHaveBeenCalledTimes(1);
  });

  test("rekey 失敗：一律明確告知主密碼未變更，不外洩內部訊息；REKEY_IN_PROGRESS 使用專屬文案", async () => {
    const cases: [unknown, string][] = [
      [new Error("IDB exploded internal-detail"), "主密碼未變更：操作失敗，未做任何變更，請重試"],
      [new RangeError("too short"), "主密碼未變更：新主密碼至少需要 12 個字元"],
      [new StorageError("REKEY_IN_PROGRESS", "x"), "主密碼未變更：系統正在更新加密金鑰，請稍後再試"],
    ];
    for (const [error, message] of cases) {
      const { controller } = await setup({
        overrides: { changeMasterPassword: vi.fn(async () => Promise.reject(error)) },
      });
      controller.openChangePassword();
      await controller.submitChangePassword(input);
      expect(op(controller)).toMatchObject({ busy: false, progress: null, error: message });
      expect(ready(controller).notice).toBeNull();
    }
  });

  test("KEY_GENERATION_MISMATCH：提示並於 SESSION_LOST_LOGOUT_MS 後自動登出；之後任何操作無效", async () => {
    vi.useFakeTimers();
    const { controller, onSessionLost, storage } = await setup({
      overrides: {
        changeMasterPassword: vi.fn(async () => Promise.reject(new StorageError("KEY_GENERATION_MISMATCH", "x"))),
      },
    });
    controller.openChangePassword();
    await controller.submitChangePassword(input);

    expect(op(controller)?.error).toBe("主密碼未變更：保險庫資料已在其他地方變更，請重新登入（即將自動登出）");
    expect(ready(controller).sessionLost).toBe(true);
    await controller.submitChangePassword(input);
    expect(storage.reverifyMasterPassword).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  test("沒有開啟變更主密碼表單時送出無效", async () => {
    const { controller, storage } = await setup();
    await controller.submitChangePassword(input);
    expect(storage.reverifyMasterPassword).not.toHaveBeenCalled();
  });
});

describe("開啟 2FA（§4.2；順序：QR → 保存救援碼 → 輸入驗證碼才寫入）", () => {
  test("開啟即產生秘鑰與救援碼並顯示；成功輸入驗證碼後寫入、更新狀態、秘密自狀態清除", async () => {
    const { controller, storage } = await setup();
    await controller.openEnableTwoFactor();
    expect(storage.beginTwoFactorSetup).toHaveBeenCalledTimes(1);
    expect(op(controller)).toMatchObject({
      kind: "enableTwoFactor",
      step: "scan",
      busy: false,
      setup: { secret: SETUP_SECRET, qrCodeDataUrl: SETUP_QR, recoveryCodes: SETUP_CODES },
    });

    controller.goToEnableStep("codes");
    controller.setAcknowledged(true);
    controller.goToEnableStep("verify");
    await controller.submitEnableTwoFactor(" 123 456 ");

    const [code, setupArg] = vi.mocked(storage.confirmTwoFactorSetup).mock.calls[0];
    expect(code).toBe(VALID_TOTP);
    expect(setupArg.secret).toBe(SETUP_SECRET);
    expect(ready(controller)).toMatchObject({
      operation: null,
      status: { twoFactorEnabled: true, unusedRecoveryCodes: 10 },
      notice: "已開啟兩步驟驗證。下次登入時需要輸入驗證碼。",
    });
    expect(stateHasSecrets(controller)).toBe(false);
  });

  test("未勾選「已保存救援碼」：控制器拒絕前進與送出，不呼叫 confirmTwoFactorSetup", async () => {
    const { controller, storage } = await setup();
    await controller.openEnableTwoFactor();
    controller.goToEnableStep("codes");
    controller.goToEnableStep("verify");
    expect(op(controller)).toMatchObject({ step: "codes" });

    await controller.submitEnableTwoFactor(VALID_TOTP);
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();
  });

  test("不在輸入驗證碼步驟時送出無效（即使已勾選）", async () => {
    const { controller, storage } = await setup();
    await controller.openEnableTwoFactor();
    controller.goToEnableStep("codes");
    controller.setAcknowledged(true);
    await controller.submitEnableTwoFactor(VALID_TOTP);
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();
  });

  test("驗證碼空白或錯誤：保留畫面與秘密，可重試；錯誤文案說明尚未開啟", async () => {
    const { controller, storage, isTwoFactorEnabled } = await setup();
    await openEnableToVerify(controller);

    await controller.submitEnableTwoFactor("  ");
    expect(op(controller)?.error).toBe("請輸入驗證碼");
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();

    await controller.submitEnableTwoFactor("000000");
    expect(op(controller)).toMatchObject({
      step: "verify",
      busy: false,
      error: "驗證碼錯誤，請確認驗證器 App 的時間正確、且已加入上方秘鑰後再試（兩步驟驗證尚未開啟）",
      setup: { secret: SETUP_SECRET },
    });
    expect(isTwoFactorEnabled()).toBe(false);

    await controller.submitEnableTwoFactor(VALID_TOTP);
    expect(isTwoFactorEnabled()).toBe(true);
  });

  test("寫入中重複送出只寫一次", async () => {
    const gate = deferred<Awaited<ReturnType<SecurityStorage["confirmTwoFactorSetup"]>>>();
    const { controller, storage } = await setup({ overrides: { confirmTwoFactorSetup: vi.fn(() => gate.promise) } });
    await openEnableToVerify(controller);
    const first = controller.submitEnableTwoFactor(VALID_TOTP);
    await controller.submitEnableTwoFactor(VALID_TOTP);
    controller.requestAbandon();
    expect(op(controller)).toMatchObject({ busy: true, confirmingAbandon: false });
    expect(storage.confirmTwoFactorSetup).toHaveBeenCalledTimes(1);

    gate.resolve({ ok: false, reason: "INVALID_TOTP_CODE" });
    await first;
  });

  test("放棄需二次確認；確認後不寫入、秘密清除，之後送出無效", async () => {
    const { controller, storage } = await setup();
    await openEnableToVerify(controller);

    controller.closeOperation();
    expect(op(controller)).toMatchObject({ kind: "enableTwoFactor" });

    controller.requestAbandon();
    controller.cancelAbandon();
    expect(op(controller)).toMatchObject({ kind: "enableTwoFactor", confirmingAbandon: false });

    controller.requestAbandon();
    controller.confirmAbandon();
    expect(ready(controller)).toMatchObject({ operation: null, notice: "已放棄開啟兩步驟驗證，未做任何變更。" });
    expect(stateHasSecrets(controller)).toBe(false);

    await controller.submitEnableTwoFactor(VALID_TOTP);
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();
  });

  test("已開啟 2FA 時不可進入開啟流程（避免覆蓋既有秘鑰）", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    await controller.openEnableTwoFactor();
    expect(op(controller)).toBeNull();
    expect(storage.beginTwoFactorSetup).not.toHaveBeenCalled();
  });

  test("產生秘鑰失敗：顯示錯誤，可直接關閉", async () => {
    const { controller } = await setup({
      overrides: { beginTwoFactorSetup: vi.fn(async () => Promise.reject(new StorageError("REKEY_IN_PROGRESS", "x"))) },
    });
    await controller.openEnableTwoFactor();
    expect(op(controller)).toMatchObject({ setup: null, busy: false, error: "系統正在更新加密金鑰，請稍後再試" });
    controller.closeOperation();
    expect(op(controller)).toBeNull();
  });

  test("下載救援碼：以 .txt 下載目前顯示的救援碼，不寫入剪貼簿", async () => {
    const { controller, download } = await setup();
    await controller.openEnableTwoFactor();
    controller.goToEnableStep("codes");
    controller.downloadRecoveryCodes();

    expect(download).toHaveBeenCalledTimes(1);
    const [file] = download.mock.calls[0];
    expect(file.fileName).toMatch(/^password-keeper-recovery-codes-\d{8}-\d{6}\.txt$/);
    expect(file.mimeType).toBe("text/plain;charset=utf-8");
    for (const code of SETUP_CODES) expect(file.content).toContain(code);
    expect(file.content).not.toContain(SETUP_SECRET);
  });
});

describe("關閉 2FA（§4.2、AC7：主密碼 + TOTP 或救援碼）", () => {
  test("以 TOTP 關閉成功：更新狀態並提示", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    controller.openDisableTwoFactor();
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: "123 456" });

    expect(storage.disableTwoFactor).toHaveBeenCalledWith(CURRENT_PASSWORD, { totpCode: VALID_TOTP });
    expect(ready(controller)).toMatchObject({
      operation: null,
      status: { twoFactorEnabled: false, unusedRecoveryCodes: 0 },
      notice: "已關閉兩步驟驗證，登入僅靠主密碼保護。",
    });
  });

  test("切換為救援碼：以 recoveryCode 送出", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    controller.openDisableTwoFactor();
    controller.switchDisableMethod("recovery");
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: VALID_RECOVERY_CODE });
    expect(storage.disableTwoFactor).toHaveBeenCalledWith(CURRENT_PASSWORD, { recoveryCode: VALID_RECOVERY_CODE });
  });

  test("提交前驗證與各種失敗：皆保持開啟狀態", async () => {
    const { controller, storage, isTwoFactorEnabled } = await setup({ twoFactorEnabled: true });
    controller.openDisableTwoFactor();

    await controller.submitDisableTwoFactor({ password: "", code: VALID_TOTP });
    expect(op(controller)?.error).toBe("請輸入主密碼");
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: " " });
    expect(op(controller)?.error).toBe("請輸入驗證碼");
    expect(storage.disableTwoFactor).not.toHaveBeenCalled();

    await controller.submitDisableTwoFactor({ password: "wrong password here", code: VALID_TOTP });
    expect(op(controller)?.error).toBe("主密碼錯誤");
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: "000000" });
    expect(op(controller)?.error).toBe("驗證碼錯誤");
    controller.switchDisableMethod("recovery");
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: "" });
    expect(op(controller)?.error).toBe("請輸入救援碼");
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: "NOPE-NOPE" });
    expect(op(controller)?.error).toBe("救援碼無效或已使用過");
    expect(isTwoFactorEnabled()).toBe(true);
    expect(ready(controller).status.twoFactorEnabled).toBe(true);
  });

  test("LOCKED：記錄鎖定期限，期間送出無效", async () => {
    const { controller, storage } = await setup({
      twoFactorEnabled: true,
      overrides: {
        disableTwoFactor: vi.fn<SecurityStorage["disableTwoFactor"]>(async () => ({ ok: false, reason: "LOCKED", waitSeconds: 8 })),
      },
    });
    controller.openDisableTwoFactor();
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: VALID_TOTP });
    expect(op(controller)).toMatchObject({ lockedUntil: NOW + 8000, error: null });
    await controller.submitDisableTwoFactor({ password: CURRENT_PASSWORD, code: VALID_TOTP });
    expect(storage.disableTwoFactor).toHaveBeenCalledTimes(1);
  });

  test("2FA 未開啟時不可進入關閉流程", async () => {
    const { controller } = await setup();
    controller.openDisableTwoFactor();
    expect(op(controller)).toBeNull();
  });
});

describe("補發救援碼（§4.2 兩段式：begin 不寫入、commit 才取代）", () => {
  const verify = { password: CURRENT_PASSWORD, totpCode: "123456" };

  test("驗證 → 顯示新碼 → 勾選 → 確認取代：commit 以 begin 回傳的同一批次呼叫；完成後秘密清除", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true, unusedRecoveryCodes: 2 });
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification(verify);

    expect(storage.beginRecoveryCodesRegeneration).toHaveBeenCalledWith(CURRENT_PASSWORD, VALID_TOTP);
    expect(op(controller)).toMatchObject({ step: "codes", recoveryCodes: NEW_BATCH_CODES, acknowledged: false });
    expect(storage.commitRecoveryCodes).not.toHaveBeenCalled();

    controller.setAcknowledged(true);
    await controller.commitRecoveryCodes();
    const batch = await vi.mocked(storage.beginRecoveryCodesRegeneration).mock.results[0].value;
    expect(vi.mocked(storage.commitRecoveryCodes).mock.calls[0][0]).toBe(batch.batch);
    expect(ready(controller)).toMatchObject({
      operation: null,
      status: { twoFactorEnabled: true, unusedRecoveryCodes: 10 },
      notice: "已補發新救援碼，舊救援碼已全部失效。",
    });
    expect(stateHasSecrets(controller)).toBe(false);
  });

  test("未勾選已保存：控制器拒絕提交", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification(verify);
    await controller.commitRecoveryCodes();
    expect(storage.commitRecoveryCodes).not.toHaveBeenCalled();
  });

  test("驗證失敗（主密碼、TOTP、空白、鎖定）：不產生新碼", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification({ password: "", totpCode: VALID_TOTP });
    expect(op(controller)?.error).toBe("請輸入主密碼");
    await controller.submitRegenerateVerification({ password: CURRENT_PASSWORD, totpCode: "" });
    expect(op(controller)?.error).toBe("請輸入驗證碼");
    await controller.submitRegenerateVerification({ password: "wrong password here", totpCode: VALID_TOTP });
    expect(op(controller)).toMatchObject({ step: "verify", error: "主密碼錯誤", recoveryCodes: null });
    await controller.submitRegenerateVerification({ password: CURRENT_PASSWORD, totpCode: "000000" });
    expect(op(controller)?.error).toBe("驗證碼錯誤");
    expect(storage.commitRecoveryCodes).not.toHaveBeenCalled();

    const locked = await setup({
      twoFactorEnabled: true,
      overrides: {
        beginRecoveryCodesRegeneration: vi.fn<SecurityStorage["beginRecoveryCodesRegeneration"]>(async () => ({
          ok: false,
          reason: "LOCKED",
          waitSeconds: 16,
        })),
      },
    });
    locked.controller.openRegenerateRecoveryCodes();
    await locked.controller.submitRegenerateVerification(verify);
    expect(op(locked.controller)?.lockedUntil).toBe(NOW + 16_000);
  });

  test("提交失敗：告知新碼未生效、舊碼仍有效；新碼與勾選保留，可重試", async () => {
    const commit = vi
      .fn<SecurityStorage["commitRecoveryCodes"]>()
      .mockRejectedValueOnce(new Error("tx failed"))
      .mockResolvedValueOnce(undefined);
    const { controller } = await setup({ twoFactorEnabled: true, overrides: { commitRecoveryCodes: commit } });
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification(verify);
    controller.setAcknowledged(true);
    await controller.commitRecoveryCodes();

    expect(op(controller)).toMatchObject({
      step: "codes",
      acknowledged: true,
      recoveryCodes: NEW_BATCH_CODES,
      error: "操作失敗，未做任何變更，請重試（新救援碼未生效，舊救援碼仍然有效）",
    });
    await controller.commitRecoveryCodes();
    expect(op(controller)).toBeNull();
  });

  test("放棄：二次確認後不提交，提示舊碼仍有效；之後提交無效", async () => {
    const { controller, storage } = await setup({ twoFactorEnabled: true });
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification(verify);
    controller.setAcknowledged(true);

    controller.closeOperation();
    expect(op(controller)).toMatchObject({ kind: "regenerateRecoveryCodes" });
    controller.requestAbandon();
    controller.confirmAbandon();
    expect(ready(controller)).toMatchObject({ operation: null, notice: "已放棄補發，舊救援碼仍然有效。" });
    expect(stateHasSecrets(controller)).toBe(false);

    await controller.commitRecoveryCodes();
    expect(storage.commitRecoveryCodes).not.toHaveBeenCalled();
  });

  test("2FA 未開啟時不可進入補發流程", async () => {
    const { controller } = await setup();
    controller.openRegenerateRecoveryCodes();
    expect(op(controller)).toBeNull();
  });
});

describe("匯出（§5.3）", () => {
  test("下載 exportVault 回傳的加密檔（JSON），檔名含時間戳；完成後提示檔名", async () => {
    const { controller, download } = await setup();
    controller.openExport();
    await controller.submitExport();

    const [file] = download.mock.calls[0];
    expect(file.fileName).toMatch(/^password-keeper-backup-\d{8}-\d{6}\.json$/);
    expect(file.mimeType).toBe("application/json");
    expect(JSON.parse(file.content)).toEqual(EXPORT_FILE);
    expect(ready(controller)).toMatchObject({ operation: null, notice: `已下載加密備份檔：${file.fileName}` });
  });

  test("KEY_GENERATION_MISMATCH：不下載，提示重新登入並自動登出", async () => {
    vi.useFakeTimers();
    const { controller, download, onSessionLost } = await setup({
      overrides: { exportVault: vi.fn(async () => Promise.reject(new StorageError("KEY_GENERATION_MISMATCH", "x"))) },
    });
    controller.openExport();
    await controller.submitExport();

    expect(download).not.toHaveBeenCalled();
    expect(op(controller)?.error).toBe("保險庫資料已在其他地方變更，請重新登入（即將自動登出）");
    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  test("其他失敗：通用文案、不下載；下載本身失敗也回報", async () => {
    const failing = await setup({ overrides: { exportVault: vi.fn(async () => Promise.reject(new Error("x"))) } });
    failing.controller.openExport();
    await failing.controller.submitExport();
    expect(op(failing.controller)?.error).toBe("操作失敗，未做任何變更，請重試");

    const broken = await setup();
    broken.download.mockImplementation(() => {
      throw new Error("no blob support");
    });
    broken.controller.openExport();
    await broken.controller.submitExport();
    expect(op(broken.controller)?.error).toBe("無法下載檔案，請確認瀏覽器允許下載後重試");
  });
});

describe("dispose 與敏感資料", () => {
  test("顯示秘密時 dispose：狀態進入 closed、秘密捨棄；之後所有操作無效", async () => {
    const { controller, storage } = await setup();
    await openEnableToVerify(controller);
    controller.dispose();
    expect(controller.getState()).toEqual({ phase: "closed" });

    await controller.submitEnableTwoFactor(VALID_TOTP);
    controller.openChangePassword();
    await controller.submitChangePassword({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();
    expect(storage.reverifyMasterPassword).not.toHaveBeenCalled();
  });

  test("寫入進行中 dispose：晚到的結果不寫入狀態；自動登出計時器被取消", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const { controller, onSessionLost } = await setup({ overrides: { changeMasterPassword: vi.fn(() => gate.promise) } });
    controller.openChangePassword();
    const pending = controller.submitChangePassword({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    await vi.waitFor(() => expect(op(controller)?.progress).toContain("重新加密"));
    controller.dispose();
    gate.reject(new StorageError("NOT_AUTHENTICATED", "x"));
    await pending;
    expect(controller.getState()).toEqual({ phase: "closed" });
    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS * 2);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  test("整段流程 console 不含任何密碼、秘鑰或救援碼", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const { controller } = await setup();
    controller.openChangePassword();
    await controller.submitChangePassword({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    await openEnableToVerify(controller);
    controller.downloadRecoveryCodes();
    await controller.submitEnableTwoFactor(VALID_TOTP);
    controller.openRegenerateRecoveryCodes();
    await controller.submitRegenerateVerification({ password: NEW_PASSWORD, totpCode: VALID_TOTP });
    controller.setAcknowledged(true);
    await controller.commitRecoveryCodes();
    controller.openExport();
    await controller.submitExport();
    controller.dispose();

    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const secret of ALL_SECRETS) expect(output).not.toContain(secret);
  });
});
