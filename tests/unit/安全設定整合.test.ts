import "fake-indexeddb/auto";
import { describe, test, expect, vi } from "vitest";
import { generate } from "otplib";
import { createApp } from "../../src/ui/appController";
import { createSecurityController, type DownloadFile } from "../../src/ui/security/securityController";
import type { ReadySecurityState } from "../../src/ui/security/securityMachine";
import { UNCATEGORIZED_CATEGORY_ID } from "../../src/services/category";

/**
 * 模組：安全設定 × 真實 Service Layer（安全設定控制器 + 真實 storage + fake-indexeddb + 真實 TOTP）
 * 驗證控制器傳給 storage 的參數與真實簽名相符，以及每個操作的持久化結果：
 * 變更主密碼後維持登入且新密碼可登入、條目可解密（AC11）；2FA 開啟／補發／關閉（§4.2、AC7）；匯出（§5.3、AC10）。
 */

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another long passphrase 2026";
const ENTRY_SECRET = "security-flow-entry-secret-77";

async function createUnlocked() {
  const app = await createApp({
    dbName: `security-flow-${crypto.randomUUID()}`,
    activityTarget: new EventTarget(),
    visibilityTarget: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
  });
  await app.controller.boot();
  await app.controller.submitSetup(PASSWORD, PASSWORD);
  await app.controller.submitLogin(PASSWORD);
  await app.storage.addEntry(
    { appName: "Bank", categoryId: UNCATEGORIZED_CATEGORY_ID, accountId: "me@bank.example", password: ENTRY_SECRET },
    await app.storage.loadCategories()
  );
  const download = vi.fn<(file: DownloadFile) => void>();
  const security = createSecurityController({ storage: app.storage, download, yieldToPaint: async () => undefined });
  await security.load();
  return { ...app, security, download };
}

const ready = (controller: { getState(): unknown }) => controller.getState() as ReadySecurityState;

describe("安全設定 × 真實 storage", () => {
  test("變更主密碼：維持登入、條目仍可讀；登出後只有新密碼能登入", async () => {
    const { controller: auth, storage, security } = await createUnlocked();

    security.openChangePassword();
    await security.submitChangePassword({ currentPassword: "wrong current password", newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    expect(ready(security).operation?.error).toBe("主密碼未變更：目前主密碼錯誤");

    await security.submitChangePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    expect(ready(security).operation).toBeNull();
    expect(storage.isUnlocked()).toBe(true);
    expect((await storage.loadEntries())[0].password).toBe(ENTRY_SECRET);

    auth.logout();
    expect(await storage.login(PASSWORD)).toMatchObject({ ok: false });
    expect(await storage.login(NEW_PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
    expect((await storage.loadEntries())[0].password).toBe(ENTRY_SECRET);
    security.dispose();
    storage.close();
  });

  test("2FA：開啟（需勾選保存）→ 補發（兩段式）→ 以 TOTP 關閉；狀態與登入行為皆正確", async () => {
    const { storage, security } = await createUnlocked();

    await security.openEnableTwoFactor();
    const operation = ready(security).operation;
    if (operation?.kind !== "enableTwoFactor" || operation.setup === null) throw new Error("應已產生秘鑰");
    const secret = operation.setup.secret;
    const firstCodes = operation.setup.recoveryCodes;

    security.goToEnableStep("codes");
    security.setAcknowledged(true);
    security.goToEnableStep("verify");
    await security.submitEnableTwoFactor(await generate({ secret }));
    expect(ready(security).status).toEqual({ twoFactorEnabled: true, unusedRecoveryCodes: firstCodes.length });

    storage.logout();
    expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: true });
    expect(await storage.verifySecondFactor({ totpCode: await generate({ secret }) })).toEqual({ ok: true });

    security.openRegenerateRecoveryCodes();
    await security.submitRegenerateVerification({ password: PASSWORD, totpCode: await generate({ secret }) });
    const regen = ready(security).operation;
    if (regen?.kind !== "regenerateRecoveryCodes" || regen.recoveryCodes === null) throw new Error("應已產生新碼");
    const newCodes = regen.recoveryCodes;
    security.setAcknowledged(true);
    await security.commitRecoveryCodes();
    expect(ready(security).operation).toBeNull();

    storage.logout();
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: firstCodes[0] })).toMatchObject({ ok: false });
    await storage.login(PASSWORD);
    expect(await storage.verifySecondFactor({ recoveryCode: newCodes[0] })).toEqual({ ok: true });

    security.openDisableTwoFactor();
    await security.submitDisableTwoFactor({ password: PASSWORD, code: await generate({ secret }) });
    expect(ready(security).status).toEqual({ twoFactorEnabled: false, unusedRecoveryCodes: 0 });
    storage.logout();
    expect(await storage.login(PASSWORD)).toEqual({ ok: true, requiresSecondFactor: false });
    security.dispose();
    storage.close();
  });

  test("匯出：下載的檔案為 ExportFile JSON，header 為明文、不含任何條目明文密碼", async () => {
    const { storage, security, download } = await createUnlocked();
    security.openExport();
    await security.submitExport();

    const [file] = download.mock.calls[0];
    const parsed = JSON.parse(file.content);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.header.kdfParams).toMatchObject({ parallelism: 1 });
    expect(file.content).not.toContain(ENTRY_SECRET);
    expect(file.content).not.toContain(PASSWORD);
    security.dispose();
    storage.close();
  });
});
