import { describe, test, expect } from "vitest";
import {
  initialEntriesState,
  reduceEntries,
  selectCategoryOptions,
  selectVisibleEntries,
  type EntriesEvent,
  type EntriesState,
  type ReadyEntriesState,
} from "../../src/ui/entries/entriesMachine";
import type { Entry } from "../../src/types/Entry";
import { CATEGORIES, EMAIL_ID, ENTRIES, UNCATEGORIZED_ID, WORK_ID, redactedEntries } from "./_shared/entriesFixtures";

/**
 * 模組：條目列表狀態機（UI 層純 reducer，不含副作用）
 * 對應規格 §4.5 搜尋／排序／篩選（三者疊加，AC5）、§4.4 密碼顯示切換、§3.5「未分類」。
 * 狀態中的 entries 為去識別化形態（password 恆為空字串）；明文只會出現在 revealed[entryId]。
 */

function ready(): ReadyEntriesState {
  const state = reduceEntries(initialEntriesState, {
    type: "LOADED",
    entries: redactedEntries(),
    categories: CATEGORIES,
  });
  if (state.phase !== "ready") throw new Error("fixture 應載入成功");
  return state;
}

function apply(state: EntriesState, ...events: EntriesEvent[]): EntriesState {
  return events.reduce(reduceEntries, state);
}

function readyAfter(...events: EntriesEvent[]): ReadyEntriesState {
  const state = apply(ready(), ...events);
  if (state.phase !== "ready") throw new Error("預期仍為 ready");
  return state;
}

const idsOf = (entries: Entry[]) => entries.map((entry) => entry.id);
const visibleIds = (state: ReadyEntriesState) => idsOf(selectVisibleEntries(state));

