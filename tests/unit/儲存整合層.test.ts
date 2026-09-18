import "fake-indexeddb/auto";
import { describe, test, expect, vi, afterEach } from "vitest";
import { generate } from "otplib";
import { createStorage, type VaultStorage } from "../../src/services/storage";
import {
  openVaultDB,
  readAllCategories,
  readAllEntries,
  readSecurityConfig,
  writeUnguarded,
} from "../../src/storage/db";
import { UNCATEGORIZED_CATEGORY_ID } from "../../src/services/category";
import type { TwoFactorSetup } from "../../src/services/twoFactor";

/**
 * 模組：儲存整合層（src/services/storage.ts 編排 + src/storage/db.ts IndexedDB 讀寫）
 * 對應規格 §2.3、§3.5、§4.1、§4.1.1、§4.2、§5.1.5；驗收標準 AC2、AC3、AC4、AC7、AC11、AC12、AC14、AC15。
 * 以 fake-indexeddb 提供真實 IndexedDB 交易語意；以注入 IDBObjectStore.put 失敗模擬交易中途寫入失敗。
 */

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another long passphrase 2026";
const WRONG_PASSWORD = "definitely not the password";
const ENTRY_PLAINTEXT_PASSWORD = "entry-plaintext-secret-9f3a";

const newDbName = () => `vault-test-${crypto.randomUUID()}`;

const entryInput = {
  appName: "Example Service",
  categoryId: UNCATEGORIZED_CATEGORY_ID,
  accountId: "user@example.com",
  password: ENTRY_PLAINTEXT_PASSWORD,
};

async function setupUnlocked(): Promise<{ storage: VaultStorage; dbName: string }> {
  const dbName = newDbName();
  const storage = await createStorage({ dbName });
  await storage.initialize(PASSWORD);
  expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
  return { storage, dbName };
}

async function rawDump(dbName: string) {
  const db = await openVaultDB(dbName);
  try {
    return {
      securityConfig: await readSecurityConfig(db),
      entries: await readAllEntries(db),
      categories: await readAllCategories(db),
    };
  } finally {
    db.close();
  }
}

async function enableTwoFactor(storage: VaultStorage): Promise<TwoFactorSetup> {
  const setup = await storage.beginTwoFactorSetup();
  const result = await storage.confirmTwoFactorSetup(await generate({ secret: setup.secret }), setup);
  expect(result.ok).toBe(true);
  return setup;
}

