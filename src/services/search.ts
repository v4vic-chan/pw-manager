import type { Category } from "../types/Category";
import type { Entry } from "../types/Entry";

/** §4.5 搜尋、排序、篩選模組：不存取 IndexedDB，純函式，接收目前狀態、回傳篩選/排序後的結果，不修改傳入陣列 */

/**
 * §4.5：即時模糊搜尋，僅比對 appName、accountId（不含 password 等敏感欄位）。
 * 比對忽略大小寫（使用 toLowerCase()，不用 toLocaleLowerCase()，避免結果隨系統語系變動）。
 */
export function searchEntries(entries: Entry[], keyword: string): Entry[] {
  const normalizedKeyword = keyword.toLowerCase();
  return entries.filter(
    (entry) =>
      entry.appName.toLowerCase().includes(normalizedKeyword) ||
      entry.accountId.toLowerCase().includes(normalizedKeyword)
  );
}

/**
 * §4.5：依 categoryId 多選篩選，勾選項之間為 OR；與 searchEntries 疊加使用時由呼叫端串接即為 AND。
 * 未勾選任何分類（空陣列）視為未套用篩選，回傳全部條目。
 */
export function filterByCategories(entries: Entry[], categoryIds: string[]): Entry[] {
  if (categoryIds.length === 0) {
    return [...entries];
  }
  const idSet = new Set(categoryIds);
  return entries.filter((entry) => idSet.has(entry.categoryId));
}

export type SortKey = "appName" | "category" | "createdAt" | "updatedAt";
export type SortDirection = "asc" | "desc";

/** §4.5：字串比較一律使用 UTF-16 code unit（JS 預設 `<`/`>`），不得使用 localeCompare/Intl.Collator */
function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function primarySortValue(entry: Entry, key: SortKey, categoryNameById: Map<string, string>): string {
  switch (key) {
    case "appName":
      return entry.appName;
    case "category": {
      const name = categoryNameById.get(entry.categoryId);
      if (name === undefined) {
        throw new RangeError(`sortEntries key="category" 時找不到 categoryId 對應的分類（§4.5）：${entry.categoryId}`);
      }
      return name;
    }
    case "createdAt":
      return entry.createdAt;
    case "updatedAt":
      return entry.updatedAt;
  }
}

/**
 * §4.5：支援 appName、category（依 Category.name）、createdAt、updatedAt 四種排序鍵，正序/倒序切換。
 * 比較對象皆為 §3 規定寫入時已 NFC 正規化的值；排序鍵數值相同時，一律以 id 字串作為次要排序依據。
 * key="category" 時依 Category.name 字母序排序，必須提供 categories 才能查找分類名稱。
 */
export function sortEntries(
  entries: Entry[],
  key: SortKey,
  direction: SortDirection,
  categories?: Category[]
): Entry[] {
  if (key === "category" && categories === undefined) {
    throw new RangeError('sortEntries key="category" 時必須提供 categories 參數（§4.5）');
  }
  const categoryNameById = new Map((categories ?? []).map((category) => [category.id, category.name]));

  return [...entries].sort((a, b) => {
    const primary = compareCodeUnit(
      primarySortValue(a, key, categoryNameById),
      primarySortValue(b, key, categoryNameById)
    );
    const comparison = primary !== 0 ? primary : compareCodeUnit(a.id, b.id);
    return direction === "asc" ? comparison : -comparison;
  });
}
