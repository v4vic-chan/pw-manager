import { describe, test, expect } from "vitest";
import {
  generateTotpSecret,
  generateRecoveryCodes,
  canLogin,
  canDisableTwoFactor,
  useRecoveryCode,
} from "../../src/services/twoFactor";

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
