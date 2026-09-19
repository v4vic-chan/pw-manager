import { describe, test, expect, vi, afterEach } from "vitest";
import {
  CLIPBOARD_CLEAR_MS,
  COPY_NOTICE_MS,
  createEntriesController,
  type ClipboardLike,
  type EntriesStorage,
} from "../../src/ui/entries/entriesController";
import { selectVisibleEntries, type ReadyEntriesState } from "../../src/ui/entries/entriesMachine";
import { StorageError } from "../../src/services/storage";
import type { Entry } from "../../src/types/Entry";
import {
  ALL_PASSWORDS,
  CATEGORIES,
  ENTRIES,
  UNCATEGORIZED_ID,
  WORK_ID,
  cloneCategories,
  cloneEntries,
} from "./_shared/entriesFixtures";

/**
 * 模組：條目列表控制器（UI 層，純 TypeScript，以假 storage／假剪貼簿注入）
 * 對應規格 §4.4 密碼顯示與複製、§4.5、§5.1.4（登出／逾時後明文須捨棄）、§2.3。
 * 重點：明文密碼只存在於控制器閉包內的 Map，畫面狀態只在使用者主動顯示時才含該筆明文；
 * 剪貼簿自動清除為 best-effort（僅在剪貼簿內容仍是我們寫入的值時才清除）。
 */

const GITHUB = ENTRIES[0];
const GMAIL = ENTRIES[1];

function createFakes(overrides: Partial<EntriesStorage> = {}, clipboardOverrides: Partial<ClipboardLike> = {}) {
  const storage: EntriesStorage = {
    loadEntries: vi.fn<EntriesStorage["loadEntries"]>(async () => cloneEntries()),
    loadCategories: vi.fn<EntriesStorage["loadCategories"]>(async () => cloneCategories()),
    ...overrides,
  };
  let clipboardText = "";
  const clipboard = {
    writeText: vi.fn<ClipboardLike["writeText"]>(async (text) => {
      clipboardText = text;
    }),
    readText: vi.fn<NonNullable<ClipboardLike["readText"]>>(async () => clipboardText),
    ...clipboardOverrides,
  };
  const controller = createEntriesController({ storage, clipboard });
  return { storage, clipboard, controller, setClipboard: (text: string) => (clipboardText = text) };
}

async function loaded(overrides: Partial<EntriesStorage> = {}, clipboardOverrides: Partial<ClipboardLike> = {}) {
  const fakes = createFakes(overrides, clipboardOverrides);
  await fakes.controller.load();
  return fakes;
}

function readyState(controller: { getState(): unknown }): ReadyEntriesState {
  const state = controller.getState() as ReadyEntriesState;
  if (state.phase !== "ready") throw new Error(`預期 ready，實際為 ${state.phase}`);
  return state;
}

const visibleIds = (controller: { getState(): unknown }) =>
  selectVisibleEntries(readyState(controller)).map((entry: Entry) => entry.id);