/** 讓第 n 次（1 起算）IDBObjectStore.put 同步拋錯，模擬交易中途寫入失敗 */
function failNthPut(n: number) {
  const original = IDBObjectStore.prototype.put;
  let calls = 0;
  return vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      calls += 1;
      if (calls === n) throw new DOMException("injected write failure", "UnknownError");
      return original.apply(this, args);
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("初始化與登入（§3.5、§4.1）", () => {
  test("initialize 於單一交易建立 SecurityConfig 與「未分類」；已初始化時再次呼叫應失敗", async () => {
    const dbName = newDbName();
    const storage = await createStorage({ dbName });
    await storage.initialize(PASSWORD);

    const raw = await rawDump(dbName);
    expect(raw.securityConfig?.keyGeneration).toBe(1);
    expect(raw.categories).toEqual([
      expect.objectContaining({
        id: UNCATEGORIZED_CATEGORY_ID,
        name: "未分類",
        sortIndex: -1,
        isSystemDefault: true,
      }),
    ]);

    await expect(storage.initialize(PASSWORD)).rejects.toThrow();
    storage.close();
  });

  test("未登入時需要金鑰的讀寫 API 一律以 NOT_AUTHENTICATED 拒絕", async () => {
    const storage = await createStorage({ dbName: newDbName() });
    await storage.initialize(PASSWORD);

    await expect(storage.loadEntries()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    await expect(storage.addEntry(entryInput, [])).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    storage.close();
  });

  test("主密碼錯誤拒絕登入且 loginFailureState 持久化 +1；成功登入後歸零（AC6）", async () => {
    const dbName = newDbName();
    const storage = await createStorage({ dbName });
    await storage.initialize(PASSWORD);

    expect(await storage.login(WRONG_PASSWORD)).toEqual({ ok: false, reason: "INVALID_MASTER_PASSWORD" });
    expect(storage.isUnlocked()).toBe(false);
    expect((await rawDump(dbName)).securityConfig?.loginFailureState.failedAttempts).toBe(1);

    expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
    expect((await rawDump(dbName)).securityConfig?.loginFailureState.failedAttempts).toBe(0);
    storage.close();
  });
});

describe("條目與分類寫入（§2.3、§4.3、§4.4）", () => {
  test("AC3：新增條目後 IndexedDB 只存密文，loadEntries 以 session 金鑰解密還原", async () => {
    const { storage, dbName } = await setupUnlocked();
    await storage.addEntry(entryInput, await storage.loadCategories());

    const raw = await rawDump(dbName);
    expect(raw.entries).toHaveLength(1);
    expect(typeof raw.entries[0].password).toBe("object");
    expect(JSON.stringify(raw)).not.toContain(ENTRY_PLAINTEXT_PASSWORD);

    const [loaded] = await storage.loadEntries();
    expect(loaded.password).toBe(ENTRY_PLAINTEXT_PASSWORD);
    expect(loaded.appName).toBe(entryInput.appName);
    storage.close();
  });

  test("編輯條目持久化；刪除未確認不落地，確認後硬刪除", async () => {
    const { storage, dbName } = await setupUnlocked();
    const categories = await storage.loadCategories();
    const created = await storage.addEntry(entryInput, categories);

    await storage.editEntry(created, { appName: "Renamed Service" }, categories);
    const [edited] = await storage.loadEntries();
    expect(edited.appName).toBe("Renamed Service");
    expect(edited.password).toBe(ENTRY_PLAINTEXT_PASSWORD);

    await storage.removeEntry([edited], edited.id, false);
    expect((await rawDump(dbName)).entries).toHaveLength(1);

    await storage.removeEntry([edited], edited.id, true);
    expect((await rawDump(dbName)).entries).toHaveLength(0);
    storage.close();
  });

  test("AC4：刪除分類與條目轉移「未分類」於同一交易完成，且不更新 updatedAt", async () => {
    const { storage, dbName } = await setupUnlocked();
    const work = await storage.addCategory("Work", await storage.loadCategories());
    const categories = await storage.loadCategories();
    const entry = await storage.addEntry({ ...entryInput, categoryId: work.id }, categories);

    await storage.removeCategory(work.id, categories, await storage.loadEntries());

    const raw = await rawDump(dbName);
    expect(raw.categories.some((c) => c.id === work.id)).toBe(false);
    expect(raw.entries[0].categoryId).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(raw.entries[0].updatedAt).toBe(entry.updatedAt);
    storage.close();
  });

  test("規則 4：刪除分類的交易中途寫入失敗時，分類與條目皆維持原狀（不得分成兩次交易）", async () => {
    const { storage, dbName } = await setupUnlocked();
    const work = await storage.addCategory("Work", await storage.loadCategories());
    const categories = await storage.loadCategories();
    await storage.addEntry({ ...entryInput, categoryId: work.id }, categories);
    const entries = await storage.loadEntries();

    // 分類刪除（delete）先發出，條目轉移（put）失敗 → 整筆交易須回滾
    failNthPut(1);
    await expect(storage.removeCategory(work.id, categories, entries)).rejects.toThrow("injected write failure");
    vi.restoreAllMocks();

    const raw = await rawDump(dbName);
    expect(raw.categories.some((c) => c.id === work.id)).toBe(true);
    expect(raw.entries[0].categoryId).toBe(work.id);
    storage.close();
  });
});

describe("§5.1.5 金鑰世代檢查與 §4.1.1 寫入鎖定", () => {
  test("AC15：keyGeneration 與 session 快照不符時寫入被拒（KEY_GENERATION_MISMATCH）、無資料落地、session 清除", async () => {
    const { storage, dbName } = await setupUnlocked();
    const categories = await storage.loadCategories();

    const db = await openVaultDB(dbName);
    await writeUnguarded(db, { updateSecurityConfig: (c) => ({ ...c, keyGeneration: c.keyGeneration + 1 }) });
    db.close();

    await expect(storage.addEntry(entryInput, categories)).rejects.toMatchObject({
      code: "KEY_GENERATION_MISMATCH",
    });
    expect((await rawDump(dbName)).entries).toHaveLength(0);
    expect(storage.isUnlocked()).toBe(false);
    await expect(storage.loadEntries()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    storage.close();
  });

  test("AC14：重新金鑰化期間寫入 API 立即以 REKEY_IN_PROGRESS 拒絕，且無資料變動", async () => {
    const { storage, dbName } = await setupUnlocked();
    const categories = await storage.loadCategories();

    const rekeying = storage.changeMasterPassword(NEW_PASSWORD);
    await expect(storage.addEntry(entryInput, categories)).rejects.toMatchObject({ code: "REKEY_IN_PROGRESS" });
    await expect(storage.addCategory("Work", categories)).rejects.toMatchObject({ code: "REKEY_IN_PROGRESS" });
    await expect(storage.changeMasterPassword(NEW_PASSWORD)).rejects.toMatchObject({ code: "REKEY_IN_PROGRESS" });
    await rekeying;

    const raw = await rawDump(dbName);
    expect(raw.entries).toHaveLength(0);
    expect(raw.categories).toHaveLength(1);
    storage.close();
  });
});

describe("規則 1：重新金鑰化（§4.1.1、§4.1.2）", () => {
  test("AC11：變更主密碼成功後新密碼可登入、條目可解密、cryptoVersion 不變、keyGeneration +1、舊密碼失效", async () => {
    const { storage, dbName } = await setupUnlocked();
    await storage.addEntry(entryInput, await storage.loadCategories());
    const before = await rawDump(dbName);

    await storage.changeMasterPassword(NEW_PASSWORD);

    const after = await rawDump(dbName);
    expect(after.securityConfig?.keyGeneration).toBe(before.securityConfig!.keyGeneration + 1);
    expect(after.securityConfig?.cryptoVersion).toBe(before.securityConfig!.cryptoVersion);
    expect(after.securityConfig?.masterPasswordSalt).not.toBe(before.securityConfig!.masterPasswordSalt);
    expect((await storage.loadEntries())[0].password).toBe(ENTRY_PLAINTEXT_PASSWORD);

    storage.logout();
    expect(await storage.login(PASSWORD)).toEqual({ ok: false, reason: "INVALID_MASTER_PASSWORD" });
    expect(await storage.login(NEW_PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
    expect((await storage.loadEntries())[0].password).toBe(ENTRY_PLAINTEXT_PASSWORD);
    storage.close();
  });

  test("AC11：新主密碼長度 < 12 被拒，IndexedDB 無任何變動", async () => {
    const { storage, dbName } = await setupUnlocked();
    const before = await rawDump(dbName);

    await expect(storage.changeMasterPassword("short")).rejects.toThrow(RangeError);
    expect(await rawDump(dbName)).toEqual(before);
    storage.close();
  });

  test("AC12：rekey 寫入交易中途失敗時 IndexedDB 完全維持原狀，session 保留舊金鑰，原密碼可登入", async () => {
    const { storage, dbName } = await setupUnlocked();
    const categories = await storage.loadCategories();
    await storage.addEntry(entryInput, categories);
    await storage.addEntry({ ...entryInput, appName: "Second Service" }, categories);
    const before = await rawDump(dbName);

    // 第 1 次 put 為新 SecurityConfig，第 2 次 put（第一筆新條目）失敗 → 已發出的 SecurityConfig 寫入須一併回滾
    failNthPut(2);
    await expect(storage.changeMasterPassword(NEW_PASSWORD)).rejects.toThrow("injected write failure");
    vi.restoreAllMocks();

    expect(await rawDump(dbName)).toEqual(before);
    expect((await storage.loadEntries()).map((e) => e.password)).toEqual([
      ENTRY_PLAINTEXT_PASSWORD,
      ENTRY_PLAINTEXT_PASSWORD,
    ]);
    await expect(storage.addEntry({ ...entryInput, appName: "After Failure" }, categories)).resolves.toBeDefined();

    storage.logout();
    expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
    expect(await storage.loadEntries()).toHaveLength(3);
    storage.close();
  });
});

describe("規則 2：救援碼登入（§4.2、AC2）", () => {
  test("救援碼 used=true 確認寫入提交後才放行；同一碼不可重複使用", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);
    const code = setup.recoveryCodesPlaintext[0];

    storage.logout();
    expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: true });
    expect(storage.isUnlocked()).toBe(false);

    expect(await storage.verifySecondFactor({ recoveryCode: code })).toEqual({ ok: true });
    expect(storage.isUnlocked()).toBe(true);
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes?.filter((c) => c.used)).toHaveLength(1);

    storage.logout();
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: code })).toEqual({
      ok: false,
      reason: "INVALID_RECOVERY_CODE",
    });
    expect(storage.isUnlocked()).toBe(false);
    storage.close();
  });

  test("救援碼 used=true 寫入失敗時不放行、該碼仍未使用且可重試", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);
    const code = setup.recoveryCodesPlaintext[0];
    storage.logout();
    await storage.login(PASSWORD);

    failNthPut(1);
    await expect(storage.verifySecondFactor({ recoveryCode: code })).rejects.toThrow("injected write failure");
    vi.restoreAllMocks();

    expect(storage.isUnlocked()).toBe(false);
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes?.every((c) => !c.used)).toBe(true);

    expect(await storage.verifySecondFactor({ recoveryCode: code })).toEqual({ ok: true });
    expect(storage.isUnlocked()).toBe(true);
    storage.close();
  });
});

