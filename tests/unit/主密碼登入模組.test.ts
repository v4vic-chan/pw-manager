import { describe, test, expect } from "vitest";
import {
  setMasterPassword,
  verifyMasterPassword,
  getLoginLockoutState,
  recordLoginFailure,
  recordLoginSuccess,
} from "../../src/services/masterPassword";
import { verifyCanaryPayload } from "../../src/crypto/crypto";
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
  test("happy path：驗證成功時回傳 ok: true 與本次衍生的 encryptionKey（non-extractable AES-GCM 256）", async () => {
    const config = await setMasterPassword("correct horse battery");
    const result = await verifyMasterPassword("correct horse battery", config);
    if (!result.ok) throw new Error("預期驗證成功");
    expect(result.encryptionKey.extractable).toBe(false);
    expect(result.encryptionKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(await verifyCanaryPayload(config.canaryPayload, result.encryptionKey)).toBe(true);
  });

  test("異常路徑：錯誤的主密碼回傳 ok: false 與 INVALID_MASTER_PASSWORD，不拋錯、不帶出 encryptionKey（AC1 基礎）", async () => {
    const config = await setMasterPassword("correct horse battery");
    const result = await verifyMasterPassword("wrong password entirely", config);
    expect(result).toEqual({ ok: false, reason: "INVALID_MASTER_PASSWORD" });
    expect("encryptionKey" in result).toBe(false);
  });
});

/**
 * §4.1 失敗處理：第 1–5 次僅計數；第 6 次起等待 2^(failedAttempts-5) 秒（上限 60）；驗證成功後歸零。
 * getLoginLockoutState(state, now)：failedAttempts ≥ 6 且 now 早於 lockedUntil 才鎖定，waitSeconds 為剩餘秒數（無條件進位）。
 * 等待秒數公式由 recordLoginFailure 的測試涵蓋；持久化屬儲存層行為，不在本單元測試範圍。
 */
describe("getLoginLockoutState：依 lockedUntil 與目前時間判斷是否仍在等待中（§4.1、AC6）", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");

  test("狀態轉換：失敗次數 0～5 次時不進入等待", () => {
    for (let failures = 0; failures <= 5; failures++) {
      expect(getLoginLockoutState({ failedAttempts: failures, lockedUntil: null }, now)).toEqual({
        locked: false,
        waitSeconds: 0,
      });
    }
  });

  test("happy path：第 6 次起且目前時間早於 lockedUntil，鎖定並回傳剩餘秒數", () => {
    expect(
      getLoginLockoutState({ failedAttempts: 10, lockedUntil: "2026-09-16T00:00:32.000Z" }, now)
    ).toEqual({ locked: true, waitSeconds: 32 });
  });

  test("邊界：剩餘時間不足整秒時無條件進位，鎖定期間 waitSeconds 不為 0", () => {
    expect(
      getLoginLockoutState({ failedAttempts: 6, lockedUntil: "2026-09-16T00:00:00.001Z" }, now)
    ).toEqual({ locked: true, waitSeconds: 1 });
    expect(
      getLoginLockoutState({ failedAttempts: 6, lockedUntil: "2026-09-16T00:00:01.500Z" }, now)
    ).toEqual({ locked: true, waitSeconds: 2 });
  });

  test("邊界：目前時間恰等於 lockedUntil 時解除鎖定", () => {
    expect(
      getLoginLockoutState({ failedAttempts: 6, lockedUntil: "2026-09-16T00:00:00.000Z" }, now)
    ).toEqual({ locked: false, waitSeconds: 0 });
  });

  test("狀態轉換：等待時間已過即解除鎖定，不因 failedAttempts 仍 ≥ 6 而永久鎖定", () => {
    expect(
      getLoginLockoutState({ failedAttempts: 20, lockedUntil: "2026-09-15T23:59:00.000Z" }, now)
    ).toEqual({ locked: false, waitSeconds: 0 });
  });

  test("不一致狀態：failedAttempts ≥ 6 但 lockedUntil 為 null，不鎖定", () => {
    expect(getLoginLockoutState({ failedAttempts: 8, lockedUntil: null }, now)).toEqual({
      locked: false,
      waitSeconds: 0,
    });
  });

  test("不一致狀態：failedAttempts < 6 但 lockedUntil 在未來，不鎖定", () => {
    expect(
      getLoginLockoutState({ failedAttempts: 3, lockedUntil: "2026-09-16T00:00:30.000Z" }, now)
    ).toEqual({ locked: false, waitSeconds: 0 });
  });

  test("無副作用：不修改傳入的 state，解除鎖定不會歸零 failedAttempts", () => {
    const before: FailureState = { failedAttempts: 7, lockedUntil: "2026-09-15T23:59:00.000Z" };
    getLoginLockoutState(before, now);
    expect(before).toEqual({ failedAttempts: 7, lockedUntil: "2026-09-15T23:59:00.000Z" });
  });
});

