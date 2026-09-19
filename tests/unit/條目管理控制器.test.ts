import { describe, test, expect, vi, afterEach } from "vitest";
import {
  SESSION_LOST_LOGOUT_MS,
  createEntriesController,
  type EntriesStorage,
} from "../../src/ui/entries/entriesController";
import { selectCategoryOptions, type ReadyEntriesState } from "../../src/ui/entries/entriesMachine";
import type { EntryFormValues } from "../../src/ui/entries/validation";
import { StorageError } from "../../src/services/storage";
import type { Entry } from "../../src/types/Entry";
import {
  ALL_PASSWORDS,
  EMAIL_ID,
  ENTRIES,
  UNCATEGORIZED_ID,
  WORK_ID,
  cloneEntries,
} from "./_shared/entriesFixtures";
import { createFakeVault, deferred } from "./_shared/entriesFakes";

/**
 * 模組：條目／分類管理（控制器擴充：新增、編輯、刪除、分類 CRUD 與排序）
 * 對應規格 §4.4 條目 CRUD、§4.3 分類管理、§3.5／AC4「未分類」保護與刪除分類時條目轉移。
 * 以有狀態的假 storage（真實 service 純函式）注入。
 * 重點：寫入後重讀並保留搜尋／篩選／排序；storage 拒絕時對應文案；session 失效時提示後自動登出；
 * 表單輸入的明文只當參數傳遞，不留在狀態中；全程不使用 console。
 */

const GITHUB = ENTRIES[0];
const NEW_VALUES: EntryFormValues = {
  appName: "New App",
  accountId: "new@example.com",
  password: "pw-new-Zx81Qm",
  categoryId: WORK_ID,
};

async function setup(vaultOptions: Parameters<typeof createFakeVault>[0] = {}) {
  const vault = createFakeVault(vaultOptions);
  const onSessionLost = vi.fn();
  const controller = createEntriesController({ storage: vault.storage, onSessionLost });
  await controller.load();
  return { vault, storage: vault.storage, controller, onSessionLost };
}

function ready(controller: { getState(): unknown }): ReadyEntriesState {
  const state = controller.getState() as ReadyEntriesState;
  if (state.phase !== "ready") throw new Error(`預期 ready，實際為 ${state.phase}`);
  return state;
}

