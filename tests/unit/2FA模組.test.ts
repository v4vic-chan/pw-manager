import { describe, test, expect } from "vitest";
import { generate } from "otplib";
import {
  generateTotpSecret,
  generateRecoveryCodes,
  canLogin,
  canDisableTwoFactor,
  useRecoveryCode,
  generateTwoFactorSetup,
  confirmEnableTwoFactor,
  verifyTotp,
  verifyRecoveryCode,
  disableTwoFactor,
  regenerateRecoveryCodes,
} from "../../src/services/twoFactor";
import { decryptPayload, deriveKeys, generateSalt } from "../../src/crypto/crypto";
import type { KdfParams, SecurityConfig } from "../../src/types/SecurityConfig";

/**
 * 模組：2FA 模組（規格 §4.2）
 * 對應驗收標準：§6 AC2（僅主密碼正確而 TOTP 錯誤時登入必須被拒絕）。
 * TOTP 驗證碼本身的產生/驗證演算法由 `otplib`（§2.1）負責，非本模組職責，
 * 此處僅測試本模組定義的流程決策邏輯（登入放行條件、關閉條件、救援碼單次使用）。
 *
 * TDD 紅燈說明：src/services/twoFactor.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

describe("generateTotpSecret：開啟流程產生秘鑰（§4.2）", () => {
  test("happy path：回傳非空字串秘鑰", () => {
    const secret = generateTotpSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(0);
  });
});

describe("generateRecoveryCodes：一次性備援救援碼（§4.2）", () => {
  test("邊界：產生的救援碼組數落在建議範圍 8–10 組之間", () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBeGreaterThanOrEqual(8);
    expect(codes.length).toBeLessThanOrEqual(10);
  });

  test("happy path：每組救援碼皆為不重複的字串", () => {
    const codes = generateRecoveryCodes();
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe("canLogin：登入流程放行條件（§4.2、AC2）", () => {
  test("happy path：2FA 未開啟且主密碼正確 -> 允許登入", () => {
    expect(canLogin({ masterPasswordVerified: true, twoFactorEnabled: false, totpVerified: false })).toBe(true);
  });

  test("happy path：2FA 開啟且主密碼與 TOTP 皆正確 -> 允許登入", () => {
    expect(canLogin({ masterPasswordVerified: true, twoFactorEnabled: true, totpVerified: true })).toBe(true);
  });

  test("AC2：2FA 開啟，主密碼正確但 TOTP 錯誤 -> 登入必須被拒絕", () => {
    expect(canLogin({ masterPasswordVerified: true, twoFactorEnabled: true, totpVerified: false })).toBe(false);
  });

  test("異常路徑：主密碼未通過時，無論 2FA 狀態一律拒絕登入", () => {
    expect(canLogin({ masterPasswordVerified: false, twoFactorEnabled: false, totpVerified: false })).toBe(false);
    expect(canLogin({ masterPasswordVerified: false, twoFactorEnabled: true, totpVerified: true })).toBe(false);
  });

  test("§4.2：2FA 開啟，TOTP 未驗證但已使用有效救援碼 -> 允許登入", () => {
    expect(
      canLogin({
        masterPasswordVerified: true,
        twoFactorEnabled: true,
        totpVerified: false,
        usedValidRecoveryCode: true,
      })
    ).toBe(true);
  });

  test("異常路徑：主密碼未通過時，即使已使用有效救援碼仍拒絕登入", () => {
    expect(
      canLogin({
        masterPasswordVerified: false,
        twoFactorEnabled: true,
        totpVerified: false,
        usedValidRecoveryCode: true,
      })
    ).toBe(false);
  });
});

describe("canDisableTwoFactor：關閉流程需雙重驗證（§4.2）", () => {
  test("狀態轉換：僅主密碼通過、尚未通過 TOTP -> 不可關閉", () => {
    expect(canDisableTwoFactor({ masterPasswordVerified: true, totpVerified: false })).toBe(false);
  });

  test("狀態轉換：主密碼與 TOTP 皆通過後 -> 可關閉", () => {
    expect(canDisableTwoFactor({ masterPasswordVerified: true, totpVerified: true })).toBe(true);
  });

  test("異常路徑：僅 TOTP 通過但主密碼未通過 -> 不可關閉", () => {
    expect(canDisableTwoFactor({ masterPasswordVerified: false, totpVerified: true })).toBe(false);
  });

  test("§4.2、AC7：主密碼通過、TOTP 未驗證但已使用有效救援碼 -> 可關閉", () => {
    expect(
      canDisableTwoFactor({
        masterPasswordVerified: true,
        totpVerified: false,
        usedValidRecoveryCode: true,
      })
    ).toBe(true);
  });

  test("異常路徑：已使用有效救援碼但主密碼未通過 -> 不可關閉", () => {
    expect(
      canDisableTwoFactor({
        masterPasswordVerified: false,
        totpVerified: false,
        usedValidRecoveryCode: true,
      })
    ).toBe(false);
  });
});

describe("useRecoveryCode：救援碼單次使用（§4.2）", () => {
  test("狀態轉換：救援碼第一次使用成功，第二次使用同一組碼應失敗", () => {
    const codes = generateRecoveryCodes();
    const target = codes[0];
    const usedCodes = new Set<string>();

    const firstUse = useRecoveryCode(codes, usedCodes, target);
    expect(firstUse).toBe(true);

    const secondUse = useRecoveryCode(codes, usedCodes, target);
    expect(secondUse).toBe(false);
  });
});

/**
 * 以下為開啟／關閉／補發的完整流程函式（§4.2 步驟 1–6、補發流程）。
 * 一律不觸及 IndexedDB：回傳待寫入的資料結構，持久化由 Storage Layer 負責。
 */

