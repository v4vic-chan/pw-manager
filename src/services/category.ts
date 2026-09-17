import type { Category } from "../types/Category";
import type { Entry } from "../types/Entry";

/** §4.3 分類管理模組：不存取 IndexedDB，接收目前狀態、回傳新狀態或待寫入資料，持久化交易由 storage.ts 負責 */

/** §3.5：系統預設「未分類」固定使用 nil UUID */
export const UNCATEGORIZED_CATEGORY_ID = "00000000-0000-0000-0000-000000000000";

/** §3.5：名稱長度下限（NFC 正規化後） */
const MIN_NAME_LENGTH = 1;

/** §3.5：名稱長度上限（NFC 正規化後） */
const MAX_NAME_LENGTH = 50;

/** §3.5：重名判斷比較鍵；不得使用 toLocaleLowerCase()，避免結果隨系統語系變動 */
function comparisonKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** §3.5：驗證長度並檢查是否與 existing 中其他分類重名（excludeId 用於重新命名時排除自己） */
function assertValidName(name: string, existing: Category[], excludeId?: string): string {
  const normalizedName = name.normalize("NFC");
  if (normalizedName.length < MIN_NAME_LENGTH || normalizedName.length > MAX_NAME_LENGTH) {
    throw new RangeError(
      `分類名稱長度須為 ${MIN_NAME_LENGTH}–${MAX_NAME_LENGTH}（§3.5），實際為 ${normalizedName.length}`
    );
  }

  if (normalizedName.trim().length === 0) {
    throw new RangeError("分類名稱去除前後空白後不可為空（純空白視為無意義名稱）");
  }

  const key = comparisonKey(normalizedName);
  const duplicate = existing.some(
    (category) => category.id !== excludeId && comparisonKey(category.name) === key
  );
  if (duplicate) {
    throw new Error(`分類名稱已存在（§3.5）：${name}`);
  }

  return normalizedName;
}

/** 新分類預設排列於使用者分類尾端（「未分類」固定 sortIndex = -1，不參與此計算） */
function nextSortIndex(existing: Category[]): number {
  const userCategorySortIndexes = existing
    .filter((category) => !category.isSystemDefault)
    .map((category) => category.sortIndex);
  return userCategorySortIndexes.length === 0 ? 0 : Math.max(...userCategorySortIndexes) + 1;
}

/** §4.3、§3.5：新增分類 */
export function createCategory(name: string, existing: Category[]): Category {
  const normalizedName = assertValidName(name, existing);

  return {
    id: crypto.randomUUID(),
    name: normalizedName,
    sortIndex: nextSortIndex(existing),
    isSystemDefault: false,
    createdAt: new Date().toISOString(),
  };
}

/** §4.3、§3.5：重新命名分類；「未分類」不可重新命名 */
export function renameCategory(categoryId: string, newName: string, existing: Category[]): Category {
  const target = existing.find((category) => category.id === categoryId);
  if (!target) {
    throw new RangeError(`找不到分類（§4.3）：${categoryId}`);
  }
  if (target.isSystemDefault) {
    throw new Error("系統預設「未分類」不可重新命名（§3.5）");
  }

  const normalizedName = assertValidName(newName, existing, categoryId);
  return { ...target, name: normalizedName };
}

/** §4.3：僅系統預設「未分類」不可刪除，其餘使用者分類皆可刪除（底下 Entry 由 reassignEntriesToUncategorized 處理轉移） */
export function canDeleteCategory(categoryId: string, categories: Category[]): boolean {
  const target = categories.find((category) => category.id === categoryId);
  return target !== undefined && !target.isSystemDefault;
}

/**
 * §3.5、§6 AC4：刪除分類時，所有參照該分類的 Entry 須轉移至「未分類」nil UUID，且不更新 updatedAt。
 * 純函式，僅回傳受影響（待更新）的 Entry 清單，不修改傳入陣列；實際與分類刪除的同一交易寫入由 storage.ts 負責。
 */
export function reassignEntriesToUncategorized(categoryId: string, entries: Entry[]): Entry[] {
  return entries
    .filter((entry) => entry.categoryId === categoryId)
    .map((entry) => ({ ...entry, categoryId: UNCATEGORIZED_CATEGORY_ID }));
}

/**
 * §4.3：拖曳調整使用者分類排序。輸入須僅為使用者分類（不含「未分類」，其 sortIndex 固定 -1 且不可調整）。
 * fromIndex/toIndex 為目前依 sortIndex 排序後的陣列位置；回傳依新順序重新指派 sortIndex（0 起算）後的清單。
 */
export function reorderCategories(categories: Category[], fromIndex: number, toIndex: number): Category[] {
  const ordered = [...categories].sort((a, b) => a.sortIndex - b.sortIndex);
  const [moved] = ordered.splice(fromIndex, 1);
  ordered.splice(toIndex, 0, moved);
  return ordered.map((category, index) => ({ ...category, sortIndex: index }));
}
