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
} as const;

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