const MIN_KDF_PARAMS: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const CRYPTO_VERSION = 1;
const RECOVERY_CODE_FORMAT = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

let cachedKey: CryptoKey | undefined;
async function testEncryptionKey(): Promise<CryptoKey> {
  if (cachedKey === undefined) {
    cachedKey = await deriveKeys("test master password", await generateSalt(), MIN_KDF_PARAMS);
  }
  return cachedKey;
}

function wrongCodeFor(validCode: string): string {
  return validCode === "000000" ? "111111" : "000000";
}

function baseSecurityConfig(): SecurityConfig {
  return {
    masterPasswordSalt: "c2FsdC1iYXNlNjQtMTZieXRlcw==",
    canaryPayload: { ciphertext: "Y2lwaGVy", iv: "aXYtMTJieXRlcw==", cryptoVersion: CRYPTO_VERSION },
    keyGeneration: 1,
    cryptoVersion: CRYPTO_VERSION,
    kdfParams: MIN_KDF_PARAMS,
    twoFactorEnabled: true,
    twoFactorSecretEncrypted: {
      ciphertext: "c2VjcmV0",
      iv: "aXYtMTJieXRlcw==",
      cryptoVersion: CRYPTO_VERSION,
    },
    recoveryCodes: [{ codeHash: "aGFzaA==", salt: "c2FsdA==", used: false }],
    recoveryCodesRemainingWarningShown: true,
    loginFailureState: { failedAttempts: 0, lockedUntil: null },
    totpFailureState: { failedAttempts: 3, lockedUntil: null },
  };
}

describe("generateTwoFactorSetup：開啟流程步驟 1、3、4 的記憶體內運算（§4.2）", () => {
  test("happy path：回傳明文秘鑰、QR code data URL、救援碼明文與待寫入的加密/雜湊結果", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);

    expect(setup.secret.length).toBeGreaterThan(0);
    expect(setup.qrCodeDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(setup.recoveryCodesPlaintext.length).toBeGreaterThanOrEqual(8);
    expect(setup.recoveryCodesPlaintext.length).toBeLessThanOrEqual(10);
    expect(setup.recoveryCodes).toHaveLength(setup.recoveryCodesPlaintext.length);
    expect(setup.recoveryCodes.every((entry) => entry.used === false)).toBe(true);
    expect(setup.recoveryCodes.every((entry) => entry.codeHash.length > 0 && entry.salt.length > 0)).toBe(true);
  });

  test("§2.3：TOTP 秘鑰以 EncryptedPayload 形式交付，密文不等於明文且可用同一把金鑰還原", async () => {
    const key = await testEncryptionKey();
    const setup = await generateTwoFactorSetup(key, CRYPTO_VERSION);

    expect(setup.twoFactorSecretEncrypted.cryptoVersion).toBe(CRYPTO_VERSION);
    expect(setup.twoFactorSecretEncrypted.ciphertext).not.toBe(setup.secret);
    expect(await decryptPayload(setup.twoFactorSecretEncrypted, key)).toBe(setup.secret);
  });

  test("每組救援碼皆為不重複的 16 碼十六進位、以連字號分為 4 組", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);

    expect(setup.recoveryCodesPlaintext.every((code) => RECOVERY_CODE_FORMAT.test(code))).toBe(true);
    expect(new Set(setup.recoveryCodesPlaintext).size).toBe(setup.recoveryCodesPlaintext.length);
  });
});

