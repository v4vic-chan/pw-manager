import "fake-indexeddb/auto";
import { describe, test, expect, vi, afterEach } from "vitest";
import { createApp } from "../../src/ui/appController";
import { SESSION_LOST_LOGOUT_MS, createEntriesController } from "../../src/ui/entries/entriesController";
import type { ReadyEntriesState } from "../../src/ui/entries/entriesMachine";
import { UNCATEGORIZED_ID } from "./_shared/entriesFixtures";

/**
 * 模組：條目／分類管理 × 真實 Service Layer（entries 控制器 + 真實 storage + fake-indexeddb）
 * 驗證：控制器傳給 storage 的資料形狀符合真實簽名；寫入經加密落地後可重新解密讀回；
 * 「未分類」保護與 AC4（刪除分類時條目轉移且 updatedAt 不變）；登出後寫入被拒並觸發自動登出。
 */

vi.setConfig({ testTimeout: 60_000 });

const MASTER_PASSWORD = "correct horse battery staple";
const SECRET_A = "manage-secret-A-93kd";
const SECRET_B = "manage-secret-B-17qz";

async function createUnlockedApp() {
  const app = await createApp({
    dbName: `entries-manage-${crypto.randomUUID()}`,
    activityTarget: new EventTarget(),
    visibilityTarget: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
  });
  await app.controller.boot();
  await app.controller.submitSetup(MASTER_PASSWORD, MASTER_PASSWORD);
  await app.controller.submitLogin(MASTER_PASSWORD);
  return app;
}

const ready = (controller: { getState(): unknown }) => controller.getState() as ReadyEntriesState;

afterEach(() => {
  vi.useRealTimers();
});

describe("條目管理 × 真實 storage", () => {
  test("新增 → 編輯（密碼留空不變、輸入新密碼才變）→ 刪除，全程經加密落地並可解密讀回", async () => {
    const { controller: auth, storage } = await createUnlockedApp();
    const entries = createEntriesController({ storage });
    await entries.load();

    entries.openCreateEntry();
    await entries.submitEntryForm({
      appName: "Bank",
      accountId: "me@bank.example",
      password: SECRET_A,
      categoryId: UNCATEGORIZED_ID,
    });
    expect(ready(entries).dialog).toBeNull();
    expect(ready(entries).entries).toHaveLength(1);
    expect(JSON.stringify(entries.getState())).not.toContain(SECRET_A);

    const [stored] = await storage.loadEntries();
    expect(stored).toMatchObject({ appName: "Bank", accountId: "me@bank.example", password: SECRET_A });

    // 密碼留空：只改 appName，密碼維持不變
    entries.openEditEntry(stored.id);
    await entries.submitEntryForm({
      appName: "Bank 2",
      accountId: "me@bank.example",
      password: "",
      categoryId: UNCATEGORIZED_ID,
    });
    const [renamed] = await storage.loadEntries();
    expect(renamed).toMatchObject({ appName: "Bank 2", password: SECRET_A, createdAt: stored.createdAt });
    expect(renamed.updatedAt >= stored.updatedAt).toBe(true);

    // 輸入新密碼
    entries.openEditEntry(stored.id);
    await entries.submitEntryForm({
      appName: "Bank 2",
      accountId: "me@bank.example",
      password: SECRET_B,
      categoryId: UNCATEGORIZED_ID,
    });
    expect((await storage.loadEntries())[0].password).toBe(SECRET_B);
    entries.revealPassword(stored.id);
    expect(ready(entries).revealed[stored.id]).toBe(SECRET_B);

    entries.openDeleteEntry(stored.id);
    await entries.confirmDeleteEntry();
    await expect(storage.loadEntries()).resolves.toEqual([]);
    expect(ready(entries).entries).toEqual([]);

    entries.dispose();
    auth.logout();
    storage.close();
  });

  test("分類：新增 → 上移 → 重新命名 → 刪除；條目轉移至「未分類」且 updatedAt 不變（AC4），「未分類」始終保留且 sortIndex 為 -1", async () => {
    const { controller: auth, storage } = await createUnlockedApp();
    const entries = createEntriesController({ storage });
    await entries.load();

    await expect(entries.createCategory("Work")).resolves.toBe(true);
    await expect(entries.createCategory("Play")).resolves.toBe(true);
    await expect(entries.createCategory("work")).resolves.toBe(false);
    await expect(entries.createCategory("未分類")).resolves.toBe(false);

    const byName = async () => new Map((await storage.loadCategories()).map((category) => [category.name, category]));
    let categories = await byName();
    expect(categories.get("未分類")).toMatchObject({ sortIndex: -1, isSystemDefault: true });
    expect([categories.get("Work")?.sortIndex, categories.get("Play")?.sortIndex]).toEqual([0, 1]);

    await entries.moveCategory(categories.get("Play")!.id, "up");
    categories = await byName();
    expect([categories.get("Play")?.sortIndex, categories.get("Work")?.sortIndex]).toEqual([0, 1]);
    expect(categories.get("未分類")?.sortIndex).toBe(-1);

    await expect(entries.renameCategory(categories.get("Work")!.id, "Job")).resolves.toBe(true);
    await expect(entries.renameCategory(UNCATEGORIZED_ID, "Inbox")).resolves.toBe(false);
    categories = await byName();
    expect(categories.has("Job")).toBe(true);
    expect(categories.get("未分類")?.name).toBe("未分類");

    const jobId = categories.get("Job")!.id;
    entries.openCreateEntry();
    await entries.submitEntryForm({ appName: "Tracker", accountId: "t@example.com", password: SECRET_A, categoryId: jobId });
    const [before] = await storage.loadEntries();
    expect(before.categoryId).toBe(jobId);

    entries.openDeleteCategory(jobId);
    await entries.confirmDeleteCategory();

    const [after] = await storage.loadEntries();
    expect(after).toMatchObject({ categoryId: UNCATEGORIZED_ID, updatedAt: before.updatedAt, password: SECRET_A });
    categories = await byName();
    expect(categories.has("Job")).toBe(false);
    expect(categories.get("未分類")).toMatchObject({ sortIndex: -1, isSystemDefault: true });
    expect(ready(entries).entries[0].categoryId).toBe(UNCATEGORIZED_ID);

    entries.dispose();
    auth.logout();
    storage.close();
  });

  test("登出（session 已清除）後寫入被拒：對話框顯示驗證逾時提示，並於 SESSION_LOST_LOGOUT_MS 後通知自動登出", async () => {
    const { controller: auth, storage } = await createUnlockedApp();
    const onSessionLost = vi.fn();
    const entries = createEntriesController({ storage, onSessionLost });
    await entries.load();
    entries.openCreateEntry();

    auth.logout();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await entries.submitEntryForm({
      appName: "Late",
      accountId: "late@example.com",
      password: SECRET_A,
      categoryId: UNCATEGORIZED_ID,
    });

    expect(ready(entries).dialog?.error).toBe("驗證已逾時，請重新輸入主密碼（即將自動登出）");
    expect(onSessionLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    expect(onSessionLost).toHaveBeenCalledTimes(1);

    entries.dispose();
    storage.close();
  });
});
