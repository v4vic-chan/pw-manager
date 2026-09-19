import { StorageError } from "../../services/storage";
import { storageErrorMessage } from "../auth/messages";

/** 條目列表的使用者文案。內部錯誤訊息一律不外洩到畫面 */

/** 與 storage.ts 初始化時建立的系統分類名稱一致（§3.5）；僅在分類清單意外缺少「未分類」時作為顯示用後備 */
export const UNCATEGORIZED_NAME = "未分類";

/** 密碼遮罩：固定長度，避免洩漏密碼長度 */
export const PASSWORD_MASK = "••••••••";

export const ENTRIES_MESSAGES = {
  title: "密碼庫",
  loading: "載入中…",
  loadFailed: "無法載入條目，請重新整理後再試",
  /** 完全沒有條目（與 noMatchMessage 刻意不同，避免使用者誤以為資料不見了） */
  empty: "目前沒有任何條目",
  passwordCopied: "密碼已複製",
  accountCopied: "帳號已複製",
  copyFailed: "複製失敗，請手動複製",
  /** 送出前驗證未通過（欄位錯誤已標示在各欄位下方） */
  formInvalid: "請先修正標示的欄位",
  /** storage 層以 RangeError 拒絕（欄位規則不符）；UI 端驗證通過卻被拒時的後備文案 */
  validationRejected: "輸入內容不符合規則，請檢查欄位後再試",
  writeFailed: "操作失敗，現有資料未被變更，請重試",
  /** 寫入已成功，但重新讀取列表失敗：不可讓使用者以為寫入失敗而重複送出 */
  reloadFailed: "已儲存，但重新載入列表失敗，請重新整理頁面",
  /** session 失效時附加在對應文案後，說明接著會自動登出 */
  sessionLostSuffix: "（即將自動登出）",
  deleteEntryTitle: "刪除條目？",
  deleteEntryConfirm: "刪除",
  deleteCategoryConfirm: "刪除分類",
} as const;

export function deleteEntryMessage(appName: string, accountId: string): string {
  return `確定要刪除「${appName}」（${accountId}）嗎？此操作無法復原。`;
}

export function deleteCategoryTitle(name: string): string {
  return `刪除分類「${name}」？`;
}

/** §3.5、AC4：明確告知受影響條目會轉為「未分類」 */
export function deleteCategoryMessage(entryCount: number): string {
  return entryCount > 0
    ? `此分類下的 ${entryCount} 個條目將轉為「${UNCATEGORIZED_NAME}」，分類本身將被刪除，無法復原。`
    : "此分類下沒有條目，分類本身將被刪除，無法復原。";
}

export function noMatchMessage(total: number): string {
  return `沒有符合目前搜尋或篩選條件的條目（共 ${total} 筆條目未顯示）`;
}

export function countSummary(visible: number, total: number): string {
  return `顯示 ${visible} / 共 ${total} 筆`;
}

export function loadErrorMessage(error: unknown): string {
  if (error instanceof StorageError) return storageErrorMessage(error.code);
  return ENTRIES_MESSAGES.loadFailed;
}