const entryByName = (controller: { getState(): unknown }, appName: string): Entry => {
  const found = ready(controller).entries.find((entry) => entry.appName === appName);
  if (found === undefined) throw new Error(`找不到條目 ${appName}`);
  return found;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("對話框開關", () => {
  test("新增／編輯／刪除條目、刪除分類皆可開啟並關閉；同時只有一個", async () => {
    const { controller } = await setup();

    controller.openCreateEntry();
    expect(ready(controller).dialog).toEqual({ target: { type: "entryForm", entryId: null }, busy: false, error: null });
    controller.openEditEntry("entry-1");
    expect(ready(controller).dialog?.target).toEqual({ type: "entryForm", entryId: null });
    controller.closeDialog();
    expect(ready(controller).dialog).toBeNull();

    controller.openEditEntry("entry-1");
    expect(ready(controller).dialog?.target).toEqual({ type: "entryForm", entryId: "entry-1" });
    controller.closeDialog();
    controller.openDeleteEntry("entry-2");
    expect(ready(controller).dialog?.target).toEqual({ type: "deleteEntry", entryId: "entry-2" });
    controller.closeDialog();
    controller.openDeleteCategory(WORK_ID);
    expect(ready(controller).dialog?.target).toEqual({ type: "deleteCategory", categoryId: WORK_ID });
  });

  test("不存在的目標與「未分類」不會開啟對話框", async () => {
    const { controller } = await setup();
    controller.openEditEntry("nope");
    controller.openDeleteEntry("nope");
    controller.openDeleteCategory("nope");
    controller.openDeleteCategory(UNCATEGORIZED_ID);
    expect(ready(controller).dialog).toBeNull();
  });

  test("分類管理面板可開合", async () => {
    const { controller } = await setup();
    controller.toggleCategoryPanel();
    expect(ready(controller).categoryPanel.open).toBe(true);
    controller.toggleCategoryPanel();
    expect(ready(controller).categoryPanel.open).toBe(false);
  });
});

describe("新增條目（§4.4）", () => {
  test("成功：以含「未分類」的分類清單呼叫 addEntry，寫入後重讀；狀態不含新密碼，可再顯示", async () => {
    const { controller, storage } = await setup();
    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);

    expect(storage.addEntry).toHaveBeenCalledTimes(1);
    expect(storage.addEntry).toHaveBeenCalledWith(
      { appName: "New App", accountId: "new@example.com", password: "pw-new-Zx81Qm", categoryId: WORK_ID },
      expect.arrayContaining([expect.objectContaining({ id: UNCATEGORIZED_ID })])
    );
    expect(storage.loadEntries).toHaveBeenCalledTimes(2);
    expect(storage.loadCategories).toHaveBeenCalledTimes(2);

    const state = ready(controller);
    expect(state.dialog).toBeNull();
    expect(state.entries).toHaveLength(5);
    const created = entryByName(controller, "New App");
    expect(created.password).toBe("");
    expect(JSON.stringify(state)).not.toContain("pw-new-Zx81Qm");

    controller.revealPassword(created.id);
    expect(ready(controller).revealed[created.id]).toBe("pw-new-Zx81Qm");
  });

  test("重讀後保留搜尋、分類篩選、排序與已顯示的密碼", async () => {
    const { controller } = await setup();
    controller.setKeyword("alice");
    controller.toggleCategory(WORK_ID);
    controller.setSortKey("updatedAt");
    controller.toggleSortDirection();
    controller.revealPassword("entry-1");

    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);

    expect(ready(controller)).toMatchObject({
      keyword: "alice",
      categoryIds: [WORK_ID],
      sortKey: "updatedAt",
      sortDirection: "desc",
      revealed: { "entry-1": GITHUB.password },
    });
  });

  test("提交前驗證失敗：不呼叫 storage，對話框保持開啟並提示先修正欄位", async () => {
    const { controller, storage } = await setup();
    controller.openCreateEntry();
    await controller.submitEntryForm({ ...NEW_VALUES, appName: "", password: "" });

    expect(storage.addEntry).not.toHaveBeenCalled();
    expect(ready(controller).dialog).toEqual({
      target: { type: "entryForm", entryId: null },
      busy: false,
      error: "請先修正標示的欄位",
    });
  });

  test("storage 拒絕：RangeError → 輸入不符規則；其他 Error → 通用失敗；REKEY_IN_PROGRESS → 專屬文案；皆不重讀、對話框保持開啟", async () => {
    const cases: [unknown, string][] = [
      [new RangeError("appName 長度須為 1–100"), "輸入內容不符合規則，請檢查欄位後再試"],
      [new Error("IDB exploded internal-detail"), "操作失敗，現有資料未被變更，請重試"],
      [new StorageError("REKEY_IN_PROGRESS", "x"), "系統正在更新加密金鑰，請稍後再試"],
    ];
    for (const [error, message] of cases) {
      const { controller, storage } = await setup({
        overrides: { addEntry: vi.fn<EntriesStorage["addEntry"]>(async () => Promise.reject(error)) },
      });
      controller.openCreateEntry();
      await controller.submitEntryForm(NEW_VALUES);

      expect(ready(controller).dialog).toEqual({ target: { type: "entryForm", entryId: null }, busy: false, error: message });
      expect(storage.loadEntries).toHaveBeenCalledTimes(1);
      expect(ready(controller).entries).toHaveLength(4);
    }
  });

  test("寫入進行中：dialog.busy，重複送出與關閉皆被忽略，只寫入一次", async () => {
    const gate = deferred<Entry>();
    const { controller, storage } = await setup({
      overrides: { addEntry: vi.fn<EntriesStorage["addEntry"]>(() => gate.promise) },
    });
    controller.openCreateEntry();

    const first = controller.submitEntryForm(NEW_VALUES);
    expect(ready(controller).dialog?.busy).toBe(true);
    await controller.submitEntryForm(NEW_VALUES);
    controller.closeDialog();
    expect(ready(controller).dialog?.busy).toBe(true);
    expect(storage.addEntry).toHaveBeenCalledTimes(1);

    gate.resolve({ ...GITHUB, id: "created" });
    await first;
    expect(ready(controller).dialog).toBeNull();
  });

  test("寫入成功但重讀失敗：提示重新整理，不宣稱寫入失敗", async () => {
    const loadEntries = vi
      .fn<EntriesStorage["loadEntries"]>()
      .mockResolvedValueOnce(cloneEntries())
      .mockRejectedValueOnce(new Error("read failed"));
    const { controller, storage } = await setup({ overrides: { loadEntries } });
    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);

    expect(storage.addEntry).toHaveBeenCalledTimes(1);
    expect(ready(controller).dialog).toEqual({
      target: { type: "entryForm", entryId: null },
      busy: false,
      error: "已儲存，但重新載入列表失敗，請重新整理頁面",
    });
  });
});

