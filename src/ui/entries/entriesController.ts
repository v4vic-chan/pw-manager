import { UNCATEGORIZED_CATEGORY_ID } from "../../services/category";
import type { SortKey } from "../../services/search";
import type { VaultStorage } from "../../services/storage";
import type { Category } from "../../types/Category";
import type { Entry } from "../../types/Entry";
import {
  initialEntriesState,
  reduceEntries,
  type CopyField,
  type EntriesEvent,
  type EntriesState,
} from "./entriesMachine";
import { UNCATEGORIZED_NAME, loadErrorMessage } from "./messages";

/**
 * 條目列表控制器：持有狀態機、呼叫 Service Layer（storage.ts）並管理明文密碼與剪貼簿的生命週期。
 *
 * 明文處理（§2.3、§5.1.4）：storage.loadEntries() 一次回傳全部解密後的 Entry[]，無法逐筆解密；
 * 因此明文只保留在本閉包內的 secrets Map（不進入 reducer 狀態、React 狀態與 DOM），
 * 畫面狀態只有在使用者主動顯示時才含該筆明文。dispose()（登出、閒置逾時、畫面卸載）時整個清空。
 * 不使用 console，避免明文落入任何日誌。
 */

export type EntriesStorage = Pick<VaultStorage, "loadEntries" | "loadCategories">;

/** navigator.clipboard 的最小子集；readText 可能因權限或瀏覽器支援度而不存在 */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText?(): Promise<string>;
}

export interface EntriesControllerDeps {
  storage: EntriesStorage;
  /** 缺少（例如非安全環境）時，複製一律提示失敗 */
  clipboard?: ClipboardLike;
}

/** 複製結果提示停留時間 */
export const COPY_NOTICE_MS = 2000;

/** §4.4（非強制驗收）：複製密碼後嘗試清除剪貼簿的等待時間 */
export const CLIPBOARD_CLEAR_MS = 30_000;

export interface EntriesController {
  getState(): EntriesState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  setKeyword(keyword: string): void;
  toggleCategory(categoryId: string): void;
  /** 只清除分類勾選 */
  clearFilter(): void;
  /** 清除關鍵字與分類勾選，保留排序 */
  resetQuery(): void;
  setSortKey(key: SortKey): void;
  toggleSortDirection(): void;
  revealPassword(entryId: string): void;
  hidePassword(entryId: string): void;
  copyPassword(entryId: string): Promise<void>;
  copyAccount(entryId: string): Promise<void>;
  /** 捨棄所有明文與計時器，並盡力清除剪貼簿中殘留的密碼；之後所有操作皆無效 */
  dispose(): void;
}

/** 畫面層防守：sortEntries(key="category") 遇到找不到分類會拋錯，故確保分類清單一定含「未分類」 */
function withUncategorized(categories: Category[]): Category[] {
  if (categories.some((category) => category.id === UNCATEGORIZED_CATEGORY_ID)) return categories;
  return [
    {
      id: UNCATEGORIZED_CATEGORY_ID,
      name: UNCATEGORIZED_NAME,
      sortIndex: -1,
      isSystemDefault: true,
      createdAt: new Date(0).toISOString(),
    },
    ...categories,
  ];
}