describe("confirmEnableTwoFactor：驗證裝置綁定後才完成啟用（§4.2 步驟 2、5）", () => {
  test("happy path：TOTP 正確時回傳待寫入的 SecurityConfig 欄位", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const result = await confirmEnableTwoFactor(await generate({ secret: setup.secret }), setup);

    if (!result.ok) throw new Error("預期確認成功");
    expect(result.changes).toEqual({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: setup.twoFactorSecretEncrypted,
      recoveryCodes: setup.recoveryCodes,
      recoveryCodesRemainingWarningShown: false,
    });
  });

  test("異常路徑：TOTP 錯誤時不完成啟用，回傳 INVALID_TOTP_CODE", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const validCode = await generate({ secret: setup.secret });
    const result = await confirmEnableTwoFactor(wrongCodeFor(validCode), setup);

    expect(result).toEqual({ ok: false, reason: "INVALID_TOTP_CODE" });
  });
});

describe("verifyTotp：解密秘鑰後驗證驗證碼（§4.2 登入流程）", () => {
  test("happy path：當前驗證碼通過驗證", async () => {
    const key = await testEncryptionKey();
    const setup = await generateTwoFactorSetup(key, CRYPTO_VERSION);
    const code = await generate({ secret: setup.secret });

    expect(await verifyTotp(code, setup.twoFactorSecretEncrypted, key)).toBe(true);
  });

  test("AC2：錯誤驗證碼一律不通過", async () => {
    const key = await testEncryptionKey();
    const setup = await generateTwoFactorSetup(key, CRYPTO_VERSION);
    const validCode = await generate({ secret: setup.secret });

    expect(await verifyTotp(wrongCodeFor(validCode), setup.twoFactorSecretEncrypted, key)).toBe(false);
  });
});

describe("verifyRecoveryCode：救援碼驗證與單次使用（§4.2、§5.1.3）", () => {
  test("happy path：正確救援碼通過驗證，回傳的陣列中該碼標記 used = true", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const result = await verifyRecoveryCode(setup.recoveryCodesPlaintext[1], setup.recoveryCodes);

    if (!result.ok) throw new Error("預期驗證成功");
    expect(result.recoveryCodes[1].used).toBe(true);
    expect(result.recoveryCodes.filter((entry) => entry.used)).toHaveLength(1);
  });

  test("§4.2：比對前正規化，小寫與去除連字號空白的輸入同樣通過", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const messyInput = ` ${setup.recoveryCodesPlaintext[0].toLowerCase().replace(/-/g, "")} `;

    const result = await verifyRecoveryCode(messyInput, setup.recoveryCodes);
    expect(result.ok).toBe(true);
  });

  test("狀態轉換：已使用過的救援碼不可再次使用", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const target = setup.recoveryCodesPlaintext[0];

    const firstUse = await verifyRecoveryCode(target, setup.recoveryCodes);
    if (!firstUse.ok) throw new Error("預期首次驗證成功");
    const secondUse = await verifyRecoveryCode(target, firstUse.recoveryCodes);

    expect(secondUse.ok).toBe(false);
  });

  test("異常路徑：不存在的救援碼回傳失敗與未變動的陣列", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const result = await verifyRecoveryCode("0000-0000-0000-0000", setup.recoveryCodes);

    expect(result.ok).toBe(false);
    expect(result.recoveryCodes).toEqual(setup.recoveryCodes);
  });

  test("無副作用：不修改傳入的 recoveryCodes 陣列", async () => {
    const setup = await generateTwoFactorSetup(await testEncryptionKey(), CRYPTO_VERSION);
    const snapshot = structuredClone(setup.recoveryCodes);

    await verifyRecoveryCode(setup.recoveryCodesPlaintext[0], setup.recoveryCodes);
    expect(setup.recoveryCodes).toEqual(snapshot);
  });
});