describe("載入", () => {
  test("初始為 loading；LOADED 後進入 ready，預設無搜尋／篩選、appName 升序、全部遮罩", () => {
    expect(initialEntriesState).toEqual({ phase: "loading" });
    expect(ready()).toEqual({
      phase: "ready",
      entries: redactedEntries(),
      categories: CATEGORIES,
      keyword: "",
      categoryIds: [],
      sortKey: "appName",
      sortDirection: "asc",
      revealed: {},
      copyNotice: null,
      dialog: null,
      categoryPanel: { open: false, busy: false, error: null },
    });
  });

  test("LOAD_FAILED 進入 error；ready 之後晚到的 LOADED／LOAD_FAILED 一律忽略", () => {
    expect(reduceEntries(initialEntriesState, { type: "LOAD_FAILED", error: "壞了" })).toEqual({
      phase: "error",
      error: "壞了",
    });
    const state = ready();
    expect(reduceEntries(state, { type: "LOAD_FAILED", error: "壞了" })).toBe(state);
    expect(reduceEntries(state, { type: "LOADED", entries: [], categories: CATEGORIES })).toBe(state);
  });

  test("尚未 ready 時，操作類事件一律忽略並回傳原狀態", () => {
    const events: EntriesEvent[] = [
      { type: "KEYWORD_CHANGED", keyword: "a" },
      { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
      { type: "FILTER_CLEARED" },
      { type: "QUERY_RESET" },
      { type: "SORT_KEY_CHANGED", key: "category" },
      { type: "SORT_DIRECTION_TOGGLED" },
      { type: "PASSWORD_REVEALED", entryId: "entry-1", password: "x" },
      { type: "PASSWORD_HIDDEN", entryId: "entry-1" },
      { type: "COPY_NOTICE_CLEARED" },
      { type: "DIALOG_OPENED", target: { type: "entryForm", entryId: null } },
      { type: "DIALOG_CLOSED" },
      { type: "DIALOG_SUBMITTING" },
      { type: "DIALOG_FAILED", error: "x" },
      { type: "CATEGORY_PANEL_TOGGLED" },
      { type: "CATEGORY_PANEL_SUBMITTING" },
      { type: "CATEGORY_PANEL_FAILED", error: "x" },
      { type: "CATEGORY_PANEL_IDLE" },
      { type: "RELOADED", entries: [], categories: [], revealed: {} },
    ];
    for (const event of events) {
      expect(reduceEntries(initialEntriesState, event)).toBe(initialEntriesState);
    }
  });
});

describe("搜尋／篩選／排序操作", () => {
  test("關鍵字、分類勾選（可取消）、清除篩選與整組重設；重設不動排序", () => {
    expect(readyAfter({ type: "KEYWORD_CHANGED", keyword: "ali" }).keyword).toBe("ali");

    const checked = readyAfter(
      { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
      { type: "CATEGORY_TOGGLED", categoryId: UNCATEGORIZED_ID }
    );
    expect(checked.categoryIds).toEqual([WORK_ID, UNCATEGORIZED_ID]);
    expect(apply(checked, { type: "CATEGORY_TOGGLED", categoryId: WORK_ID })).toMatchObject({
      categoryIds: [UNCATEGORIZED_ID],
    });
    expect(apply(checked, { type: "FILTER_CLEARED" })).toMatchObject({ categoryIds: [] });

    const messy = readyAfter(
      { type: "KEYWORD_CHANGED", keyword: "ali" },
      { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
      { type: "SORT_KEY_CHANGED", key: "updatedAt" },
      { type: "SORT_DIRECTION_TOGGLED" },
      { type: "QUERY_RESET" }
    );
    expect(messy).toMatchObject({ keyword: "", categoryIds: [], sortKey: "updatedAt", sortDirection: "desc" });
  });

  test("勾選不存在的分類 id 會被忽略；狀態未變時回傳同一個參照", () => {
    const state = ready();
    expect(reduceEntries(state, { type: "CATEGORY_TOGGLED", categoryId: "no-such-category" })).toBe(state);
    expect(reduceEntries(state, { type: "KEYWORD_CHANGED", keyword: "" })).toBe(state);
    expect(reduceEntries(state, { type: "FILTER_CLEARED" })).toBe(state);
    expect(reduceEntries(state, { type: "SORT_KEY_CHANGED", key: "appName" })).toBe(state);
  });

  test("切換排序鍵時保留目前方向；方向可正反切換", () => {
    const state = readyAfter(
      { type: "SORT_DIRECTION_TOGGLED" },
      { type: "SORT_KEY_CHANGED", key: "createdAt" }
    );
    expect(state).toMatchObject({ sortKey: "createdAt", sortDirection: "desc" });
    expect(apply(state, { type: "SORT_DIRECTION_TOGGLED" })).toMatchObject({ sortDirection: "asc" });
  });
});

describe("可見條目：搜尋 → 篩選 → 排序（§4.5、AC5）", () => {
  test("預設：全部條目、appName 升序，依 UTF-16 code unit 比較（大寫在小寫之前）", () => {
    expect(visibleIds(ready())).toEqual(["entry-1", "entry-4", "entry-3", "entry-2"]);
  });

  test("搜尋忽略大小寫，僅比對 appName／accountId；清空關鍵字顯示全部", () => {
    expect(visibleIds(readyAfter({ type: "KEYWORD_CHANGED", keyword: "ALICE" }))).toEqual(["entry-1", "entry-2"]);
    expect(visibleIds(readyAfter({ type: "KEYWORD_CHANGED", keyword: "pw-github" }))).toEqual([]);
    expect(
      visibleIds(readyAfter({ type: "KEYWORD_CHANGED", keyword: "alice" }, { type: "KEYWORD_CHANGED", keyword: "" }))
    ).toHaveLength(4);
  });

  test("關鍵字先做 NFC 正規化再搜尋，NFD 輸入也能找到 NFC 儲存的條目；不 trim", () => {
    const entries = redactedEntries([{ ...ENTRIES[0], id: "cafe", appName: "Café", accountId: "x" }]);
    const state = reduceEntries(initialEntriesState, { type: "LOADED", entries, categories: CATEGORIES });
    if (state.phase !== "ready") throw new Error("fixture 應載入成功");

    expect(visibleIds({ ...state, keyword: "Café" })).toEqual(["cafe"]);
    expect(visibleIds({ ...state, keyword: "Café " })).toEqual([]);
  });

  test("分類多選為 OR，可篩選「未分類」；未勾選視為不篩選", () => {
    expect(visibleIds(readyAfter({ type: "CATEGORY_TOGGLED", categoryId: UNCATEGORIZED_ID }))).toEqual(["entry-3"]);
    expect(
      visibleIds(
        readyAfter(
          { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
          { type: "CATEGORY_TOGGLED", categoryId: EMAIL_ID }
        )
      )
    ).toEqual(["entry-1", "entry-4", "entry-2"]);
  });

  test("三者疊加：關鍵字 + 兩個分類 + updatedAt 遞減，結果須同時滿足三者", () => {
    const state = readyAfter(
      { type: "KEYWORD_CHANGED", keyword: "alice" },
      { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
      { type: "CATEGORY_TOGGLED", categoryId: EMAIL_ID },
      { type: "SORT_KEY_CHANGED", key: "updatedAt" },
      { type: "SORT_DIRECTION_TOGGLED" }
    );
    // entry-3 被分類排除、entry-4 被關鍵字排除
    expect(visibleIds(state)).toEqual(["entry-1", "entry-2"]);
    expect(visibleIds(apply(state, { type: "SORT_DIRECTION_TOGGLED" }) as ReadyEntriesState)).toEqual([
      "entry-2",
      "entry-1",
    ]);
  });

  test("category 排序帶入 categories（不拋錯）：依分類名稱 code unit 排序，同分類以 id 為次序", () => {
    const asc = readyAfter({ type: "SORT_KEY_CHANGED", key: "category" });
    // "Email" < "Work" < "未分類"
    expect(visibleIds(asc)).toEqual(["entry-2", "entry-1", "entry-4", "entry-3"]);
    expect(visibleIds(apply(asc, { type: "SORT_DIRECTION_TOGGLED" }) as ReadyEntriesState)).toEqual([
      "entry-3",
      "entry-4",
      "entry-1",
      "entry-2",
    ]);
  });

  test("createdAt／updatedAt 排序", () => {
    expect(visibleIds(readyAfter({ type: "SORT_KEY_CHANGED", key: "createdAt" }))).toEqual([
      "entry-1",
      "entry-4",
      "entry-2",
      "entry-3",
    ]);
    expect(
      visibleIds(readyAfter({ type: "SORT_KEY_CHANGED", key: "updatedAt" }, { type: "SORT_DIRECTION_TOGGLED" }))
    ).toEqual(["entry-3", "entry-1", "entry-2", "entry-4"]);
  });

  test("不修改狀態中的 entries 陣列", () => {
    const state = readyAfter({ type: "SORT_KEY_CHANGED", key: "updatedAt" });
    const before = idsOf(state.entries);
    selectVisibleEntries(state);
    expect(idsOf(state.entries)).toEqual(before);
  });
});

describe("分類選項", () => {
  test("依 sortIndex 排序，「未分類」（sortIndex = -1）恆居首", () => {
    expect(selectCategoryOptions(ready()).map((category) => category.id)).toEqual([UNCATEGORIZED_ID, EMAIL_ID, WORK_ID]);
  });
});

describe("密碼顯示／隱藏（§4.4）：每筆獨立，明文只存在於 revealed", () => {
  test("顯示單筆不影響其他條目；隱藏後明文自狀態移除；entries 內的 password 始終為空字串", () => {
    const one = readyAfter({ type: "PASSWORD_REVEALED", entryId: "entry-1", password: "pw-github-7Hq2" });
    expect(one.revealed).toEqual({ "entry-1": "pw-github-7Hq2" });

    const two = apply(one, { type: "PASSWORD_REVEALED", entryId: "entry-2", password: "pw-gmail-4Zt9" }) as ReadyEntriesState;
    expect(Object.keys(two.revealed).sort()).toEqual(["entry-1", "entry-2"]);

    const hidden = apply(two, { type: "PASSWORD_HIDDEN", entryId: "entry-1" }) as ReadyEntriesState;
    expect(hidden.revealed).toEqual({ "entry-2": "pw-gmail-4Zt9" });

    expect(two.entries.every((entry) => entry.password === "")).toBe(true);
  });

  test("顯示不存在的條目、隱藏本來就遮罩的條目：忽略並回傳原狀態", () => {
    const state = ready();
    expect(reduceEntries(state, { type: "PASSWORD_REVEALED", entryId: "no-such-entry", password: "x" })).toBe(state);
    expect(reduceEntries(state, { type: "PASSWORD_HIDDEN", entryId: "entry-1" })).toBe(state);
  });

  test("搜尋／篩選／排序不會改變顯示狀態（切換條件後已顯示的仍維持顯示）", () => {
    const state = readyAfter(
      { type: "PASSWORD_REVEALED", entryId: "entry-1", password: "pw-github-7Hq2" },
      { type: "KEYWORD_CHANGED", keyword: "zoo" },
      { type: "KEYWORD_CHANGED", keyword: "" }
    );
    expect(state.revealed).toEqual({ "entry-1": "pw-github-7Hq2" });
  });
});

describe("複製提示", () => {
  test("顯示與清除；新提示取代舊提示", () => {
    const first = { entryId: "entry-1", field: "password", status: "copied" } as const;
    const second = { entryId: "entry-2", field: "account", status: "failed" } as const;
    const state = readyAfter({ type: "COPY_NOTICE_SHOWN", notice: first });
    expect(state.copyNotice).toEqual(first);
    expect(apply(state, { type: "COPY_NOTICE_SHOWN", notice: second })).toMatchObject({ copyNotice: second });
    expect(apply(state, { type: "COPY_NOTICE_CLEARED" })).toMatchObject({ copyNotice: null });
  });
});

describe("對話框（新增／編輯／刪除確認）", () => {
  const createTarget = { type: "entryForm", entryId: null } as const;

  test("開啟後為 idle 狀態；同時只能有一個對話框；可關閉", () => {
    const opened = readyAfter({ type: "DIALOG_OPENED", target: createTarget });
    expect(opened.dialog).toEqual({ target: createTarget, busy: false, error: null });

    expect(apply(opened, { type: "DIALOG_OPENED", target: { type: "entryForm", entryId: "entry-1" } })).toBe(opened);
    expect(apply(opened, { type: "DIALOG_CLOSED" })).toMatchObject({ dialog: null });
    expect(reduceEntries(ready(), { type: "DIALOG_CLOSED" })).toEqual(ready());
  });

  test("目標不存在時不開啟：編輯／刪除條目須是既有條目，刪除分類須是既有的使用者分類", () => {
    const state = ready();
    expect(reduceEntries(state, { type: "DIALOG_OPENED", target: { type: "entryForm", entryId: "nope" } })).toBe(state);
    expect(reduceEntries(state, { type: "DIALOG_OPENED", target: { type: "deleteEntry", entryId: "nope" } })).toBe(state);
    expect(reduceEntries(state, { type: "DIALOG_OPENED", target: { type: "deleteCategory", categoryId: "nope" } })).toBe(
      state
    );
    expect(
      readyAfter({ type: "DIALOG_OPENED", target: { type: "deleteEntry", entryId: "entry-1" } }).dialog?.target
    ).toEqual({ type: "deleteEntry", entryId: "entry-1" });
    expect(
      readyAfter({ type: "DIALOG_OPENED", target: { type: "entryForm", entryId: "entry-1" } }).dialog?.target
    ).toEqual({ type: "entryForm", entryId: "entry-1" });
  });

  test("「未分類」不可開啟刪除分類對話框（系統預設分類保護）", () => {
    const state = ready();
    expect(
      reduceEntries(state, { type: "DIALOG_OPENED", target: { type: "deleteCategory", categoryId: UNCATEGORIZED_ID } })
    ).toBe(state);
    expect(
      readyAfter({ type: "DIALOG_OPENED", target: { type: "deleteCategory", categoryId: WORK_ID } }).dialog?.target
    ).toEqual({ type: "deleteCategory", categoryId: WORK_ID });
  });

  test("送出中 busy、失敗後回到可編輯並帶錯誤；再次送出清除舊錯誤", () => {
    const submitting = readyAfter({ type: "DIALOG_OPENED", target: createTarget }, { type: "DIALOG_SUBMITTING" });
    expect(submitting.dialog).toEqual({ target: createTarget, busy: true, error: null });

    const failed = apply(submitting, { type: "DIALOG_FAILED", error: "壞了" }) as ReadyEntriesState;
    expect(failed.dialog).toEqual({ target: createTarget, busy: false, error: "壞了" });
    expect((apply(failed, { type: "DIALOG_SUBMITTING" }) as ReadyEntriesState).dialog).toMatchObject({
      busy: true,
      error: null,
    });
  });

  test("沒有對話框時，送出中／失敗事件忽略", () => {
    const state = ready();
    expect(reduceEntries(state, { type: "DIALOG_SUBMITTING" })).toBe(state);
    expect(reduceEntries(state, { type: "DIALOG_FAILED", error: "x" })).toBe(state);
  });
});

describe("分類管理面板", () => {
  test("開合切換；關閉時清除錯誤與忙碌旗標", () => {
    const open = readyAfter({ type: "CATEGORY_PANEL_TOGGLED" });
    expect(open.categoryPanel).toEqual({ open: true, busy: false, error: null });

    const failed = apply(open, { type: "CATEGORY_PANEL_SUBMITTING" }, { type: "CATEGORY_PANEL_FAILED", error: "壞了" });
    expect((failed as ReadyEntriesState).categoryPanel).toEqual({ open: true, busy: false, error: "壞了" });

    expect((apply(failed, { type: "CATEGORY_PANEL_TOGGLED" }) as ReadyEntriesState).categoryPanel).toEqual({
      open: false,
      busy: false,
      error: null,
    });
  });

  test("送出中 busy；IDLE 回到可操作並清除錯誤", () => {
    const busy = readyAfter({ type: "CATEGORY_PANEL_TOGGLED" }, { type: "CATEGORY_PANEL_SUBMITTING" });
    expect(busy.categoryPanel).toEqual({ open: true, busy: true, error: null });
    expect((apply(busy, { type: "CATEGORY_PANEL_IDLE" }) as ReadyEntriesState).categoryPanel).toEqual({
      open: true,
      busy: false,
      error: null,
    });
  });
});

describe("寫入後重新載入（RELOADED）", () => {
  const reloadedEntries = redactedEntries().filter((entry) => entry.id !== "entry-4");
  const reloadedCategories = CATEGORIES.filter((category) => category.id !== WORK_ID);

  test("替換條目與分類，保留關鍵字與排序；已不存在的分類自篩選勾選中移除", () => {
    const before = readyAfter(
      { type: "KEYWORD_CHANGED", keyword: "ali" },
      { type: "CATEGORY_TOGGLED", categoryId: WORK_ID },
      { type: "CATEGORY_TOGGLED", categoryId: EMAIL_ID },
      { type: "SORT_KEY_CHANGED", key: "updatedAt" },
      { type: "SORT_DIRECTION_TOGGLED" }
    );
    const after = apply(before, {
      type: "RELOADED",
      entries: reloadedEntries,
      categories: reloadedCategories,
      revealed: {},
    }) as ReadyEntriesState;

    expect(after.entries).toEqual(reloadedEntries);
    expect(after.categories).toEqual(reloadedCategories);
    expect(after).toMatchObject({
      keyword: "ali",
      categoryIds: [EMAIL_ID],
      sortKey: "updatedAt",
      sortDirection: "desc",
    });
  });

  test("顯示中的明文以事件帶入的 revealed 為準（編輯密碼後更新、條目刪除後移除）", () => {
    const before = readyAfter(
      { type: "PASSWORD_REVEALED", entryId: "entry-1", password: "old-pw" },
      { type: "PASSWORD_REVEALED", entryId: "entry-4", password: "pw-slack-2Vc6" }
    );
    const after = apply(before, {
      type: "RELOADED",
      entries: reloadedEntries,
      categories: reloadedCategories,
      revealed: { "entry-1": "new-pw" },
    }) as ReadyEntriesState;
    expect(after.revealed).toEqual({ "entry-1": "new-pw" });
    expect(JSON.stringify(after)).not.toContain("old-pw");
  });

  test("複製提示指向已不存在的條目時清除；對話框與面板狀態不受影響", () => {
    const before = readyAfter(
      { type: "COPY_NOTICE_SHOWN", notice: { entryId: "entry-4", field: "password", status: "copied" } },
      { type: "CATEGORY_PANEL_TOGGLED" },
      { type: "DIALOG_OPENED", target: { type: "entryForm", entryId: null } },
      { type: "DIALOG_SUBMITTING" }
    );
    const after = apply(before, {
      type: "RELOADED",
      entries: reloadedEntries,
      categories: reloadedCategories,
      revealed: {},
    }) as ReadyEntriesState;
    expect(after.copyNotice).toBeNull();
    expect(after.dialog).toEqual(before.dialog);
    expect(after.categoryPanel).toEqual(before.categoryPanel);
  });
});

describe("關閉（登出／閒置逾時／畫面卸載）", () => {
  test("CLOSED 後進入 closed，已顯示的明文一併捨棄；之後所有事件皆忽略", () => {
    const revealed = readyAfter({ type: "PASSWORD_REVEALED", entryId: "entry-1", password: "pw-github-7Hq2" });
    const closed = reduceEntries(revealed, { type: "CLOSED" });
    expect(closed).toEqual({ phase: "closed" });
    expect(JSON.stringify(closed)).not.toContain("pw-github-7Hq2");

    expect(reduceEntries(closed, { type: "LOADED", entries: redactedEntries(), categories: CATEGORIES })).toBe(closed);
    expect(reduceEntries(closed, { type: "PASSWORD_REVEALED", entryId: "entry-1", password: "x" })).toBe(closed);
  });

  test("載入中或失敗時也可關閉", () => {
    expect(reduceEntries(initialEntriesState, { type: "CLOSED" })).toEqual({ phase: "closed" });
    expect(reduceEntries({ phase: "error", error: "x" }, { type: "CLOSED" })).toEqual({ phase: "closed" });
  });
});