function stateContainsPlaintext(controller: { getState(): unknown }): boolean {
  const json = JSON.stringify(controller.getState());
  return ALL_PASSWORDS.some((password) => json.includes(password));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("載入", () => {
  test("進入 ready：狀態中的條目為去識別化形態，不含任何明文密碼；storage 各只讀一次", async () => {
    const { controller, storage } = createFakes();
    expect(controller.getState()).toEqual({ phase: "loading" });

    await controller.load();
    const state = readyState(controller);
    expect(state.entries).toHaveLength(4);
    expect(state.entries.every((entry) => entry.password === "")).toBe(true);
    expect(stateContainsPlaintext(controller)).toBe(false);
    expect(storage.loadEntries).toHaveBeenCalledTimes(1);
    expect(storage.loadCategories).toHaveBeenCalledTimes(1);
  });

  test("重複呼叫 load 不會重新讀取；狀態變更會通知訂閱者，取消訂閱後不再通知", async () => {
    const { controller, storage } = createFakes();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.load();
    await controller.load();
    expect(storage.loadEntries).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    controller.setKeyword("a");
    expect(listener).not.toHaveBeenCalled();
  });

  test("讀取失敗：StorageError 以對應文案呈現，其他錯誤使用通用文案，皆不外洩內部訊息", async () => {
    const notAuthenticated = await loaded({
      loadEntries: vi.fn(async () => {
        throw new StorageError("NOT_AUTHENTICATED", "internal detail");
      }),
    });
    expect(notAuthenticated.controller.getState()).toEqual({ phase: "error", error: "驗證已逾時，請重新輸入主密碼" });

    const generic = await loaded({
      loadCategories: vi.fn(async () => {
        throw new Error("IDB exploded with secret-internal");
      }),
    });
    expect(generic.controller.getState()).toEqual({
      phase: "error",
      error: "無法載入條目，請重新整理後再試",
    });
  });

  test("孤兒條目（categoryId 不在分類清單）僅於顯示層視為「未分類」，category 排序不會拋錯", async () => {
    const orphan: Entry = { ...GITHUB, id: "orphan", appName: "Orphan", categoryId: "deleted-category-id" };
    const { controller } = await loaded({
      loadEntries: vi.fn(async () => [...cloneEntries(), orphan]),
    });

    expect(readyState(controller).entries.find((entry) => entry.id === "orphan")?.categoryId).toBe(UNCATEGORIZED_ID);
    expect(() => controller.setSortKey("category")).not.toThrow();
    expect(visibleIds(controller)).toContain("orphan");

    controller.toggleCategory(UNCATEGORIZED_ID);
    expect(visibleIds(controller).sort()).toEqual(["entry-3", "orphan"]);
  });

  test("分類清單缺少「未分類」時，顯示層補上一筆，category 排序仍不拋錯", async () => {
    const withoutDefault = cloneCategories().filter((category) => category.id !== UNCATEGORIZED_ID);
    const { controller } = await loaded({ loadCategories: vi.fn(async () => withoutDefault) });

    expect(() => controller.setSortKey("category")).not.toThrow();
    expect(readyState(controller).categories.some((category) => category.id === UNCATEGORIZED_ID)).toBe(true);
    expect(visibleIds(controller)).toHaveLength(4);
  });
});

describe("搜尋／篩選／排序（疊加）", () => {
  test("操作經控制器反映到可見條目：關鍵字 + 兩個分類 + updatedAt 遞減", async () => {
    const { controller } = await loaded();
    controller.setKeyword("alice");
    controller.toggleCategory(WORK_ID);
    controller.toggleCategory(CATEGORIES[2].id);
    controller.setSortKey("updatedAt");
    controller.toggleSortDirection();
    expect(visibleIds(controller)).toEqual(["entry-1", "entry-2"]);

    controller.clearFilter();
    expect(readyState(controller).categoryIds).toEqual([]);
    expect(visibleIds(controller)).toEqual(["entry-1", "entry-2"]);

    controller.resetQuery();
    expect(visibleIds(controller)).toHaveLength(4);
    expect(readyState(controller)).toMatchObject({ sortKey: "updatedAt", sortDirection: "desc" });
  });

  test("搜尋、篩選、排序不會觸發任何 storage 重新讀取", async () => {
    const { controller, storage } = await loaded();
    controller.setKeyword("x");
    controller.toggleCategory(WORK_ID);
    controller.setSortKey("category");
    expect(storage.loadEntries).toHaveBeenCalledTimes(1);
    expect(storage.loadCategories).toHaveBeenCalledTimes(1);
  });
});

describe("密碼顯示／隱藏：明文只在使用者主動顯示時才進入畫面狀態", () => {
  test("顯示單筆只帶入該筆明文；隱藏後移除；其他條目維持遮罩", async () => {
    const { controller } = await loaded();
    controller.revealPassword("entry-1");
    expect(readyState(controller).revealed).toEqual({ "entry-1": GITHUB.password });
    expect(JSON.stringify(controller.getState())).not.toContain(GMAIL.password);

    controller.revealPassword("entry-2");
    expect(Object.keys(readyState(controller).revealed).sort()).toEqual(["entry-1", "entry-2"]);

    controller.hidePassword("entry-1");
    expect(readyState(controller).revealed).toEqual({ "entry-2": GMAIL.password });
    expect(JSON.stringify(controller.getState())).not.toContain(GITHUB.password);

    controller.hidePassword("entry-2");
    expect(stateContainsPlaintext(controller)).toBe(false);
  });

  test("顯示不存在的條目：忽略、不拋錯", async () => {
    const { controller } = await loaded();
    const before = controller.getState();
    expect(() => controller.revealPassword("no-such-entry")).not.toThrow();
    expect(controller.getState()).toBe(before);
  });
});

describe("複製到剪貼簿（§4.4）", () => {
  test("複製密碼不需先顯示：寫入明文、提示「已複製」，狀態中仍不含明文；提示約 2 秒後消失", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyPassword("entry-1");
    expect(clipboard.writeText).toHaveBeenCalledWith(GITHUB.password);
    expect(readyState(controller).copyNotice).toEqual({ entryId: "entry-1", field: "password", status: "copied" });
    expect(stateContainsPlaintext(controller)).toBe(false);

    await vi.advanceTimersByTimeAsync(COPY_NOTICE_MS - 1);
    expect(readyState(controller).copyNotice).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(readyState(controller).copyNotice).toBeNull();
  });

  test("後一次複製的提示取代前一次，前一次的計時器不會提早清掉新提示", async () => {
    vi.useFakeTimers();
    const { controller } = await loaded();

    await controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(COPY_NOTICE_MS - 500);
    await controller.copyAccount("entry-2");
    await vi.advanceTimersByTimeAsync(600);
    expect(readyState(controller).copyNotice).toEqual({ entryId: "entry-2", field: "account", status: "copied" });
    await vi.advanceTimersByTimeAsync(COPY_NOTICE_MS);
    expect(readyState(controller).copyNotice).toBeNull();
  });

  test("複製帳號：寫入 accountId、提示已複製，且不排程自動清除剪貼簿（帳號非秘密）", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyAccount("entry-2");
    expect(clipboard.writeText).toHaveBeenCalledWith(GMAIL.accountId);
    expect(readyState(controller).copyNotice).toEqual({ entryId: "entry-2", field: "account", status: "copied" });

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS * 2);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  test("複製失敗（寫入被拒）：提示失敗、不排程清除；剪貼簿 API 不存在時同樣提示失敗", async () => {
    vi.useFakeTimers();
    const rejected = await loaded({}, { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    await rejected.controller.copyPassword("entry-1");
    expect(readyState(rejected.controller).copyNotice).toEqual({ entryId: "entry-1", field: "password", status: "failed" });
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(rejected.clipboard.readText).not.toHaveBeenCalled();

    const storage = createFakes().storage;
    const noClipboard = createEntriesController({ storage });
    await noClipboard.load();
    await noClipboard.copyAccount("entry-1");
    expect(readyState(noClipboard).copyNotice).toEqual({ entryId: "entry-1", field: "account", status: "failed" });
  });

  test("複製不存在的條目：忽略，不寫入剪貼簿", async () => {
    const { controller, clipboard } = await loaded();
    await controller.copyPassword("no-such-entry");
    await controller.copyAccount("no-such-entry");
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("剪貼簿自動清除（§4.4 安全加分項，best-effort）", () => {
  test("30 秒後若剪貼簿仍是我們寫入的密碼，寫入空字串清除", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(clipboard.readText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
  });

  test("剪貼簿內容已被使用者換成別的東西時，不清除", async () => {
    vi.useFakeTimers();
    const { controller, clipboard, setClipboard } = await loaded();

    await controller.copyPassword("entry-1");
    setClipboard("something the user copied later");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  test("無法讀取剪貼簿（權限被拒或不支援 readText）時放棄清除，絕不無條件清空", async () => {
    vi.useFakeTimers();
    const denied = await loaded({}, { readText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) });
    await denied.controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(denied.clipboard.writeText).toHaveBeenCalledTimes(1);

    const unsupported = await loaded({}, { readText: undefined });
    await unsupported.controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(unsupported.clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  test("再次複製密碼會重新起算 30 秒，且只會清除最後一次寫入的值", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(20_000);
    await controller.copyPassword("entry-2");

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(clipboard.readText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
    // 兩次複製 + 一次清除
    expect(clipboard.writeText).toHaveBeenCalledTimes(3);
  });

  test("密碼複製後又複製帳號：剪貼簿已是帳號，到期時不清除", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyPassword("entry-1");
    await controller.copyAccount("entry-1");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
  });
});

describe("關閉（dispose）：登出、閒置逾時或畫面卸載", () => {
  test("捨棄狀態中的明文與私有 Map：進入 closed，之後顯示／複製一律無效", async () => {
    const { controller, clipboard } = await loaded();
    controller.revealPassword("entry-1");
    expect(stateContainsPlaintext(controller)).toBe(true);

    controller.dispose();
    expect(controller.getState()).toEqual({ phase: "closed" });
    expect(stateContainsPlaintext(controller)).toBe(false);

    controller.revealPassword("entry-1");
    await controller.copyPassword("entry-1");
    await controller.copyAccount("entry-1");
    expect(controller.getState()).toEqual({ phase: "closed" });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("有待清除的剪貼簿密碼時，立即嘗試清除（best-effort），並取消 30 秒計時器不重複清除", async () => {
    vi.useFakeTimers();
    const { controller, clipboard } = await loaded();

    await controller.copyPassword("entry-1");
    controller.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS * 2);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
  });

  test("dispose 時剪貼簿清除失敗不會拋出；沒有待清除內容時不碰剪貼簿", async () => {
    vi.useFakeTimers();
    const failing = await loaded({}, { readText: vi.fn(async () => Promise.reject(new Error("blur"))) });
    await failing.controller.copyPassword("entry-1");
    expect(() => failing.controller.dispose()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    const idle = await loaded();
    idle.controller.dispose();
    expect(idle.clipboard.readText).not.toHaveBeenCalled();
    expect(idle.clipboard.writeText).not.toHaveBeenCalled();
  });

  test("載入進行中就 dispose：晚到的結果不得寫入狀態，明文也不得留在控制器中", async () => {
    let release: (entries: Entry[]) => void = () => undefined;
    const pending = new Promise<Entry[]>((resolve) => {
      release = resolve;
    });
    const { controller, clipboard } = createFakes({ loadEntries: vi.fn(() => pending) });

    const loading = controller.load();
    controller.dispose();
    release(cloneEntries());
    await loading;

    expect(controller.getState()).toEqual({ phase: "closed" });
    controller.revealPassword("entry-1");
    await controller.copyPassword("entry-1");
    expect(controller.getState()).toEqual({ phase: "closed" });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("重複 dispose 安全", async () => {
    const { controller } = await loaded();
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("敏感資料：不落入 console", () => {
  test("整段操作（載入、搜尋、顯示、複製、清除、關閉、失敗）console 不含任何明文密碼", async () => {
    vi.useFakeTimers();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );

    const { controller } = await loaded();
    controller.setKeyword("alice");
    controller.revealPassword("entry-1");
    await controller.copyPassword("entry-1");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    controller.hidePassword("entry-1");
    controller.dispose();

    const failing = await loaded({}, { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    await failing.controller.copyPassword("entry-2");
    failing.controller.dispose();

    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const password of ALL_PASSWORDS) expect(output).not.toContain(password);
  });
});
