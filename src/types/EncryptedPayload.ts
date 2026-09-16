/**
 * EncryptedPayload（通用加密資料格式）
 * 對應規格 §3.1 EncryptedPayload
 */
export interface EncryptedPayload {
  /** AES-256-GCM 加密輸出（含認證標籤），Base64 編碼 */
  ciphertext: string;

  /** 12 bytes 隨機亂數，Base64 編碼；每次加密重新產生，不可重複使用 */
  iv: string;

  /** 此密文使用的 KDF 與加密參數版本，對應 SecurityConfig.cryptoVersion */
  cryptoVersion: number;
}
