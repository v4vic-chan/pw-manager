import QRCode from "qrcode";
import { generateSecret, generateURI, verify } from "otplib";
import {
  encryptPayload,
  decryptPayload,
  hashRecoveryCode,
  verifyRecoveryCode as verifyRecoveryCodeHash,
} from "../crypto/crypto";
import type { EncryptedPayload } from "../types/EncryptedPayload";
import type { RecoveryCode, SecurityConfig } from "../types/SecurityConfig";

/** §4.2 2FA 模組：不存取 IndexedDB，回傳待寫入的資料結構，持久化由 Storage Layer 負責 */

/** otpauth:// URI 的標示；本 App 為單機單一保險庫，無帳號概念，故為固定常數 */
const TOTP_ISSUER = "Password Keeper";
const TOTP_LABEL = "local-vault";

/** §4.2：救援碼組數（規格範圍 8–10） */
const RECOVERY_CODE_COUNT = 10;

/** §4.2：每組救援碼 8 bytes = 64 bits 熵，輸出為 16 個十六進位字元 */
const RECOVERY_CODE_BYTES = 8;

/** 救援碼顯示用分組長度 */
const RECOVERY_CODE_GROUP_SIZE = 4;

/** §4.2 開啟流程步驟 1–4 的記憶體內產出；secret 與 recoveryCodesPlaintext 僅供一次性顯示 */
export interface TwoFactorSetup {
  secret: string;
  qrCodeDataUrl: string;
  recoveryCodesPlaintext: string[];
  twoFactorSecretEncrypted: EncryptedPayload;
  recoveryCodes: RecoveryCode[];
}

/** §4.2 補發流程步驟 1 的產出；新舊切換時機由 Storage Layer 的單一交易決定 */
export interface RecoveryCodesBatch {
  recoveryCodesPlaintext: string[];
  recoveryCodes: RecoveryCode[];
  recoveryCodesRemainingWarningShown: false;
}

/** §4.2 步驟 5：確認綁定後待寫入的 SecurityConfig 欄位 */
export type TwoFactorEnableChanges = Required<
  Pick<
    SecurityConfig,
    | "twoFactorEnabled"
    | "twoFactorSecretEncrypted"
    | "recoveryCodes"
    | "recoveryCodesRemainingWarningShown"
  >
>;

export type ConfirmEnableTwoFactorResult =
  | { ok: true; changes: TwoFactorEnableChanges }
  | { ok: false; reason: "INVALID_TOTP_CODE" };

export type RecoveryCodeVerification =
  | { ok: true; recoveryCodes: RecoveryCode[] }
  | { ok: false; reason: "INVALID_RECOVERY_CODE"; recoveryCodes: RecoveryCode[] };

export type DisableTwoFactorResult =
  | { ok: true; securityConfig: SecurityConfig }
  | { ok: false; reason: "VERIFICATION_REQUIRED" };

/** §4.2 步驟 1：產生隨機 TOTP 秘鑰（Base32，僅存在於記憶體） */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** §4.2 步驟 3：比對前一律正規化為大寫並去除連字號與空白 */
function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** §4.2 步驟 3：8–10 組、每組 ≥ 64 bits 熵，顯示時以連字號分為 4 組 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
    const code = (hex.match(new RegExp(`.{${RECOVERY_CODE_GROUP_SIZE}}`, "g")) ?? []).join("-");
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** §4.2：第二因素為 TOTP 或一組已驗證通過並標記為已使用的救援碼，任一即可 */
export interface SecondFactorVerification {
  totpVerified: boolean;
  usedValidRecoveryCode?: boolean;
}

function secondFactorPassed(input: SecondFactorVerification): boolean {
  return input.totpVerified || input.usedValidRecoveryCode === true;
}

/** §4.2、AC2：主密碼未通過一律拒絕；2FA 開啟時另需第二因素通過 */
export function canLogin(
  input: SecondFactorVerification & { masterPasswordVerified: boolean; twoFactorEnabled: boolean }
): boolean {
  if (!input.masterPasswordVerified) return false;
  return !input.twoFactorEnabled || secondFactorPassed(input);
}

/** §4.2、AC7：關閉 2FA 需主密碼與第二因素雙重驗證通過 */
export function canDisableTwoFactor(
  input: SecondFactorVerification & { masterPasswordVerified: boolean }
): boolean {
  return input.masterPasswordVerified && secondFactorPassed(input);
}

/** §4.2：救援碼單次使用；記憶體內已使用集合由呼叫端持有，通過時將該碼記入集合 */
export function useRecoveryCode(codes: string[], usedCodes: Set<string>, code: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  const matched = codes.find((candidate) => normalizeRecoveryCode(candidate) === normalized);
  if (matched === undefined || usedCodes.has(matched)) return false;
  usedCodes.add(matched);
  return true;
}

