import type { Category } from "../../types/Category";

/**
 * 條目／分類表單的即時驗證（純函式）：在送出前就提示錯誤，storage 層（services/）仍會再驗證一次。
 * services 的長度常數為 private，於此重複定義（規格 §3.3、§3.5），
 * 並由 tests/unit/條目表單驗證.test.ts 以真實 service 行為對照，防止兩邊漂移。
 */

/** §3.3：appName 長度上限（NFC 正規化後，下限 1） */
export const APP_NAME_MAX_LENGTH = 100;
/** §3.3：accountId 長度上限（NFC 正規化後，下限 1） */
export const ACCOUNT_ID_MAX_LENGTH = 200;
/** §3.5：分類名稱長度上限（NFC 正規化後，下限 1） */
export const CATEGORY_NAME_MAX_LENGTH = 50;
/** §3.3：password 長度 < 8 時 UI 須顯示強度警示（不阻擋儲存） */
const WEAK_PASSWORD_BELOW = 8;

export const DUPLICATE_CATEGORY_MESSAGE = "已有相同名稱的分類（不分大小寫）";

/** 使用者可填寫的四個欄位（§4.4）；表單輸入的明文只當參數傳遞，不保存於 UI 狀態 */
export interface EntryFormValues {
  appName: string;
  accountId: string;
  password: string;
  categoryId: string;
}

export type EntryFormField = keyof EntryFormValues;
export type EntryFormErrors = Partial<Record<EntryFormField, string>>;

export interface EntryFormValidationOptions {
  /** 編輯時密碼留空表示不變更，不視為錯誤 */
  mode: "create" | "edit";
  categories: Category[];
}

export function validateEntryForm(values: EntryFormValues, options: EntryFormValidationOptions): EntryFormErrors {
  const errors: EntryFormErrors = {};

  const appNameLength = values.appName.normalize("NFC").length;
  if (appNameLength < 1) errors.appName = "請輸入 App 名稱";
  else if (appNameLength > APP_NAME_MAX_LENGTH) errors.appName = `App 名稱最多 ${APP_NAME_MAX_LENGTH} 個字元`;

  const accountIdLength = values.accountId.normalize("NFC").length;
  if (accountIdLength < 1) errors.accountId = "請輸入帳號";
  else if (accountIdLength > ACCOUNT_ID_MAX_LENGTH) errors.accountId = `帳號最多 ${ACCOUNT_ID_MAX_LENGTH} 個字元`;

  // 密碼為明文、不做 NFC 正規化也不 trim（§3.3）
  if (options.mode === "create" && values.password.length < 1) errors.password = "請輸入密碼";

  if (!options.categories.some((category) => category.id === values.categoryId)) {
    errors.categoryId = "請選擇有效的分類";
  }
  return errors;
}

/** §3.5 重名判斷比較鍵：NFC → trim → toLowerCase（不得使用 toLocaleLowerCase） */
function categoryNameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/**
 * §3.5：分類名稱驗證，順序與 category.ts 一致（長度 → 純空白 → 重名）。
 * 重新命名時以 excludeId 排除自己；重名判斷含「未分類」。合法回傳 null。
 */
export function validateCategoryName(name: string, categories: Category[], excludeId?: string): string | null {
  const normalized = name.normalize("NFC");
  if (normalized.length < 1) return "請輸入分類名稱";
  if (normalized.length > CATEGORY_NAME_MAX_LENGTH) return `分類名稱最多 ${CATEGORY_NAME_MAX_LENGTH} 個字元`;
  if (normalized.trim().length === 0) return "分類名稱不可只有空白";

  const key = categoryNameKey(normalized);
  const duplicate = categories.some((category) => category.id !== excludeId && categoryNameKey(category.name) === key);
  return duplicate ? DUPLICATE_CATEGORY_MESSAGE : null;
}

export function isWeakPassword(password: string): boolean {
  return password.length > 0 && password.length < WEAK_PASSWORD_BELOW;
}
