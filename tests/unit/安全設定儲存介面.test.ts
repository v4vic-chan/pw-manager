import "fake-indexeddb/auto";
import { describe, test, expect, vi } from "vitest";
import { generate } from "otplib";
import { createStorage, type VaultStorage } from "../../src/services/storage";
import { openVaultDB, readSecurityConfig } from "../../src/storage/db";
import type { TwoFactorSetup } from "../../src/services/twoFactor";

/**
 * 模組：安全設定畫面所需的兩個 Service Layer 新方法（使用者核准新增，不改動既有方法）
 * - getSecurityStatus()：唯讀、需已登入、只回傳 twoFactorEnabled 與未使用救援碼數，不含任何秘密。
 * - reverifyMasterPassword(password)：已登入狀態下重新驗證目前主密碼（變更主密碼前使用），
 *   沿用 §4.1 的 loginFailureState 鎖定與失敗計數；驗證成功歸零，不影響 session。
 * 對應規格 §4.1、§4.1.2、§4.2（剩餘救援碼 ≤ 2 組時提示補發）。
 */

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another long passphrase 2026";
const WRONG_PASSWORD = "definitely not the password";

async function setupUnlocked(): Promise<{ storage: VaultStorage; dbName: string }> {
  const dbName = `security-api-${crypto.randomUUID()}`;
  const storage = await createStorage({ dbName });
  await storage.initialize(PASSWORD);
  await storage.login(PASSWORD);
  return { storage, dbName };
}

async function enableTwoFactor(storage: VaultStorage): Promise<TwoFactorSetup> {
  const setup = await storage.beginTwoFactorSetup();
  const result = await storage.confirmTwoFactorSetup(await generate({ secret: setup.secret }), setup);
  expect(result.ok).toBe(true);
  return setup;
}

async function loginFailureState(dbName: string) {
  const db = await openVaultDB(dbName);
  try {
    return (await readSecurityConfig(db))?.loginFailureState;
  } finally {
    db.close();
  }
}

describe("getSecurityStatus（唯讀）", () => {
  test("未登入時以 NOT_AUTHENTICATED 拒絕", async () => {
    const storage = await createStorage({ dbName: `security-api-${crypto.randomUUID()}` });
    await storage.initialize(PASSWORD);
    await expect(storage.getSecurityStatus()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    storage.close();
  });

  test("2FA 關閉時為 { false, 0 }；只回傳兩個欄位", async () => {
    const { storage } = await setupUnlocked();
    const status = await storage.getSecurityStatus();
    expect(status).toEqual({ twoFactorEnabled: false, unusedRecoveryCodes: 0 });
    expect(Object.keys(status).sort()).toEqual(["twoFactorEnabled", "unusedRecoveryCodes"]);
    storage.close();
  });

  test("開啟後反映未使用救援碼數；以救援碼登入後減 1；補發後回到滿額；關閉後歸零；結果不含任何秘密", async () => {
    const { storage } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);
    const total = setup.recoveryCodesPlaintext.length;

    const enabled = await storage.getSecurityStatus();
    expect(enabled).toEqual({ twoFactorEnabled: true, unusedRecoveryCodes: total });
    const json = JSON.stringify(enabled);
    expect(json).not.toContain(setup.secret);
    for (const code of setup.recoveryCodesPlaintext) expect(json).not.toContain(code);

    storage.logout();
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: setup.recoveryCodesPlaintext[0] })).toEqual({ ok: true });
    expect(await storage.getSecurityStatus()).toEqual({ twoFactorEnabled: true, unusedRecoveryCodes: total - 1 });

    const regenerated = await storage.beginRecoveryCodesRegeneration(PASSWORD, await generate({ secret: setup.secret }));
    if (!regenerated.ok) throw new Error("補發驗證應通過");
    await storage.commitRecoveryCodes(regenerated.batch);
    expect(await storage.getSecurityStatus()).toEqual({ twoFactorEnabled: true, unusedRecoveryCodes: total });

    const disabled = await storage.disableTwoFactor(PASSWORD, { totpCode: await generate({ secret: setup.secret }) });
    expect(disabled).toEqual({ ok: true });
    expect(await storage.getSecurityStatus()).toEqual({ twoFactorEnabled: false, unusedRecoveryCodes: 0 });
    storage.close();
  });
});

describe("reverifyMasterPassword（變更主密碼前重新驗證）", () => {
  test("未登入時以 NOT_AUTHENTICATED 拒絕，且不計入失敗次數", async () => {
    const dbName = `security-api-${crypto.randomUUID()}`;
    const storage = await createStorage({ dbName });
    await storage.initialize(PASSWORD);
    await expect(storage.reverifyMasterPassword(WRONG_PASSWORD)).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    expect(await loginFailureState(dbName)).toEqual({ failedAttempts: 0, lockedUntil: null });
    storage.close();
  });

  test("正確密碼：ok 並將失敗計數歸零；錯誤密碼：INVALID_MASTER_PASSWORD、失敗計數持久化 +1；兩者皆不影響 session", async () => {
    const { storage, dbName } = await setupUnlocked();

    expect(await storage.reverifyMasterPassword(WRONG_PASSWORD)).toEqual({
      ok: false,
      reason: "INVALID_MASTER_PASSWORD",
    });
    expect(await loginFailureState(dbName)).toEqual({ failedAttempts: 1, lockedUntil: null });
    expect(storage.isUnlocked()).toBe(true);

    expect(await storage.reverifyMasterPassword(PASSWORD)).toEqual({ ok: true });
    expect(await loginFailureState(dbName)).toEqual({ failedAttempts: 0, lockedUntil: null });
    expect(storage.isUnlocked()).toBe(true);
    await expect(storage.loadEntries()).resolves.toEqual([]);
    storage.close();
  });

  test("沿用 §4.1 鎖定：連續第 6 次失敗起進入等待，等待期間連正確密碼也回傳 LOCKED；登入同樣受鎖定", async () => {
    const { storage } = await setupUnlocked();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(await storage.reverifyMasterPassword(WRONG_PASSWORD)).toMatchObject({ reason: "INVALID_MASTER_PASSWORD" });
    }

    const locked = await storage.reverifyMasterPassword(PASSWORD);
    expect(locked).toMatchObject({ ok: false, reason: "LOCKED" });
    if (locked.ok || locked.reason !== "LOCKED") throw new Error("預期 LOCKED");
    expect(locked.waitSeconds).toBeGreaterThan(0);
    expect(locked.waitSeconds).toBeLessThanOrEqual(2);
    expect(storage.isUnlocked()).toBe(true);

    storage.logout();
    expect(await storage.login(PASSWORD)).toMatchObject({ ok: false, reason: "LOCKED" });
    storage.close();
  });

  test("變更主密碼後：舊密碼驗證失敗、新密碼驗證通過", async () => {
    const { storage } = await setupUnlocked();
    await storage.changeMasterPassword(NEW_PASSWORD);
    expect(await storage.reverifyMasterPassword(PASSWORD)).toMatchObject({ ok: false, reason: "INVALID_MASTER_PASSWORD" });
    expect(await storage.reverifyMasterPassword(NEW_PASSWORD)).toEqual({ ok: true });
    storage.close();
  });
});