describe("規則 3：補發救援碼（§4.2）", () => {
  test("確認提交前舊碼仍在 IndexedDB 保持有效；提交後舊碼失效、新碼生效", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);
    const oldCodes = (await rawDump(dbName)).securityConfig?.recoveryCodes;

    const begun = await storage.beginRecoveryCodesRegeneration(
      PASSWORD,
      await generate({ secret: setup.secret })
    );
    if (!begun.ok) throw new Error(`補發驗證未通過：${begun.reason}`);
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes).toEqual(oldCodes);

    await storage.commitRecoveryCodes(begun.batch);
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes).toEqual(begun.batch.recoveryCodes);

    storage.logout();
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: setup.recoveryCodesPlaintext[0] })).toEqual({
      ok: false,
      reason: "INVALID_RECOVERY_CODE",
    });
    expect(
      await storage.verifySecondFactor({ recoveryCode: begun.batch.recoveryCodesPlaintext[0] })
    ).toEqual({ ok: true });
    storage.close();
  });

  test("補發提交交易失敗時舊碼維持原狀、繼續有效", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);
    const oldCodes = (await rawDump(dbName)).securityConfig?.recoveryCodes;

    const begun = await storage.beginRecoveryCodesRegeneration(
      PASSWORD,
      await generate({ secret: setup.secret })
    );
    if (!begun.ok) throw new Error(`補發驗證未通過：${begun.reason}`);

    failNthPut(1);
    await expect(storage.commitRecoveryCodes(begun.batch)).rejects.toThrow("injected write failure");
    vi.restoreAllMocks();
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes).toEqual(oldCodes);

    storage.logout();
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: setup.recoveryCodesPlaintext[0] })).toEqual({
      ok: true,
    });
    storage.close();
  });

  test("TOTP 錯誤時不產生新批次且計入 totpFailureState；未經驗證產生的批次不得提交", async () => {
    const { storage, dbName } = await setupUnlocked();
    await enableTwoFactor(storage);
    const oldCodes = (await rawDump(dbName)).securityConfig?.recoveryCodes;

    expect(await storage.beginRecoveryCodesRegeneration(PASSWORD, "000000")).toEqual({
      ok: false,
      reason: "INVALID_TOTP_CODE",
    });
    expect((await rawDump(dbName)).securityConfig?.totpFailureState?.failedAttempts).toBe(1);

    const forged = {
      recoveryCodesPlaintext: ["AAAA-BBBB-CCCC-DDDD"],
      recoveryCodes: [{ codeHash: "forged", salt: "forged", used: false }],
      recoveryCodesRemainingWarningShown: false as const,
    };
    await expect(storage.commitRecoveryCodes(forged)).rejects.toThrow();
    expect((await rawDump(dbName)).securityConfig?.recoveryCodes).toEqual(oldCodes);
    storage.close();
  });
});