describe("編輯條目（§4.4：僅四個使用者欄位；密碼留空表示不變更）", () => {
  const EDIT = { appName: "GitHub Enterprise", accountId: "alice@corp.io", categoryId: EMAIL_ID };

  test("密碼留空：original 帶真實密碼，changes 不含 password；列表更新，updatedAt 變動、createdAt 不變", async () => {
    const { controller, storage } = await setup();
    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...EDIT, password: "" });

    const [original, changes] = vi.mocked(storage.editEntry).mock.calls[0];
    expect(original).toMatchObject({ id: "entry-1", password: GITHUB.password });
    expect(changes).toEqual(EDIT);

    const updated = ready(controller).entries.find((entry) => entry.id === "entry-1");
    expect(updated).toMatchObject({ ...EDIT, createdAt: GITHUB.createdAt });
    expect((updated?.updatedAt ?? "") > GITHUB.updatedAt).toBe(true);
    expect(ready(controller).dialog).toBeNull();

    controller.revealPassword("entry-1");
    expect(ready(controller).revealed["entry-1"]).toBe(GITHUB.password);
  });

  test("輸入新密碼：changes 帶 password；已顯示的明文重讀後更新為新密碼", async () => {
    const { controller, storage } = await setup();
    controller.revealPassword("entry-1");
    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...EDIT, password: "pw-changed-Aa1" });

    expect(vi.mocked(storage.editEntry).mock.calls[0][1]).toEqual({ ...EDIT, password: "pw-changed-Aa1" });
    expect(ready(controller).revealed["entry-1"]).toBe("pw-changed-Aa1");
    expect(JSON.stringify(ready(controller))).not.toContain(GITHUB.password);
  });

  test("內容完全沒變、或重新輸入相同密碼：不更新 updatedAt（真實密碼作為比對基準）", async () => {
    const same = { appName: GITHUB.appName, accountId: GITHUB.accountId, categoryId: GITHUB.categoryId };
    const { controller } = await setup();

    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...same, password: "" });
    expect(ready(controller).entries.find((entry) => entry.id === "entry-1")?.updatedAt).toBe(GITHUB.updatedAt);

    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...same, password: GITHUB.password });
    expect(ready(controller).entries.find((entry) => entry.id === "entry-1")?.updatedAt).toBe(GITHUB.updatedAt);
  });

  test("驗證：密碼可留空，但 appName 不可為空；失敗時不呼叫 storage", async () => {
    const { controller, storage } = await setup();
    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...EDIT, appName: "", password: "" });
    expect(storage.editEntry).not.toHaveBeenCalled();
    expect(ready(controller).dialog?.error).toBe("請先修正標示的欄位");
  });

  test("storage 拒絕時保留對話框並顯示文案", async () => {
    const { controller } = await setup({
      overrides: {
        editEntry: vi.fn<EntriesStorage["editEntry"]>(async () => Promise.reject(new RangeError("bad"))),
      },
    });
    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ ...EDIT, password: "" });
    expect(ready(controller).dialog?.error).toBe("輸入內容不符合規則，請檢查欄位後再試");
    expect(ready(controller).dialog?.busy).toBe(false);
  });
});

describe("刪除條目（§4.4：需確認的硬刪除）", () => {
  test("確認後以 confirmed=true 刪除、重讀並關閉；被刪除條目的明文與顯示狀態一併移除", async () => {
    const { controller, storage } = await setup();
    controller.revealPassword("entry-2");
    controller.openDeleteEntry("entry-2");
    await controller.confirmDeleteEntry();

    expect(storage.removeEntry).toHaveBeenCalledTimes(1);
    const [entriesArg, idArg, confirmedArg] = vi.mocked(storage.removeEntry).mock.calls[0];
    expect(entriesArg).toHaveLength(4);
    expect([idArg, confirmedArg]).toEqual(["entry-2", true]);

    const state = ready(controller);
    expect(state.entries.map((entry) => entry.id)).not.toContain("entry-2");
    expect(state.dialog).toBeNull();
    expect(state.revealed).toEqual({});
    controller.revealPassword("entry-2");
    expect(ready(controller).revealed).toEqual({});
  });

  test("沒有開啟刪除確認對話框時，confirmDeleteEntry 無效（防止繞過確認）", async () => {
    const { controller, storage } = await setup();
    await controller.confirmDeleteEntry();
    controller.openEditEntry("entry-1");
    await controller.confirmDeleteEntry();
    expect(storage.removeEntry).not.toHaveBeenCalled();
  });

  test("刪除失敗：條目保留、對話框保持開啟並顯示錯誤", async () => {
    const { controller } = await setup({
      overrides: { removeEntry: vi.fn<EntriesStorage["removeEntry"]>(async () => Promise.reject(new Error("x"))) },
    });
    controller.openDeleteEntry("entry-2");
    await controller.confirmDeleteEntry();
    expect(ready(controller).entries).toHaveLength(4);
    expect(ready(controller).dialog).toMatchObject({
      target: { type: "deleteEntry", entryId: "entry-2" },
      error: "操作失敗，現有資料未被變更，請重試",
    });
  });
});

