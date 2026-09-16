import type { EncryptedPayload } from "./EncryptedPayload";

/**
 * kdfParams：Argon2id 參數。
 */
export interface KdfParams {
  /** Argon2id 記憶體用量，單位 KiB；最低參數基準：≥ 19456 */
  memoryKiB: number;

  /** 最低參數基準：≥ 2 */
  iterations: number;

  /** 最低參數基準：= 1 */
  parallelism: number;
}

/** 救援碼儲存形態（僅存加鹽雜湊，不可逆） */
export interface RecoveryCode {
  /** 救援碼的加鹽雜湊值 */
  codeHash: string;

  /** 對應此筆雜湊使用的隨機鹽 */
  salt: string;

  /** 是否已使用（每組僅能使用一次） */
  used: boolean;
}

/** 失敗計數狀態（持久化儲存） */
export interface FailureState {
  failedAttempts: number;

  /** ISO8601 timestamp，未鎖定時為 null */
  lockedUntil: string | null;
}

/**
 * SecurityConfig（安全設定，單例）
 * 對應規格 §3.6 SecurityConfig
 */
export interface SecurityConfig {
  /** Argon2id 用鹽，每次重新金鑰化一律重新產生 */
  masterPasswordSalt: string;

  /** 以 encryptionKey 加密固定明文常數的密文，僅用於主密碼驗證 */
  canaryPayload: EncryptedPayload;

  /** 金鑰世代計數，首次初始化為 1；每次重新金鑰化與匯入完成後遞增 */
  keyGeneration: number;

  /** KDF 參數與加密方案版本；僅於 KDF 參數或加密方案改變時遞增 */
  cryptoVersion: number;

  kdfParams: KdfParams;

  /** 預設 false，使用者可自行開關 */
  twoFactorEnabled: boolean;

  /** 僅當 twoFactorEnabled=true 時存在 */
  twoFactorSecretEncrypted?: EncryptedPayload;

  /** 8–10 組；僅當 twoFactorEnabled=true 時存在 */
  recoveryCodes?: RecoveryCode[];

  /** 剩餘碼數 ≤ 2 時是否已提示過使用者 */
  recoveryCodesRemainingWarningShown?: boolean;

  /** 主密碼登入失敗計數 */
  loginFailureState: FailureState;

  /** TOTP 與救援碼輸入失敗計數；僅當 twoFactorEnabled=true 時使用 */
  totpFailureState?: FailureState;
}
