import type { Category } from "../types/Category";
import type { Entry } from "../types/Entry";

/** §4.4 條目 CRUD 模組：不存取 IndexedDB，接收目前狀態、回傳新狀態，持久化交易由 storage.ts 負責 */

/** §3.3：appName 長度下限／上限（NFC 正規化後） */
const APP_NAME_MIN_LENGTH = 1;
const APP_NAME_MAX_LENGTH = 100;

/** §3.3：accountId 長度下限／上限（NFC 正規化後） */
const ACCOUNT_ID_MIN_LENGTH = 1;
const ACCOUNT_ID_MAX_LENGTH = 200;

/** §3.3：password 長度下限（明文，僅存於記憶體，不做 NFC 正規化） */
const PASSWORD_MIN_LENGTH = 1;

/** Entry 中使用者可寫入的四個欄位（§4.4：新增/編輯僅允許此四欄） */
export type EntryUserFields = Pick<Entry, "appName" | "categoryId" | "accountId" | "password">;

/** §3.3：appName 驗證並回傳 NFC 正規化後的值 */
function assertValidAppName(appName: string): string {
  const normalized = appName.normalize("NFC");
  if (normalized.length < APP_NAME_MIN_LENGTH || normalized.length > APP_NAME_MAX_LENGTH) {
    throw new RangeError(
      `appName 長度須為 ${APP_NAME_MIN_LENGTH}–${APP_NAME_MAX_LENGTH}（§3.3），實際為 ${normalized.length}`
    );
  }
  return normalized;
}

/** §3.3：accountId 驗證並回傳 NFC 正規化後的值 */
function assertValidAccountId(accountId: string): string {
  const normalized = accountId.normalize("NFC");
  if (normalized.length < ACCOUNT_ID_MIN_LENGTH || normalized.length > ACCOUNT_ID_MAX_LENGTH) {
    throw new RangeError(
      `accountId 長度須為 ${ACCOUNT_ID_MIN_LENGTH}–${ACCOUNT_ID_MAX_LENGTH}（§3.3），實際為 ${normalized.length}`
    );
  }
  return normalized;
}

/** §3.3：password 僅檢查非空；長度 < 8 的強度警示屬 UI 層職責，本層不阻擋儲存 */
function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new RangeError("password 不可為空（§3.3）");
  }
}

/** §3.3：categoryId 必須存在於呼叫端傳入的分類清單中（含「未分類」，由呼叫端保證清單完整性） */
function assertCategoryExists(categoryId: string, categories: Category[]): void {
  if (!categories.some((category) => category.id === categoryId)) {
    throw new RangeError(`categoryId 必須存在於系統分類清單中（§3.3）：${categoryId}`);
  }
}

/** §4.4、§3.3：新增條目，四個使用者欄位皆必填 */
export function createEntry(input: EntryUserFields, categories: Category[]): Entry {
  const appName = assertValidAppName(input.appName);
  const accountId = assertValidAccountId(input.accountId);
  assertValidPassword(input.password);
  assertCategoryExists(input.categoryId, categories);

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    appName,
    categoryId: input.categoryId,
    accountId,
    password: input.password,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * §4.4、§3.3：編輯條目。僅允許修改 appName/categoryId/accountId/password 四欄，
 * id 與 createdAt 不可變更；任一使用者欄位變更後更新 updatedAt。
 * categories 為選填：若提供且 changes 內含 categoryId，將驗證其存在於分類清單中；
 * 未提供時不做存在性驗證（由呼叫端保證合法性）。
 */
export function updateEntry(original: Entry, changes: Partial<EntryUserFields>, categories?: Category[]): Entry {
  const next: Entry = { ...original };
  let changed = false;

  if (changes.appName !== undefined) {
    const normalized = assertValidAppName(changes.appName);
    if (normalized !== original.appName) {
      next.appName = normalized;
      changed = true;
    }
  }
  if (changes.accountId !== undefined) {
    const normalized = assertValidAccountId(changes.accountId);
    if (normalized !== original.accountId) {
      next.accountId = normalized;
      changed = true;
    }
  }
  if (changes.password !== undefined) {
    assertValidPassword(changes.password);
    if (changes.password !== original.password) {
      next.password = changes.password;
      changed = true;
    }
  }
  if (changes.categoryId !== undefined) {
    if (categories !== undefined) {
      assertCategoryExists(changes.categoryId, categories);
    }
    if (changes.categoryId !== original.categoryId) {
      next.categoryId = changes.categoryId;
      changed = true;
    }
  }

  if (changed) {
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

/** §4.4：刪除條目，需二次確認（confirmed=true）；硬刪除，不提供復原機制 */
export function deleteEntry(entries: Entry[], entryId: string, confirmed: boolean): Entry[] {
  if (!confirmed) {
    return entries;
  }
  return entries.filter((entry) => entry.id !== entryId);
}
