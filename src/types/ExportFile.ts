import type { EncryptedPayload } from "./EncryptedPayload";
import type { KdfParams } from "./SecurityConfig";

/**
 * ExportFile.header（明文，不加密）
 * 衍生解密金鑰所需的參數，依密碼學原則本身不需保密。
 */
export interface ExportFileHeader {
  cryptoVersion: number;

  masterPasswordSalt: string;

  kdfParams: KdfParams;
}

/**
 * ExportFile（匯出檔案格式）
 * 對應規格 §3.2 ExportFile
 */
export interface ExportFile {
  /** 匯出檔案格式版本，與 cryptoVersion 分開追蹤 */
  formatVersion: number;

  header: ExportFileHeader;

  /**
   * 加密後的完整資料本體：所有 StoredEntryRecord、Category，以及 SecurityConfig 中
   * 除 header 已列出欄位、loginFailureState、totpFailureState 以外的其餘內容
   */
  encryptedBody: EncryptedPayload;
}