describe("新增分類（§4.3、§3.5）", () => {
  test("成功：以目前分類清單呼叫 addCategory，重讀後新分類排在使用者分類尾端，回傳 true", async () => {
    const { controller, storage } = await setup();
    await expect(controller.createCategory("Personal")).resolves.toBe(true);

    expect(vi.mocked(storage.addCategory).mock.calls[0][0]).toBe("Personal");
    const options = selectCategoryOptions(ready(controller));
    expect(options.map((category) => category.name)).toEqual(["未分類", "Email", "Work", "Personal"]);
    expect(ready(controller).categoryPanel).toEqual({ open: false, busy: false, error: null });
  });

  test("提交前驗證：空白、純空白、過長、重名（不分大小寫、含「未分類」）皆不呼叫 storage，回傳 false 並在面板顯示錯誤", async () => {
    const { controller, storage } = await setup();
    const cases: [string, string][] = [
      ["", "請輸入分類名稱"],
      ["   ", "分類名稱不可只有空白"],
      ["a".repeat(51), "分類名稱最多 50 個字元"],
      ["email", "已有相同名稱的分類（不分大小寫）"],
      ["未分類", "已有相同名稱的分類（不分大小寫）"],
    ];
    for (const [name, message] of cases) {
      await expect(controller.createCategory(name)).resolves.toBe(false);
      expect(ready(controller).categoryPanel.error, name).toBe(message);
    }
    expect(storage.addCategory).not.toHaveBeenCalled();
  });

  test("storage 拒絕：面板顯示文案、回傳 false；普通 Error 一律通用失敗文案", async () => {
    const { controller } = await setup({
      overrides: { addCategory: vi.fn<EntriesStorage["addCategory"]>(async () => Promise.reject(new Error("dup?"))) },
    });
    await expect(controller.createCategory("Personal")).resolves.toBe(false);
    expect(ready(controller).categoryPanel).toEqual({
      open: false,
      busy: false,
      error: "操作失敗，現有資料未被變更，請重試",
    });
  });
});

describe("重新命名分類", () => {
  test("成功：呼叫 renameCategory 並重讀；改大小寫（與自己相同）合法", async () => {
    const { controller, storage } = await setup();
    await expect(controller.renameCategory(WORK_ID, "Job")).resolves.toBe(true);
    expect(vi.mocked(storage.renameCategory).mock.calls[0].slice(0, 2)).toEqual([WORK_ID, "Job"]);
    expect(ready(controller).categories.find((category) => category.id === WORK_ID)?.name).toBe("Job");

    await expect(controller.renameCategory(EMAIL_ID, "EMAIL")).resolves.toBe(true);
    expect(ready(controller).categories.find((category) => category.id === EMAIL_ID)?.name).toBe("EMAIL");
  });

  test("驗證：與其他分類重名（含「未分類」）、空白皆被擋下，不呼叫 storage", async () => {
    const { controller, storage } = await setup();
    await expect(controller.renameCategory(WORK_ID, "email")).resolves.toBe(false);
    expect(ready(controller).categoryPanel.error).toBe("已有相同名稱的分類（不分大小寫）");
    await expect(controller.renameCategory(WORK_ID, "未分類")).resolves.toBe(false);
    await expect(controller.renameCategory(WORK_ID, "  ")).resolves.toBe(false);
    expect(storage.renameCategory).not.toHaveBeenCalled();
  });

  test("「未分類」與不存在的分類不可重新命名：直接忽略，不呼叫 storage", async () => {
    const { controller, storage } = await setup();
    await expect(controller.renameCategory(UNCATEGORIZED_ID, "Inbox")).resolves.toBe(false);
    await expect(controller.renameCategory("nope", "Inbox")).resolves.toBe(false);
    expect(storage.renameCategory).not.toHaveBeenCalled();
  });
});

