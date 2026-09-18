import {
  createCanaryPayload,
  deriveKeys,
  generateSalt,
  verifyCanaryPayload,
} from "../crypto/crypto";
import type { FailureState, KdfParams, SecurityConfig } from "../types/SecurityConfig";

/** §4.1 主密碼登入模組：不存取 IndexedDB，接收狀態、回傳新狀態，持久化由 Storage Layer 負責 */

/** §4.1：主密碼最短長度（UTF-16 code unit） */
const MIN_MASTER_PASSWORD_LENGTH = 12;

/** 首次設定未指定參數時採用 §5.1.1 最低參數 */
const DEFAULT_KDF_PARAMS: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

/** 目前程式碼支援的 cryptoVersion */
const CURRENT_CRYPTO_VERSION = 1;

/** §4.1：前 5 次失敗僅計數 */
const FREE_FAILED_ATTEMPTS = 5;

/** §4.1：等待秒數上限 */
const MAX_WAIT_SECONDS = 60;

export interface LoginLockoutState {
  locked: boolean;
  /** 距 lockedUntil 的剩餘秒數（無條件進位），未鎖定時為 0 */
  waitSeconds: number;
}

/** 驗證失敗時依 §4.1 已捨棄本次衍生的金鑰；canary 損毀與密碼錯誤無法區分，皆歸於 INVALID_MASTER_PASSWORD */
export type MasterPasswordVerification =
  | { ok: true; encryptionKey: CryptoKey }
  | { ok: false; reason: "INVALID_MASTER_PASSWORD" };

/** §4.1、AC11：首次設定與變更主密碼共用的長度規則 */
export function assertValidMasterPassword(password: string): void {
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new RangeError(
      `主密碼長度須 ≥ ${MIN_MASTER_PASSWORD_LENGTH} 字元（§4.1），實際為 ${password.length}`
    );
  }
}

/** §4.1 首次設定：組出初始 SecurityConfig（keyGeneration = 1、2FA 關閉、失敗計數歸零） */
export async function setMasterPassword(
  password: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS
): Promise<SecurityConfig> {
  assertValidMasterPassword(password);

  const masterPasswordSalt = await generateSalt();
  const encryptionKey = await deriveKeys(password, masterPasswordSalt, kdfParams);
  const canaryPayload = await createCanaryPayload(encryptionKey, CURRENT_CRYPTO_VERSION);

  return {
    masterPasswordSalt,
    canaryPayload,
    keyGeneration: 1,
    cryptoVersion: CURRENT_CRYPTO_VERSION,
    kdfParams: {
      memoryKiB: kdfParams.memoryKiB,
      iterations: kdfParams.iterations,
      parallelism: kdfParams.parallelism,
    },
    twoFactorEnabled: false,
    loginFailureState: { failedAttempts: 0, lockedUntil: null },
  };
}

/** §4.1 驗證流程：衍生 encryptionKey 後以 canaryPayload 比對 CANARY_PLAINTEXT，成功時交回金鑰供 session 保存 */
export async function verifyMasterPassword(
  password: string,
  securityConfig: SecurityConfig
): Promise<MasterPasswordVerification> {
  const encryptionKey = await deriveKeys(
    password,
    securityConfig.masterPasswordSalt,
    securityConfig.kdfParams
  );
  if (await verifyCanaryPayload(securityConfig.canaryPayload, encryptionKey)) {
    return { ok: true, encryptionKey };
  }
  return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
}

/** §4.1：第 6 次起等待 2^(failedAttempts-5) 秒，上限 60 秒 */
function lockoutWaitSeconds(failedAttempts: number): number {
  if (failedAttempts <= FREE_FAILED_ATTEMPTS) return 0;
  return Math.min(2 ** (failedAttempts - FREE_FAILED_ATTEMPTS), MAX_WAIT_SECONDS);
}

/** §4.1：failedAttempts ≥ 6 且 now 早於 lockedUntil 才鎖定；期滿解除不影響 failedAttempts */
export function getLoginLockoutState(state: FailureState, now: Date): LoginLockoutState {
  if (state.failedAttempts <= FREE_FAILED_ATTEMPTS || state.lockedUntil === null) {
    return { locked: false, waitSeconds: 0 };
  }
  const remainingMs = Date.parse(state.lockedUntil) - now.getTime();
  // lockedUntil 無法解析時 remainingMs 為 NaN，判定為未鎖定，下一次失敗會寫入有效的 lockedUntil
  if (!(remainingMs > 0)) {
    return { locked: false, waitSeconds: 0 };
  }
  return { locked: true, waitSeconds: Math.ceil(remainingMs / 1000) };
}

/** §4.1、§3.6：失敗次數 +1，進入等待時 lockedUntil = now + 等待秒數（ISO8601 UTC） */
export function recordLoginFailure(state: FailureState, now: Date): FailureState {
  const failedAttempts = state.failedAttempts + 1;
  const waitSeconds = lockoutWaitSeconds(failedAttempts);
  return {
    failedAttempts,
    lockedUntil: waitSeconds > 0 ? new Date(now.getTime() + waitSeconds * 1000).toISOString() : null,
  };
}

/** §4.1：驗證成功後歸零 */
export function recordLoginSuccess(_state: FailureState): FailureState {
  return { failedAttempts: 0, lockedUntil: null };
}