/**
 * recordLoginFailure(state, now)：純函式，now 由呼叫端注入。
 * lockedUntil = now + min(2^(新失敗次數-5), 60) 秒（ISO8601 UTC Z），新失敗次數 ≤ 5 時為 null。
 */
describe("recordLoginFailure：驗證失敗後累加計數並設定等待截止時間（§4.1、§3.6、AC6）", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");

  test("狀態轉換：首次失敗，failedAttempts 0→1，不設等待", () => {
    expect(recordLoginFailure({ failedAttempts: 0, lockedUntil: null }, now)).toEqual({
      failedAttempts: 1,
      lockedUntil: null,
    });
  });

  test("邊界：第 5 次失敗仍僅計數，lockedUntil 為 null", () => {
    expect(recordLoginFailure({ failedAttempts: 4, lockedUntil: null }, now)).toEqual({
      failedAttempts: 5,
      lockedUntil: null,
    });
  });

  test("邊界：第 6 次失敗起設定 lockedUntil = now + 2 秒", () => {
    expect(recordLoginFailure({ failedAttempts: 5, lockedUntil: null }, now)).toEqual({
      failedAttempts: 6,
      lockedUntil: "2026-09-16T00:00:02.000Z",
    });
  });

  test("狀態轉換：第 10 次失敗，lockedUntil = now + 32 秒，並取代先前的 lockedUntil", () => {
    expect(
      recordLoginFailure({ failedAttempts: 9, lockedUntil: "2026-09-15T23:59:44.000Z" }, now)
    ).toEqual({
      failedAttempts: 10,
      lockedUntil: "2026-09-16T00:00:32.000Z",
    });
  });

  test("狀態轉換：第 6→10 次失敗，lockedUntil 依序為 now + 2,4,8,16,32 秒", () => {
    [2, 4, 8, 16, 32].forEach((seconds, i) => {
      expect(recordLoginFailure({ failedAttempts: 5 + i, lockedUntil: null }, now)).toEqual({
        failedAttempts: 6 + i,
        lockedUntil: new Date(now.getTime() + seconds * 1000).toISOString(),
      });
    });
  });

  test("邊界：第 11 次失敗公式值 64 秒封頂為 60 秒", () => {
    expect(recordLoginFailure({ failedAttempts: 10, lockedUntil: null }, now)).toEqual({
      failedAttempts: 11,
      lockedUntil: "2026-09-16T00:01:00.000Z",
    });
  });

  test("邊界：超過封頂門檻後等待維持 60 秒，不再增加", () => {
    for (const failures of [12, 20, 100]) {
      expect(recordLoginFailure({ failedAttempts: failures - 1, lockedUntil: null }, now)).toEqual({
        failedAttempts: failures,
        lockedUntil: "2026-09-16T00:01:00.000Z",
      });
    }
  });

  test("無副作用：不修改傳入的 state", () => {
    const before: FailureState = { failedAttempts: 7, lockedUntil: "2026-09-15T23:59:56.000Z" };
    recordLoginFailure(before, now);
    expect(before).toEqual({ failedAttempts: 7, lockedUntil: "2026-09-15T23:59:56.000Z" });
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

describe("登入失敗流程：鎖定、期滿解除、累計延長、成功歸零（§4.1、AC6）", () => {
  test("期滿解除後 failedAttempts 維持累計，下一次失敗依累計次數延長等待，成功後才歸零", () => {
    const start = new Date("2026-09-16T00:00:00.000Z");
    let state: FailureState = { failedAttempts: 0, lockedUntil: null };
    for (let i = 0; i < 6; i++) state = recordLoginFailure(state, start);
    expect(getLoginLockoutState(state, start)).toEqual({ locked: true, waitSeconds: 2 });

    const afterWait = new Date(start.getTime() + 2000);
    expect(getLoginLockoutState(state, afterWait)).toEqual({ locked: false, waitSeconds: 0 });
    expect(state.failedAttempts).toBe(6);

    state = recordLoginFailure(state, afterWait);
    expect(getLoginLockoutState(state, afterWait)).toEqual({ locked: true, waitSeconds: 4 });

    state = recordLoginSuccess(state);
    expect(getLoginLockoutState(state, afterWait)).toEqual({ locked: false, waitSeconds: 0 });
  });
});
