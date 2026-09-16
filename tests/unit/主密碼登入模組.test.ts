import { describe, test, expect } from "vitest";
import {
  setMasterPassword,
  verifyMasterPassword,
  getLoginLockoutState,
  recordLoginSuccess,
} from "../../src/services/masterPassword";
import type { FailureState, SecurityConfig } from "../../src/types/SecurityConfig";

/**
 * 模組：主密碼登入模組（規格 §4.1）
 * 對應驗收標準：§6 AC1（未通過主密碼驗證時明文不可存取）、
 * AC6（第 6 次失敗起遞增等待、封頂 60 秒、驗證成功後歸零）。
 *
 * TDD 紅燈說明：src/services/masterPassword.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

describe("setMasterPassword：首次設定主密碼（§4.1）", () => {
  test("happy path：長度 >= 12 的主密碼可成功設定，回傳的 SecurityConfig 形狀完整", async () => {
    const config: SecurityConfig = await setMasterPassword("correct horse battery");
    expect(typeof config.masterPasswordSalt).toBe("string");
    expect(config.twoFactorEnabled).toBe(false);
    expect(typeof config.kdfParams.memoryKiB).toBe("number");
    expect(typeof config.kdfParams.iterations).toBe("number");
    expect(typeof config.kdfParams.parallelism).toBe("number");
  });

  test("邊界：長度恰為 12 字元的主密碼可成功設定", async () => {
    await expect(setMasterPassword("123456789012")).resolves.toBeDefined();
  });

  test("邊界：長度為 11 字元的主密碼應被拒絕", async () => {
    await expect(setMasterPassword("12345678901")).rejects.toThrow();
  });

  test("異常路徑：空字串主密碼應被拒絕", async () => {
    await expect(setMasterPassword("")).rejects.toThrow();
  });
});

describe("verifyMasterPassword：主密碼驗證流程（§4.1）", () => {
  test("happy path：使用剛設定的主密碼驗證應成功", async () => {
    const config = await setMasterPassword("correct horse battery");
    await expect(
      verifyMasterPassword("correct horse battery", config)
    ).resolves.toBe(true);
  });

  test("異常路徑：錯誤的主密碼驗證應失敗（AC1 基礎：驗證未通過不可視為成功）", async () => {
    const config = await setMasterPassword("correct horse battery");
    await expect(
      verifyMasterPassword("wrong password entirely", config)
    ).resolves.toBe(false);
  });
});

/**
 * §4.1 失敗處理規則：
 * - 第 1–5 次失敗：僅計數，不設等待。
 * - 第 6 次起：等待秒數 = 2^(failedAttempts-5)，上限 60 秒。
 * - 驗證成功後歸零。
 * 「loginFailureState 持久化、重新整理頁面不重置」屬儲存層行為，不在本單元測試範圍。
 */
describe("getLoginLockoutState：連續失敗速率限制（§4.1、AC6）", () => {
  test("狀態轉換：失敗次數 0～5 次時僅計數，不進入等待", () => {
    for (let failures = 0; failures <= 5; failures++) {
      const state = getLoginLockoutState(failures);
      expect(state.locked).toBe(false);
      expect(state.waitSeconds).toBe(0);
    }
  });

  test("邊界：第 6 次失敗起進入鎖定，等待秒數為 2^(6-5) = 2", () => {
    const state = getLoginLockoutState(6);
    expect(state.locked).toBe(true);
    expect(state.waitSeconds).toBe(2);
  });

  test("狀態轉換：失敗次數 6→10 次，等待秒數依 2^(failedAttempts-5) 遞增為 2,4,8,16,32", () => {
    const expectedWaitSeconds = [2, 4, 8, 16, 32];
    for (let i = 0; i < expectedWaitSeconds.length; i++) {
      const failures = 6 + i;
      const state = getLoginLockoutState(failures);
      expect(state.locked).toBe(true);
      expect(state.waitSeconds).toBe(expectedWaitSeconds[i]);
    }
  });

  test("邊界：第 11 次失敗公式值為 2^6 = 64 秒，須封頂為 60 秒", () => {
    const state = getLoginLockoutState(11);
    expect(state.locked).toBe(true);
    expect(state.waitSeconds).toBe(60);
  });

  test("邊界：超過封頂門檻後等待秒數維持 60 秒，不再增加", () => {
    for (const failures of [12, 20, 100]) {
      const state = getLoginLockoutState(failures);
      expect(state.locked).toBe(true);
      expect(state.waitSeconds).toBe(60);
    }
  });
});

describe("recordLoginSuccess：驗證成功後計數歸零（§4.1、AC6）", () => {
  test("狀態轉換：鎖定中驗證成功後 failedAttempts 歸零、lockedUntil 清空", () => {
    const before: FailureState = {
      failedAttempts: 8,
      lockedUntil: "2026-09-16T00:00:08.000Z",
    };
    expect(recordLoginSuccess(before)).toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  test("狀態轉換：未達鎖定門檻時驗證成功，同樣回傳歸零狀態", () => {
    const before: FailureState = { failedAttempts: 3, lockedUntil: null };
    expect(recordLoginSuccess(before)).toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
  });
});
