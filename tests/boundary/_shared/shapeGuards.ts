/**
 * 跨層邊界測試用的結構驗證輔助函式。
 * 欄位與約束直接對應 specs/password_manager_spec.md §3 資料契約 /
 * src/types/ 下的型態定義，僅做「形狀是否一致」判斷，不涉及業務邏輯
 * （例如分類是否存在、主密碼是否正確等，不在此檢查範圍）。
 */

/** 標準 Base64（含 padding），長度須為 4 的倍數 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 12 bytes 經 Base64 編碼恰為 16 個字元，無 padding */
const IV_12_BYTES_BASE64_PATTERN = /^[A-Za-z0-9+/]{16}$/;

/** Entry（§3.3）與 StoredEntryRecord（§3.4）共用、皆以明文儲存的欄位 */
function hasEntryCommonFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === "string" &&
    typeof v.appName === "string" &&
    v.appName.length >= 1 &&
    v.appName.length <= 100 &&
    typeof v.categoryId === "string" &&
    typeof v.accountId === "string" &&
    v.accountId.length >= 1 &&
    v.accountId.length <= 200 &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

export function isEncryptedPayloadShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ciphertext === "string" &&
    v.ciphertext.length % 4 === 0 &&
    BASE64_PATTERN.test(v.ciphertext) &&
    typeof v.iv === "string" &&
    IV_12_BYTES_BASE64_PATTERN.test(v.iv) &&
    typeof v.cryptoVersion === "number"
  );
}

/** Entry：記憶體中的解密形態，password 為明文字串 */
export function isEntryShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return hasEntryCommonFields(v) && typeof v.password === "string";
}

/** StoredEntryRecord：儲存加密形態，password 須為 EncryptedPayload */
export function isStoredEntryRecordShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return hasEntryCommonFields(v) && isEncryptedPayloadShape(v.password);
}

export function isCategoryShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    v.name.length >= 1 &&
    v.name.length <= 50 &&
    typeof v.sortIndex === "number" &&
    typeof v.isSystemDefault === "boolean" &&
    typeof v.createdAt === "string"
  );
}

function isFailureStateShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.failedAttempts === "number" &&
    (v.lockedUntil === null || typeof v.lockedUntil === "string")
  );
}

function isRecoveryCodeShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.codeHash === "string" &&
    typeof v.salt === "string" &&
    typeof v.used === "boolean"
  );
}

export function isSecurityConfigShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const kdfOk =
    typeof v.kdfParams === "object" &&
    v.kdfParams !== null &&
    typeof (v.kdfParams as Record<string, unknown>).memoryKiB === "number" &&
    typeof (v.kdfParams as Record<string, unknown>).iterations === "number" &&
    typeof (v.kdfParams as Record<string, unknown>).parallelism === "number";

  const optionalSecretOk =
    v.twoFactorSecretEncrypted === undefined ||
    isEncryptedPayloadShape(v.twoFactorSecretEncrypted);

  const optionalRecoveryCodesOk =
    v.recoveryCodes === undefined ||
    (Array.isArray(v.recoveryCodes) && v.recoveryCodes.every(isRecoveryCodeShape));

  const optionalWarningShownOk =
    v.recoveryCodesRemainingWarningShown === undefined ||
    typeof v.recoveryCodesRemainingWarningShown === "boolean";

  const optionalTotpFailureOk =
    v.totpFailureState === undefined || isFailureStateShape(v.totpFailureState);

  return (
    typeof v.masterPasswordSalt === "string" &&
    isEncryptedPayloadShape(v.canaryPayload) &&
    typeof v.keyGeneration === "number" &&
    typeof v.cryptoVersion === "number" &&
    typeof v.twoFactorEnabled === "boolean" &&
    isFailureStateShape(v.loginFailureState) &&
    optionalSecretOk &&
    optionalRecoveryCodesOk &&
    optionalWarningShownOk &&
    optionalTotpFailureOk &&
    kdfOk
  );
}