async function hashRecoveryCodes(plaintextCodes: string[]): Promise<RecoveryCode[]> {
  return Promise.all(
    plaintextCodes.map(async (code) => ({
      ...(await hashRecoveryCode(normalizeRecoveryCode(code))),
      used: false,
    }))
  );
}

/** §4.2 步驟 1、3、4：產生秘鑰與救援碼，並備妥加密秘鑰與救援碼雜湊；此步驟尚未啟用 2FA */
export async function generateTwoFactorSetup(
  encryptionKey: CryptoKey,
  cryptoVersion: number
): Promise<TwoFactorSetup> {
  const secret = generateTotpSecret();
  const recoveryCodesPlaintext = generateRecoveryCodes();

  return {
    secret,
    qrCodeDataUrl: await QRCode.toDataURL(
      generateURI({ issuer: TOTP_ISSUER, label: TOTP_LABEL, secret })
    ),
    recoveryCodesPlaintext,
    twoFactorSecretEncrypted: await encryptPayload(secret, encryptionKey, cryptoVersion),
    recoveryCodes: await hashRecoveryCodes(recoveryCodesPlaintext),
  };
}

/** §4.2 步驟 2、5：驗證當下 TOTP 確認綁定成功後，才交出待寫入的 SecurityConfig 欄位 */
export async function confirmEnableTwoFactor(
  totpCode: string,
  pendingSetup: TwoFactorSetup
): Promise<ConfirmEnableTwoFactorResult> {
  const { valid } = await verify({ secret: pendingSetup.secret, token: totpCode });
  if (!valid) return { ok: false, reason: "INVALID_TOTP_CODE" };

  return {
    ok: true,
    changes: {
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: pendingSetup.twoFactorSecretEncrypted,
      recoveryCodes: pendingSetup.recoveryCodes,
      recoveryCodesRemainingWarningShown: false,
    },
  };
}

/** §4.2 登入流程：以 encryptionKey 解密秘鑰後驗證 TOTP */
export async function verifyTotp(
  code: string,
  twoFactorSecretEncrypted: EncryptedPayload,
  encryptionKey: CryptoKey
): Promise<boolean> {
  const secret = await decryptPayload(twoFactorSecretEncrypted, encryptionKey);
  const { valid } = await verify({ secret, token: code });
  return valid;
}

/** §4.2、§5.1.3：正規化後比對加鹽雜湊；通過時回傳將該碼標記 used 的新陣列，原陣列不變 */
export async function verifyRecoveryCode(
  code: string,
  recoveryCodes: RecoveryCode[]
): Promise<RecoveryCodeVerification> {
  const normalized = normalizeRecoveryCode(code);

  for (const [index, entry] of recoveryCodes.entries()) {
    if (entry.used) continue;
    if (!(await verifyRecoveryCodeHash(normalized, entry.codeHash, entry.salt))) continue;

    const updated = recoveryCodes.map((current, currentIndex) =>
      currentIndex === index ? { ...current, used: true } : { ...current }
    );
    return { ok: true, recoveryCodes: updated };
  }

  return { ok: false, reason: "INVALID_RECOVERY_CODE", recoveryCodes };
}

/** §4.2 關閉流程、AC7：雙重驗證通過後移除 2FA 相關欄位與 TOTP 失敗計數 */
export function disableTwoFactor(
  securityConfig: SecurityConfig,
  verification: SecondFactorVerification & { masterPasswordVerified: boolean }
): DisableTwoFactorResult {
  if (!canDisableTwoFactor(verification)) {
    return { ok: false, reason: "VERIFICATION_REQUIRED" };
  }

  const {
    twoFactorSecretEncrypted: _secret,
    recoveryCodes: _codes,
    recoveryCodesRemainingWarningShown: _warning,
    totpFailureState: _failures,
    ...rest
  } = securityConfig;

  return { ok: true, securityConfig: { ...rest, twoFactorEnabled: false } };
}

/** §4.2 補發流程步驟 1：僅產生新碼與雜湊，不處理新舊切換（屬 Storage Layer 交易職責） */
export async function regenerateRecoveryCodes(): Promise<RecoveryCodesBatch> {
  const recoveryCodesPlaintext = generateRecoveryCodes();

  return {
    recoveryCodesPlaintext,
    recoveryCodes: await hashRecoveryCodes(recoveryCodesPlaintext),
    recoveryCodesRemainingWarningShown: false,
  };
}