describe("2FA 開啟／關閉（§4.2、AC3、AC7）", () => {
  test("AC3：開啟 2FA 後 IndexedDB 不含 TOTP 秘鑰與救援碼明文", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);

    const raw = await rawDump(dbName);
    expect(raw.securityConfig?.twoFactorEnabled).toBe(true);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(setup.secret);
    for (const code of setup.recoveryCodesPlaintext) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(code.replace(/-/g, ""));
    }
    storage.close();
  });

  test("AC7：主密碼錯誤時拒絕關閉且不變；主密碼 + TOTP 通過後移除秘鑰與救援碼", async () => {
    const { storage, dbName } = await setupUnlocked();
    const setup = await enableTwoFactor(storage);

    expect(
      await storage.disableTwoFactor(WRONG_PASSWORD, { totpCode: await generate({ secret: setup.secret }) })
    ).toEqual({ ok: false, reason: "INVALID_MASTER_PASSWORD" });
    expect((await rawDump(dbName)).securityConfig?.twoFactorEnabled).toBe(true);

    expect(
      await storage.disableTwoFactor(PASSWORD, { totpCode: await generate({ secret: setup.secret }) })
    ).toEqual({ ok: true });
    const config = (await rawDump(dbName)).securityConfig;
    expect(config?.twoFactorEnabled).toBe(false);
    expect(config?.twoFactorSecretEncrypted).toBeUndefined();
    expect(config?.recoveryCodes).toBeUndefined();
    storage.close();
  });
});
