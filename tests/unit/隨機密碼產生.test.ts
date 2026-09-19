import { describe, test, expect, vi, afterEach } from "vitest";
import { PASSWORD_CHARSET, PASSWORD_LENGTH, generatePassword } from "../../src/ui/entries/passwordGenerator";

/**
 * 模組：隨機密碼產生（UI 層純函式）
 * 使用者裁決：crypto.getRandomValues + rejection sampling，長度 20，字元集為大小寫字母、數字、符號。
 * 規格 §4.4 未涵蓋此功能，行為由本檔測試定義。
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("字元集與長度", () => {
  test("長度 20；字元集含大小寫字母、數字與符號且不重複", () => {
    expect(PASSWORD_LENGTH).toBe(20);
    expect(new Set(PASSWORD_CHARSET).size).toBe(PASSWORD_CHARSET.length);
    expect(/[A-Z]/.test(PASSWORD_CHARSET)).toBe(true);
    expect(/[a-z]/.test(PASSWORD_CHARSET)).toBe(true);
    expect(/[0-9]/.test(PASSWORD_CHARSET)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(PASSWORD_CHARSET)).toBe(true);
  });

  test("產生的密碼長度為 20，且每個字元都在字元集內", () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(20);
      for (const char of password) expect(PASSWORD_CHARSET).toContain(char);
    }
  });

  test("每次結果不同（真實亂數）", () => {
    const results = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(results.size).toBe(20);
  });
});

describe("亂數來源與 rejection sampling", () => {
  test("預設使用 crypto.getRandomValues", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    generatePassword();
    expect(spy).toHaveBeenCalled();
  });

  test("字元集長度不整除 256（否則 rejection sampling 無意義）", () => {
    expect(256 % PASSWORD_CHARSET.length).not.toBe(0);
  });

  test("落在不均勻區間的位元組被丟棄後重新取樣，不以取模硬湊", () => {
    const size = PASSWORD_CHARSET.length;
    const limit = 256 - (256 % size);
    let calls = 0;
    const random = (bytes: Uint8Array) => {
      calls += 1;
      // 第一批全部 ≥ limit（應全數丟棄），第二批全為 0
      bytes.fill(calls === 1 ? limit : 0);
      return bytes;
    };
    expect(generatePassword(random)).toBe(PASSWORD_CHARSET[0].repeat(20));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("位元組 < limit 時以取模映射到字元集", () => {
    const size = PASSWORD_CHARSET.length;
    const limit = 256 - (256 % size);
    const random = (bytes: Uint8Array) => {
      bytes.fill(limit - 1);
      return bytes;
    };
    expect(generatePassword(random)).toBe(PASSWORD_CHARSET[(limit - 1) % size].repeat(20));
  });
});
