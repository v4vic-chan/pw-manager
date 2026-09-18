import type { ImportErrorCode } from "../../services/importExport";
import type { StorageErrorCode } from "../../services/storage";

/** 登入／解鎖流程的使用者文案；錯誤碼一律以 Record 窮舉，新增錯誤碼時型別檢查會強制補上文案 */

export const MESSAGES = {
  bootFailed: "無法開啟本機資料庫，請確認瀏覽器允許使用 IndexedDB",
  setupTooShort: "主密碼至少需要 12 個字元",
  setupMismatch: "兩次輸入的主密碼不一致",
  setupCompleted: "主密碼已設定完成，請登入",
  /** §4.1 已知限制：驗證失敗時須提示可從備份檔匯入還原 */
  loginInvalid: "主密碼錯誤。若確認密碼無誤，資料可能已損毀，可從備份檔匯入還原。",
  totpInvalid: "驗證碼錯誤",
  recoveryCodeInvalid: "救援碼無效或已使用過",
  unexpected: "操作失敗，現有資料未被變更，請重試",
  /** §5.3：匯入前須明確警示整份覆蓋與主密碼變更 */
  importWarning: "匯入會清除並覆蓋此裝置上的所有資料，完成後主密碼將變為備份檔當時的主密碼",
  importSucceeded: "匯入完成，請以備份檔當時的主密碼登入",
  idleTimeout: "閒置逾時，已自動鎖定",
  loggedOut: "已登出",
} as const;

export function loginLockedMessage(seconds: number): string {
  return `嘗試次數過多，請於 ${seconds} 秒後再試`;
}

export function secondFactorLockedMessage(seconds: number): string {
  return `第二因素驗證嘗試次數過多，請於 ${seconds} 秒後再試`;
}

const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  CONFIRMATION_MISMATCH: "請輸入大寫的 OVERWRITE（不含空白）",
  CONFIRMATION_REQUIRED: "匯入許可已失效，請重新輸入確認字串",
  INVALID_FORMAT: "檔案格式不正確，不是有效的備份檔",
  UNSUPPORTED_VERSION: "此備份檔的版本較新，請先更新本應用程式後再匯入",
  DECRYPTION_FAILED: "備份檔當時的主密碼錯誤，或檔案已損毀（兩者無法區分）",
  INVALID_CONTENT: "備份檔內容不完整或已損毀，無法匯入",
};

const STORAGE_ERROR_MESSAGES: Record<StorageErrorCode, string> = {
  REKEY_IN_PROGRESS: "系統正在更新加密金鑰，請稍後再試",
  KEY_GENERATION_MISMATCH: "保險庫資料已在其他地方變更，請重新登入",
  NOT_AUTHENTICATED: "驗證已逾時，請重新輸入主密碼",
};

export function importErrorMessage(code: ImportErrorCode): string {
  return IMPORT_ERROR_MESSAGES[code];
}

export function storageErrorMessage(code: StorageErrorCode): string {
  return STORAGE_ERROR_MESSAGES[code];
}