describe("調整分類順序（上移／下移，§4.3）", () => {
  test("Work 上移：以依 sortIndex 排序的使用者分類（不含「未分類」）與位置呼叫 reorderCategories", async () => {
    const { controller, storage } = await setup();
    await controller.moveCategory(WORK_ID, "up");

    const [userCategories, from, to] = vi.mocked(storage.reorderCategories).mock.calls[0];
    expect(userCategories.map((category) => category.id)).toEqual([EMAIL_ID, WORK_ID]);
    expect([from, to]).toEqual([1, 0]);
    expect(selectCategoryOptions(ready(controller)).map((category) => category.name)).toEqual(["未分類", "Work", "Email"]);

    await controller.moveCategory(WORK_ID, "down");
    expect(selectCategoryOptions(ready(controller)).map((category) => category.name)).toEqual(["未分類", "Email", "Work"]);
  });

  test("已在最前不可上移、已在最後不可下移；「未分類」與不存在的分類不可移動：皆不呼叫 storage", async () => {
    const { controller, storage } = await setup();
    await controller.moveCategory(EMAIL_ID, "up");
    await controller.moveCategory(WORK_ID, "down");
    await controller.moveCategory(UNCATEGORIZED_ID, "down");
    await controller.moveCategory(UNCATEGORIZED_ID, "up");
    await controller.moveCategory("nope", "up");
    expect(storage.reorderCategories).not.toHaveBeenCalled();
  });

  test("失敗時面板顯示文案，順序不變", async () => {
    const { controller } = await setup({
      overrides: {
        reorderCategories: vi.fn<EntriesStorage["reorderCategories"]>(async () => Promise.reject(new Error("x"))),
      },
    });
    await controller.moveCategory(WORK_ID, "up");
    expect(ready(controller).categoryPanel.error).toBe("操作失敗，現有資料未被變更，請重試");
    expect(selectCategoryOptions(ready(controller)).map((category) => category.name)).toEqual(["未分類", "Email", "Work"]);
  });
});

describe("刪除分類（§3.5、§4.3、AC4）", () => {
  test("確認後：條目於同一次操作轉移至「未分類」且不更新 updatedAt；篩選勾選中的該分類被移除", async () => {
    const { controller, storage } = await setup();
    controller.toggleCategory(WORK_ID);
    controller.toggleCategory(EMAIL_ID);
    controller.openDeleteCategory(WORK_ID);
    await controller.confirmDeleteCategory();

    const [categoryId, categoriesArg, entriesArg] = vi.mocked(storage.removeCategory).mock.calls[0];
    expect(categoryId).toBe(WORK_ID);
    expect(categoriesArg.some((category) => category.id === WORK_ID)).toBe(true);
    expect(entriesArg).toHaveLength(4);

    const state = ready(controller);
    expect(state.categories.map((category) => category.id)).not.toContain(WORK_ID);
    expect(state.categoryIds).toEqual([EMAIL_ID]);
    expect(state.dialog).toBeNull();
    for (const id of ["entry-1", "entry-4"]) {
      const moved = state.entries.find((entry) => entry.id === id);
      expect(moved?.categoryId).toBe(UNCATEGORIZED_ID);
      expect(moved?.updatedAt).toBe(ENTRIES.find((entry) => entry.id === id)?.updatedAt);
    }
  });

  test("沒有開啟刪除分類對話框時 confirmDeleteCategory 無效；「未分類」永遠無法進入刪除流程", async () => {
    const { controller, storage } = await setup();
    await controller.confirmDeleteCategory();
    controller.openDeleteCategory(UNCATEGORIZED_ID);
    await controller.confirmDeleteCategory();
    expect(storage.removeCategory).not.toHaveBeenCalled();
    expect(ready(controller).categories.some((category) => category.id === UNCATEGORIZED_ID)).toBe(true);
  });

  test("失敗時保留對話框、分類與條目不變", async () => {
    const { controller } = await setup({
      overrides: {
        removeCategory: vi.fn<EntriesStorage["removeCategory"]>(async () => Promise.reject(new Error("x"))),
      },
    });
    controller.openDeleteCategory(WORK_ID);
    await controller.confirmDeleteCategory();
    expect(ready(controller).dialog).toMatchObject({ error: "操作失敗，現有資料未被變更，請重試", busy: false });
    expect(ready(controller).entries.find((entry) => entry.id === "entry-1")?.categoryId).toBe(WORK_ID);
  });
});

