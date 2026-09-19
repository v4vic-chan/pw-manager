import { filterByCategories, searchEntries, sortEntries, type SortDirection, type SortKey } from "../../services/search";
import type { Category } from "../../types/Category";
import type { Entry } from "../../types/Entry";

/**
 * 條目列表狀態機（純 reducer，不含副作用）。
 * 對應規格 §4.5 搜尋／排序／篩選（三者疊加）、§4.4 密碼顯示切換。
 * entries 為去識別化形態：password 恆為空字串；明文只會在使用者主動顯示時進入 revealed[entryId]。
 * 不適用於目前階段的事件一律忽略並回傳原狀態；closed 之後不再接受任何事件。
 */

export type CopyField = "password" | "account";

export interface CopyNotice {
  entryId: string;
  field: CopyField;
  status: "copied" | "failed";
}

export type EntriesState =
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | {
      phase: "ready";
      /** 去識別化條目（password 恆為空字串） */
      entries: Entry[];
      categories: Category[];
      /** 使用者輸入的原始關鍵字；比對時才做 NFC 正規化 */
      keyword: string;
      /** 勾選的分類（OR）；空陣列表示不篩選 */
      categoryIds: string[];
      sortKey: SortKey;
      sortDirection: SortDirection;
      /** 使用者主動顯示的明文密碼，以條目 id 為鍵；隱藏或關閉時移除 */
      revealed: Record<string, string>;
      copyNotice: CopyNotice | null;
    }
  | { phase: "closed" };

export type ReadyEntriesState = Extract<EntriesState, { phase: "ready" }>;

export type EntriesEvent =
  | { type: "LOADED"; entries: Entry[]; categories: Category[] }
  | { type: "LOAD_FAILED"; error: string }
  | { type: "KEYWORD_CHANGED"; keyword: string }
  | { type: "CATEGORY_TOGGLED"; categoryId: string }
  | { type: "FILTER_CLEARED" }
  | { type: "QUERY_RESET" }
  | { type: "SORT_KEY_CHANGED"; key: SortKey }
  | { type: "SORT_DIRECTION_TOGGLED" }
  | { type: "PASSWORD_REVEALED"; entryId: string; password: string }
  | { type: "PASSWORD_HIDDEN"; entryId: string }
  | { type: "COPY_NOTICE_SHOWN"; notice: CopyNotice }
  | { type: "COPY_NOTICE_CLEARED" }
  | { type: "CLOSED" };

export const DEFAULT_SORT_KEY: SortKey = "appName";
export const DEFAULT_SORT_DIRECTION: SortDirection = "asc";

export const initialEntriesState: EntriesState = { phase: "loading" };

export function reduceEntries(state: EntriesState, event: EntriesEvent): EntriesState {
  if (state.phase === "closed") return state;
  if (event.type === "CLOSED") return { phase: "closed" };

  switch (state.phase) {
    case "loading":
      if (event.type === "LOADED") {
        return {
          phase: "ready",
          entries: event.entries,
          categories: event.categories,
          keyword: "",
          categoryIds: [],
          sortKey: DEFAULT_SORT_KEY,
          sortDirection: DEFAULT_SORT_DIRECTION,
          revealed: {},
          copyNotice: null,
        };
      }
      if (event.type === "LOAD_FAILED") return { phase: "error", error: event.error };
      return state;

    case "error":
      return state;

    case "ready":
      return reduceReady(state, event);
  }
}

function reduceReady(state: ReadyEntriesState, event: EntriesEvent): EntriesState {
  switch (event.type) {
    case "KEYWORD_CHANGED":
      return event.keyword === state.keyword ? state : { ...state, keyword: event.keyword };

    case "CATEGORY_TOGGLED": {
      if (!state.categories.some((category) => category.id === event.categoryId)) return state;
      const categoryIds = state.categoryIds.includes(event.categoryId)
        ? state.categoryIds.filter((id) => id !== event.categoryId)
        : [...state.categoryIds, event.categoryId];
      return { ...state, categoryIds };
    }

    case "FILTER_CLEARED":
      return state.categoryIds.length === 0 ? state : { ...state, categoryIds: [] };

    case "QUERY_RESET":
      return state.keyword === "" && state.categoryIds.length === 0 ? state : { ...state, keyword: "", categoryIds: [] };

    case "SORT_KEY_CHANGED":
      return event.key === state.sortKey ? state : { ...state, sortKey: event.key };

    case "SORT_DIRECTION_TOGGLED":
      return { ...state, sortDirection: state.sortDirection === "asc" ? "desc" : "asc" };

    case "PASSWORD_REVEALED": {
      if (!state.entries.some((entry) => entry.id === event.entryId)) return state;
      if (hasRevealed(state, event.entryId) && state.revealed[event.entryId] === event.password) return state;
      return { ...state, revealed: { ...state.revealed, [event.entryId]: event.password } };
    }

    case "PASSWORD_HIDDEN":
      if (!hasRevealed(state, event.entryId)) return state;
      return {
        ...state,
        revealed: Object.fromEntries(Object.entries(state.revealed).filter(([entryId]) => entryId !== event.entryId)),
      };

    case "COPY_NOTICE_SHOWN":
      return { ...state, copyNotice: event.notice };

    case "COPY_NOTICE_CLEARED":
      return state.copyNotice === null ? state : { ...state, copyNotice: null };

    default:
      return state;
  }
}

/** 使用 own property 判斷，避免條目 id 與 Object.prototype 成員同名時誤判 */
export function hasRevealed(state: ReadyEntriesState, entryId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.revealed, entryId);
}

/**
 * §4.5、AC5：搜尋 → 分類篩選 → 排序，三者疊加。
 * 關鍵字比對前先做 NFC 正規化（資料寫入時已為 NFC，§3），不 trim；
 * 排序一律傳入 categories，確保 key="category" 的前置條件永遠成立。
 */
export function selectVisibleEntries(state: ReadyEntriesState): Entry[] {
  const searched = searchEntries(state.entries, state.keyword.normalize("NFC"));
  const filtered = filterByCategories(searched, state.categoryIds);
  return sortEntries(filtered, state.sortKey, state.sortDirection, state.categories);
}

/** 篩選選項：依 sortIndex 排序，「未分類」（sortIndex = -1，§3.5）恆居首 */
export function selectCategoryOptions(state: ReadyEntriesState): Category[] {
  return [...state.categories].sort((a, b) => a.sortIndex - b.sortIndex);
}