export function createEntriesController(deps: EntriesControllerDeps): EntriesController {
  const { storage, clipboard } = deps;

  let state: EntriesState = initialEntriesState;
  const listeners = new Set<() => void>();
  /** entryId → 明文密碼；僅存在於此閉包 */
  const secrets = new Map<string, string>();
  let started = false;
  let disposed = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次寫入剪貼簿的密碼與其清除計時器；到期或關閉時才比對並清除 */
  let pendingClear: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  function dispatch(event: EntriesEvent): void {
    const next = reduceEntries(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  /**
   * best-effort：只有剪貼簿內容仍是我們寫入的值才清除；
   * 無法讀取（權限被拒、瀏覽器不支援、頁面失焦）時放棄，絕不無條件清空以免誤清使用者之後複製的內容。
   */
  async function clearClipboardIfUnchanged(expected: string): Promise<void> {
    if (clipboard === undefined || clipboard.readText === undefined) return;
    try {
      if ((await clipboard.readText()) === expected) await clipboard.writeText("");
    } catch {
      // 放棄清除
    }
  }

  function scheduleClipboardClear(text: string): void {
    if (pendingClear !== null) clearTimeout(pendingClear.timer);
    const timer = setTimeout(() => {
      const pending = pendingClear;
      pendingClear = null;
      if (pending !== null) void clearClipboardIfUnchanged(pending.text);
    }, CLIPBOARD_CLEAR_MS);
    pendingClear = { text, timer };
  }

  function showCopyNotice(entryId: string, field: CopyField, status: "copied" | "failed"): void {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    dispatch({ type: "COPY_NOTICE_SHOWN", notice: { entryId, field, status } });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      dispatch({ type: "COPY_NOTICE_CLEARED" });
    }, COPY_NOTICE_MS);
  }

  function textToCopy(entryId: string, field: CopyField): string | undefined {
    if (state.phase !== "ready") return undefined;
    if (field === "password") return secrets.get(entryId);
    return state.entries.find((entry) => entry.id === entryId)?.accountId;
  }

  async function copy(entryId: string, field: CopyField): Promise<void> {
    const text = textToCopy(entryId, field);
    if (text === undefined) return;

    try {
      if (clipboard === undefined) throw new Error("clipboard unavailable");
      await clipboard.writeText(text);
    } catch {
      if (!disposed) showCopyNotice(entryId, field, "failed");
      return;
    }

    if (disposed) {
      // 寫入完成前就已關閉：密碼已在剪貼簿上，立即嘗試清除
      if (field === "password") void clearClipboardIfUnchanged(text);
      return;
    }
    if (field === "password") scheduleClipboardClear(text);
    showCopyNotice(entryId, field, "copied");
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load() {
      if (started || disposed) return;
      started = true;
      try {
        const [entries, categories] = await Promise.all([storage.loadEntries(), storage.loadCategories()]);
        if (disposed) return;

        const displayCategories = withUncategorized(categories);
        const knownCategoryIds = new Set(displayCategories.map((category) => category.id));
        const redacted: Entry[] = entries.map((entry) => {
          secrets.set(entry.id, entry.password);
          return {
            ...entry,
            // AC4 保證不會有孤兒條目；仍於顯示層視為「未分類」（不寫回資料），確保排序前置條件成立
            categoryId: knownCategoryIds.has(entry.categoryId) ? entry.categoryId : UNCATEGORIZED_CATEGORY_ID,
            password: "",
          };
        });
        dispatch({ type: "LOADED", entries: redacted, categories: displayCategories });
      } catch (error) {
        if (!disposed) dispatch({ type: "LOAD_FAILED", error: loadErrorMessage(error) });
      }
    },

    setKeyword: (keyword) => dispatch({ type: "KEYWORD_CHANGED", keyword }),
    toggleCategory: (categoryId) => dispatch({ type: "CATEGORY_TOGGLED", categoryId }),
    clearFilter: () => dispatch({ type: "FILTER_CLEARED" }),
    resetQuery: () => dispatch({ type: "QUERY_RESET" }),
    setSortKey: (key) => dispatch({ type: "SORT_KEY_CHANGED", key }),
    toggleSortDirection: () => dispatch({ type: "SORT_DIRECTION_TOGGLED" }),

    revealPassword(entryId) {
      const password = secrets.get(entryId);
      if (state.phase !== "ready" || password === undefined) return;
      dispatch({ type: "PASSWORD_REVEALED", entryId, password });
    },

    hidePassword: (entryId) => dispatch({ type: "PASSWORD_HIDDEN", entryId }),

    copyPassword: (entryId) => copy(entryId, "password"),
    copyAccount: (entryId) => copy(entryId, "account"),

    dispose() {
      if (disposed) return;
      disposed = true;
      secrets.clear();
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = null;
      const pending = pendingClear;
      pendingClear = null;
      if (pending !== null) {
        clearTimeout(pending.timer);
        void clearClipboardIfUnchanged(pending.text);
      }
      dispatch({ type: "CLOSED" });
    },
  };
}