describe("session 失效（KEY_GENERATION_MISMATCH／NOT_AUTHENTICATED）：先提示，再自動登出", () => {
  test("對話框寫入：顯示對應文案，經 SESSION_LOST_LOGOUT_MS 後呼叫 onSessionLost 一次；之後寫入一律忽略", async () => {
    vi.useFakeTimers();
    const { controller, storage, onSessionLost } = await setup({
      overrides: {
        addEntry: vi.fn<EntriesStorage["addEntry"]>(async () =>
          Promise.reject(new StorageError("KEY_GENERATION_MISMATCH", "x"))
        ),
      },
    });
    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);

    expect(ready(controller).dialog).toEqual({
      target: { type: "entryForm", entryId: null },
      busy: false,
      error: "保險庫資料已在其他地方變更，請重新登入（即將自動登出）",
    });
    expect(onSessionLost).not.toHaveBeenCalled();

    await controller.submitEntryForm(NEW_VALUES);
    expect(storage.addEntry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS - 1);
    expect(onSessionLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  test("分類面板寫入：NOT_AUTHENTICATED 同樣顯示文案並排程登出", async () => {
    vi.useFakeTimers();
    const { controller, onSessionLost } = await setup({
      overrides: {
        addCategory: vi.fn<EntriesStorage["addCategory"]>(async () =>
          Promise.reject(new StorageError("NOT_AUTHENTICATED", "x"))
        ),
      },
    });
    await controller.createCategory("Personal");
    expect(ready(controller).categoryPanel.error).toBe("驗證已逾時，請重新輸入主密碼（即將自動登出）");

    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  test("dispose 取消尚未觸發的自動登出；未提供 onSessionLost 也不會拋錯", async () => {
    vi.useFakeTimers();
    const failing = { addEntry: vi.fn<EntriesStorage["addEntry"]>(async () => Promise.reject(new StorageError("NOT_AUTHENTICATED", "x"))) };

    const first = await setup({ overrides: failing });
    first.controller.openCreateEntry();
    await first.controller.submitEntryForm(NEW_VALUES);
    first.controller.dispose();
    await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS * 2);
    expect(first.onSessionLost).not.toHaveBeenCalled();

    const vault = createFakeVault({ overrides: failing });
    const bare = createEntriesController({ storage: vault.storage });
    await bare.load();
    bare.openCreateEntry();
    await bare.submitEntryForm(NEW_VALUES);
    await expect(vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS)).resolves.not.toThrow();
  });
});

describe("dispose 與敏感資料", () => {
  test("寫入進行中就 dispose：晚到的結果不得重讀、不得寫入狀態", async () => {
    const gate = deferred<Entry>();
    const { controller, storage } = await setup({
      overrides: { addEntry: vi.fn<EntriesStorage["addEntry"]>(() => gate.promise) },
    });
    controller.openCreateEntry();
    const submitting = controller.submitEntryForm(NEW_VALUES);
    controller.dispose();
    gate.resolve({ ...GITHUB, id: "created" });
    await submitting;

    expect(controller.getState()).toEqual({ phase: "closed" });
    expect(storage.loadEntries).toHaveBeenCalledTimes(1);
  });

  test("關閉後所有管理操作皆無效", async () => {
    const { controller, storage } = await setup();
    controller.dispose();
    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);
    await controller.createCategory("Personal");
    await controller.moveCategory(WORK_ID, "up");
    expect(storage.addEntry).not.toHaveBeenCalled();
    expect(storage.addCategory).not.toHaveBeenCalled();
    expect(storage.reorderCategories).not.toHaveBeenCalled();
  });

  test("整段 CRUD 流程 console 不含任何明文密碼，狀態也不留存表單輸入的密碼", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const { controller } = await setup();

    controller.openCreateEntry();
    await controller.submitEntryForm(NEW_VALUES);
    controller.openEditEntry("entry-1");
    await controller.submitEntryForm({ appName: "GitHub", accountId: "alice@dev.io", categoryId: WORK_ID, password: "pw-typed-Q9" });
    controller.openDeleteEntry("entry-2");
    await controller.confirmDeleteEntry();
    await controller.createCategory("Personal");
    controller.dispose();

    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const password of [...ALL_PASSWORDS, NEW_VALUES.password, "pw-typed-Q9"]) expect(output).not.toContain(password);
  });
});