describe("disableTwoFactor：雙重驗證通過後清除 2FA 狀態（§4.2、AC7）", () => {
  test("happy path：驗證通過後移除秘鑰、救援碼、提示旗標與 TOTP 失敗計數", () => {
    const result = disableTwoFactor(baseSecurityConfig(), {
      masterPasswordVerified: true,
      totpVerified: true,
    });

    if (!result.ok) throw new Error("預期可關閉 2FA");
    expect(result.securityConfig.twoFactorEnabled).toBe(false);
    expect("twoFactorSecretEncrypted" in result.securityConfig).toBe(false);
    expect("recoveryCodes" in result.securityConfig).toBe(false);
    expect("recoveryCodesRemainingWarningShown" in result.securityConfig).toBe(false);
    expect("totpFailureState" in result.securityConfig).toBe(false);
  });

  test("其餘 SecurityConfig 欄位維持不變", () => {
    const before = baseSecurityConfig();
    const result = disableTwoFactor(before, { masterPasswordVerified: true, totpVerified: true });

    if (!result.ok) throw new Error("預期可關閉 2FA");
    expect(result.securityConfig.masterPasswordSalt).toBe(before.masterPasswordSalt);
    expect(result.securityConfig.canaryPayload).toEqual(before.canaryPayload);
    expect(result.securityConfig.keyGeneration).toBe(before.keyGeneration);
    expect(result.securityConfig.cryptoVersion).toBe(before.cryptoVersion);
    expect(result.securityConfig.loginFailureState).toEqual(before.loginFailureState);
  });

  test("§4.2、AC7：以未使用的救援碼取代 TOTP 完成第二因素驗證，同樣可關閉", () => {
    const result = disableTwoFactor(baseSecurityConfig(), {
      masterPasswordVerified: true,
      totpVerified: false,
      usedValidRecoveryCode: true,
    });

    if (!result.ok) throw new Error("預期可關閉 2FA");
    expect(result.securityConfig.twoFactorEnabled).toBe(false);
    expect("recoveryCodes" in result.securityConfig).toBe(false);
  });

  test("異常路徑：僅主密碼通過、TOTP 與救援碼皆未通過時拒絕關閉", () => {
    expect(
      disableTwoFactor(baseSecurityConfig(), { masterPasswordVerified: true, totpVerified: false })
    ).toEqual({ ok: false, reason: "VERIFICATION_REQUIRED" });
  });

  test("異常路徑：僅 TOTP 通過、主密碼未通過時拒絕關閉", () => {
    expect(
      disableTwoFactor(baseSecurityConfig(), { masterPasswordVerified: false, totpVerified: true })
    ).toEqual({ ok: false, reason: "VERIFICATION_REQUIRED" });
  });

  test("無副作用：不修改傳入的 SecurityConfig", () => {
    const before = baseSecurityConfig();
    const snapshot = structuredClone(before);

    disableTwoFactor(before, { masterPasswordVerified: true, totpVerified: true });
    expect(before).toEqual(snapshot);
  });
});

describe("regenerateRecoveryCodes：救援碼補發（§4.2 補發流程步驟 1）", () => {
  test("happy path：產生新一批未使用的救援碼與雜湊，並重置提示旗標", async () => {
    const batch = await regenerateRecoveryCodes();

    expect(batch.recoveryCodesPlaintext.length).toBeGreaterThanOrEqual(8);
    expect(batch.recoveryCodesPlaintext.length).toBeLessThanOrEqual(10);
    expect(batch.recoveryCodesPlaintext.every((code) => RECOVERY_CODE_FORMAT.test(code))).toBe(true);
    expect(batch.recoveryCodes).toHaveLength(batch.recoveryCodesPlaintext.length);
    expect(batch.recoveryCodes.every((entry) => entry.used === false)).toBe(true);
    expect(batch.recoveryCodesRemainingWarningShown).toBe(false);
  });

  test("補發的新碼與前一批不重複", async () => {
    const first = await regenerateRecoveryCodes();
    const second = await regenerateRecoveryCodes();
    const overlap = second.recoveryCodesPlaintext.filter((code) =>
      first.recoveryCodesPlaintext.includes(code)
    );

    expect(overlap).toHaveLength(0);
  });
});
