/** 安全設定畫面的使用者文案。內部錯誤訊息一律不外洩到畫面 */

export const SECURITY_MESSAGES = {
  title: "安全設定",
  loading: "載入中…",
  loadFailed: "無法載入安全設定，請重新整理後再試",
  writeFailed: "操作失敗，未做任何變更，請重試",
  downloadFailed: "無法下載檔案，請確認瀏覽器允許下載後重試",
  /** session 失效時附加在對應文案後，說明接著會自動登出 */
  sessionLostSuffix: "（即將自動登出）",

  // 變更主密碼（§4.1.2）
  currentPasswordRequired: "請輸入目前主密碼",
  newPasswordTooShort: "新主密碼至少需要 12 個字元",
  newPasswordMismatch: "兩次輸入的新主密碼不一致",
  newPasswordSameAsCurrent: "新主密碼不可與目前主密碼相同",
  currentPasswordInvalid: "目前主密碼錯誤",
  verifyingCurrentPassword: "正在驗證目前主密碼…",
  rekeying: "正在以新主密碼重新加密所有資料，請勿關閉或重新整理分頁…",
  passwordChanged: "主密碼已變更。先前匯出的備份檔仍需以舊主密碼還原，建議重新匯出備份。",

  // 共用驗證
  masterPasswordRequired: "請輸入主密碼",
  totpRequired: "請輸入驗證碼",
  recoveryCodeRequired: "請輸入救援碼",
  masterPasswordInvalid: "主密碼錯誤",
  totpInvalid: "驗證碼錯誤",
  recoveryCodeInvalid: "救援碼無效或已使用過",

  // 開啟 2FA（§4.2）
  preparingSetup: "正在產生秘鑰與救援碼…",
  enabling: "正在開啟兩步驟驗證…",
  enableTotpInvalid: "驗證碼錯誤，請確認驗證器 App 的時間正確、且已加入上方秘鑰後再試（兩步驟驗證尚未開啟）",
  twoFactorEnabled: "已開啟兩步驟驗證。下次登入時需要輸入驗證碼。",
  abandonEnable: "放棄後兩步驟驗證不會開啟，這批救援碼作廢。",
  enableAbandoned: "已放棄開啟兩步驟驗證，未做任何變更。",

  // 關閉 2FA（§4.2、AC7）
  disableWarning: "關閉後，登入僅靠主密碼保護；現有救援碼全部作廢；日後重新開啟需重新綁定驗證器。",
  disabling: "正在驗證並關閉兩步驟驗證…",
  twoFactorDisabled: "已關閉兩步驟驗證，登入僅靠主密碼保護。",

  // 補發救援碼（§4.2 兩段式）
  regenerateNote: "需要主密碼與驗證器 App 的驗證碼。若已遺失驗證器，請改用救援碼關閉兩步驟驗證，再重新開啟。",
  regenerateVerifying: "正在驗證並產生新救援碼…",
  codesNotYetActive: "新救援碼尚未生效。按下「確認取代」前，舊救援碼仍然有效。",
  committingCodes: "正在以新救援碼取代舊救援碼…",
  commitFailedSuffix: "（新救援碼未生效，舊救援碼仍然有效）",
  abandonRegenerate: "放棄後新救援碼作廢，舊救援碼仍然有效。",
  regenerateAbandoned: "已放棄補發，舊救援碼仍然有效。",
  codesReplaced: "已補發新救援碼，舊救援碼已全部失效。",

  // 匯出（§5.3）
  exportExplanation:
    "匯出的是加密備份檔，不是明文。還原時需要輸入「匯出當下的主密碼」；之後即使變更主密碼，這份檔案仍需舊密碼才能還原。",
  exporting: "正在產生加密備份…",
} as const;

export function changePasswordFailed(reason: string): string {
  return `主密碼未變更：${reason}`;
}

export function acknowledgeLabel(count: number): string {
  return `我已將這 ${count} 組救援碼抄錄或下載，並存放在安全的地方`;
}

export function lowRecoveryCodesMessage(count: number): string {
  return `剩餘未使用的救援碼僅 ${count} 組，建議補發`;
}

export function twoFactorStatusText(enabled: boolean, unusedRecoveryCodes: number): string {
  return enabled ? `已開啟（剩餘 ${unusedRecoveryCodes} 組未使用的救援碼）` : "未開啟";
}

export function lockedMessage(seconds: number): string {
  return `驗證嘗試次數過多，請於 ${seconds} 秒後再試`;
}

export function exportedMessage(fileName: string): string {
  return `已下載加密備份檔：${fileName}`;
}
