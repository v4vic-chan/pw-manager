import "fake-indexeddb/auto";
import { describe, test, expect, vi } from "vitest";
import { createApp } from "../../src/ui/appController";
import { createEntriesController, type ClipboardLike } from "../../src/ui/entries/entriesController";
import { selectVisibleEntries, type ReadyEntriesState } from "../../src/ui/entries/entriesMachine";
import { UNCATEGORIZED_ID } from "./_shared/entriesFixtures";

/**
 * 模組：條目列表 × 真實 Service Layer（entries 控制器 + 真實 storage + fake-indexeddb）
 * 驗證：真實 loadEntries()／loadCategories() 的回傳形狀可直接餵給列表控制器；
 * 明文只在使用者主動顯示／複製時才離開控制器；登出後 session 清除，列表資料無法再讀取。
 */

vi.setConfig({ testTimeout: 60_000 });

const MASTER_PASSWORD = "correct horse battery staple";
const SECRET_A = "integration-secret-A-93kd";
const SECRET_B = "integration-secret-B-17qz";

async function createUnlockedApp() {
  const app = await createApp({
    dbName: `entries-flow-${crypto.randomUUID()}`,
    activityTarget: new EventTarget(),
    visibilityTarget: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
  });
  await app.controller.boot();
  await app.controller.submitSetup(MASTER_PASSWORD, MASTER_PASSWORD);
  await app.controller.submitLogin(MASTER_PASSWORD);

  const work = await app.storage.addCategory("Work", await app.storage.loadCategories());
  const categories = await app.storage.loadCategories();
  await app.storage.addEntry(
    { appName: "Bank", categoryId: UNCATEGORIZED_ID, accountId: "me@bank.example", password: SECRET_A },
    categories
  );
  await app.storage.addEntry(
    { appName: "Ticketing", categoryId: work.id, accountId: "me@work.example", password: SECRET_B },
    categories
  );
  return { ...app, workId: work.id };
}

function createClipboard() {
  let text = "";
  return {
    writeText: vi.fn<ClipboardLike["writeText"]>(async (value) => {
      text = value;
    }),
    readText: vi.fn<NonNullable<ClipboardLike["readText"]>>(async () => text),
  };
}

describe("條目列表 × 真實 storage", () => {
  test("載入真實解密資料：狀態不含明文；顯示與複製才取得明文；搜尋／篩選／category 排序可運作", async () => {
    const { controller: auth, storage, workId } = await createUnlockedApp();
    const clipboard = createClipboard();
    const entries = createEntriesController({ storage, clipboard });

    await entries.load();
    const state = entries.getState() as ReadyEntriesState;
    expect(state.phase).toBe("ready");
    expect(state.entries).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain(SECRET_A);
    expect(JSON.stringify(state)).not.toContain(SECRET_B);

    const bank = state.entries.find((entry) => entry.appName === "Bank");
    if (bank === undefined) throw new Error("找不到 Bank 條目");

    entries.revealPassword(bank.id);
    expect(JSON.stringify(entries.getState())).toContain(SECRET_A);
    expect(JSON.stringify(entries.getState())).not.toContain(SECRET_B);
    await entries.copyPassword(bank.id);
    expect(clipboard.writeText).toHaveBeenCalledWith(SECRET_A);

    entries.setSortKey("category");
    const names = () =>
      selectVisibleEntries(entries.getState() as ReadyEntriesState).map((entry) => entry.appName);
    // 分類名稱 "Work" < "未分類"（UTF-16 code unit）
    expect(names()).toEqual(["Ticketing", "Bank"]);

    entries.toggleCategory(UNCATEGORIZED_ID);
    expect(names()).toEqual(["Bank"]);
    entries.toggleCategory(workId);
    entries.setKeyword("TICKET");
    expect(names()).toEqual(["Ticketing"]);

    entries.dispose();
    auth.logout();
  });

  test("登出後 session 清除：列表控制器 dispose 並清除剪貼簿，storage 不再允許讀取", async () => {
    const { controller: auth, storage } = await createUnlockedApp();
    const clipboard = createClipboard();
    const entries = createEntriesController({ storage, clipboard });
    await entries.load();

    const [first] = (entries.getState() as ReadyEntriesState).entries;
    await entries.copyPassword(first.id);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);

    auth.logout();
    entries.dispose();
    expect(entries.getState()).toEqual({ phase: "closed" });
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(""));
    await expect(storage.loadEntries()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    // 未登入時才建立的控制器：載入失敗並顯示驗證逾時，不含任何資料
    const stale = createEntriesController({ storage, clipboard });
    await stale.load();
    expect(stale.getState()).toEqual({ phase: "error", error: "驗證已逾時，請重新輸入主密碼" });
    storage.close();
  });
});
