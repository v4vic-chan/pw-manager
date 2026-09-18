import "fake-indexeddb/auto";
import { describe, test, expect, vi, afterEach } from "vitest";
import { generate } from "otplib";
import { createApp } from "../../src/ui/appController";

/**
 * 模組：登入／解鎖完整迴路（UI 控制器 + 真實 storage + 真實閒置計時器，fake-indexeddb）
 * 驗證 createApp 的組裝：主密碼 → 金鑰建立於記憶體 → session → 閒置計時運作 → 逾時清除 session。
 */

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "another long passphrase 2026";
const MINUTE = 60_000;

function createTargets() {
  const activityTarget = new EventTarget();
  const visibilityTarget = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  return { activityTarget, visibilityTarget };
}

async function createTestApp() {
  const targets = createTargets();
  const app = await createApp({ dbName: `ui-flow-${crypto.randomUUID()}`, ...targets });
  return { ...app, ...targets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("完整迴路（§4.1、§5.1.4、AC9）", () => {
  test("首次設定 → 登入 → 金鑰建立於記憶體可解密讀取 → 閒置計時運作 → 逾時後 session 清除並回到登入", async () => {
    const { controller, storage, idleTimer, activityTarget } = await createTestApp();

    await controller.boot();
    expect(controller.getState().phase).toBe("setup");
    await controller.submitSetup(PASSWORD, PASSWORD);
    expect(controller.getState().phase).toBe("login");
    expect(idleTimer.isRunning()).toBe(false);

    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toEqual({ phase: "authenticated" });
    expect(storage.isUnlocked()).toBe(true);
    await expect(storage.loadEntries()).resolves.toEqual([]);
    expect(idleTimer.isRunning()).toBe(true);

    // 模擬閒置 11 分鐘（背景分頁計時器未觸發），下一次活動應先判定逾時
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    activityTarget.dispatchEvent(new Event("keydown"));
    vi.useRealTimers();

    expect(controller.getState()).toMatchObject({ phase: "login", notice: "閒置逾時，已自動鎖定" });
    expect(storage.isUnlocked()).toBe(false);
    expect(idleTimer.isRunning()).toBe(false);
    await expect(storage.loadEntries()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    storage.close();
  });

  test("2FA 開啟時：主密碼通過即啟動閒置計時（尚未解鎖）；TOTP 通過後解鎖", async () => {
    const { controller, storage, idleTimer } = await createTestApp();
    await controller.boot();
    await controller.submitSetup(PASSWORD, PASSWORD);
    await controller.submitLogin(PASSWORD);

    const setup = await storage.beginTwoFactorSetup();
    await storage.confirmTwoFactorSetup(await generate({ secret: setup.secret }), setup);
    controller.logout();
    expect(idleTimer.isRunning()).toBe(false);

    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "secondFactor", method: "totp" });
    expect(storage.isUnlocked()).toBe(false);
    expect(idleTimer.isRunning()).toBe(true);

    await controller.submitSecondFactor(await generate({ secret: setup.secret }));
    expect(controller.getState()).toEqual({ phase: "authenticated" });
    expect(storage.isUnlocked()).toBe(true);

    controller.logout();
    storage.close();
  });

  test("登入頁匯入覆蓋：以其他保險庫的備份還原，完成後須以備份當時的主密碼登入", async () => {
    const source = await createTestApp();
    await source.controller.boot();
    await source.controller.submitSetup(PASSWORD, PASSWORD);
    await source.controller.submitLogin(PASSWORD);
    await source.storage.addEntry(
      {
        appName: "Example Service",
        categoryId: "00000000-0000-0000-0000-000000000000",
        accountId: "user@example.com",
        password: "entry-secret-123",
      },
      await source.storage.loadCategories()
    );
    const backup = JSON.stringify(await source.storage.exportVault());
    source.controller.logout();
    source.storage.close();

    const { controller, storage, idleTimer } = await createTestApp();
    await controller.boot();
    await controller.submitSetup(OTHER_PASSWORD, OTHER_PASSWORD);

    controller.beginImport();
    await controller.submitImportConfirmation("OVERWRITE");
    await controller.selectImportFile({ name: "backup.json", text: async () => backup });
    await controller.submitImport(PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "匯入完成，請以備份檔當時的主密碼登入" });
    expect(idleTimer.isRunning()).toBe(false);

    await controller.submitLogin(OTHER_PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "login", error: expect.stringContaining("主密碼錯誤") });
    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toEqual({ phase: "authenticated" });
    expect((await storage.loadEntries())[0].password).toBe("entry-secret-123");

    controller.logout();
    storage.close();
  });
});
