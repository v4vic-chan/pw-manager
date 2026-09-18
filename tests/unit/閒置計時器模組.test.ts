import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertValidIdleTimeoutMinutes,
  bindIdleActivity,
  createIdleTimer,
  isIdleExpired,
  remainingIdleMs,
  IDLE_ACTIVITY_EVENTS,
} from "../../src/services/idleTimer";

/**
 * 模組：閒置計時器（規格 §5.1.4；AC9、AC14）
 * 預設 10 分鐘、可調 5–15 分鐘；逾時後由 onTimeout 清除 session（呼叫端接 storage.logout()）。
 * 重新金鑰化期間暫停，結束（成功或失敗）後恢復並「重新起算」。
 * 使用者活動：本頁 keydown/pointerdown/pointermove/wheel/touchstart；背景分頁照常以牆鐘時間計時。
 */

const MINUTE = 60_000;

describe("純函式：逾時判定（§5.1.4）", () => {
  test("剩餘時間以牆鐘時間計算，逾時後固定為 0", () => {
    expect(remainingIdleMs(1_000, 1_000, 10 * MINUTE)).toBe(10 * MINUTE);
    expect(remainingIdleMs(1_000, 1_000 + 4 * MINUTE, 10 * MINUTE)).toBe(6 * MINUTE);
    expect(remainingIdleMs(1_000, 1_000 + 30 * MINUTE, 10 * MINUTE)).toBe(0);
  });

  test("邊界：恰滿時長即判定逾時，少 1 ms 則未逾時", () => {
    expect(isIdleExpired(0, 10 * MINUTE - 1, 10 * MINUTE)).toBe(false);
    expect(isIdleExpired(0, 10 * MINUTE, 10 * MINUTE)).toBe(true);
  });

  test("邊界：逾時時長 5 與 15 分鐘可接受，範圍外或非有限數值應拒絕", () => {
    expect(() => assertValidIdleTimeoutMinutes(5)).not.toThrow();
    expect(() => assertValidIdleTimeoutMinutes(15)).not.toThrow();
    for (const invalid of [4.99, 15.01, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertValidIdleTimeoutMinutes(invalid)).toThrow(RangeError);
    }
    expect(() => createIdleTimer({ onTimeout: () => undefined, timeoutMinutes: 16 })).toThrow(RangeError);
  });
});

describe("createIdleTimer：倒數、活動重置與停止", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("未指定時長時預設 10 分鐘：未滿不觸發，滿 10 分鐘觸發 onTimeout 一次並停止計時", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(timer.isRunning()).toBe(false);

    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("自訂時長 5 分鐘生效", () => {
    const onTimeout = vi.fn();
    createIdleTimer({ onTimeout, timeoutMinutes: 5 }).start();

    vi.advanceTimersByTime(5 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("使用者活動使倒數從完整時長重新起算", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    vi.advanceTimersByTime(9 * MINUTE);
    timer.recordActivity();
    vi.advanceTimersByTime(9 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("stop 後不再觸發；未 start 時活動不會啟動計時", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });

    timer.recordActivity();
    expect(timer.isRunning()).toBe(false);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();

    timer.start();
    vi.advanceTimersByTime(5 * MINUTE);
    timer.stop();
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test("背景節流／裝置休眠：計時器未觸發但牆鐘已過期時，下一次活動應先觸發逾時而非延長 session", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    // 只推進系統時間、不執行計時器回呼，模擬背景分頁節流或裝置休眠
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    timer.recordActivity();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(timer.isRunning()).toBe(false);
  });

  test("回到前景時 checkExpiry 以牆鐘時間判定：已逾時立即觸發，未逾時不視為活動", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    vi.setSystemTime(Date.now() + 4 * MINUTE);
    timer.checkExpiry();
    expect(onTimeout).not.toHaveBeenCalled();
    // 未重新起算：從 start 起算滿 10 分鐘即觸發
    vi.advanceTimersByTime(6 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const timer2 = createIdleTimer({ onTimeout: second });
    timer2.start();
    vi.setSystemTime(Date.now() + 12 * MINUTE);
    timer2.checkExpiry();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("逾時後可再次 start 重新計時（重新登入後）", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();
    vi.advanceTimersByTime(10 * MINUTE);

    timer.start();
    expect(timer.isRunning()).toBe(true);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });
});

describe("暫停／恢復（§4.1.1 步驟 1、5；§5.1.4；AC14）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("暫停期間不論經過多久都不觸發；恢復後從完整時長重新起算", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();
    vi.advanceTimersByTime(9 * MINUTE);

    const release = timer.pause();
    expect(timer.isPaused()).toBe(true);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();

    release();
    expect(timer.isPaused()).toBe(false);
    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("巢狀暫停：須全部釋放才恢復；同一 release 重複呼叫不重複遞減", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    const releaseA = timer.pause();
    const releaseB = timer.pause();
    releaseA();
    releaseA();
    expect(timer.isPaused()).toBe(true);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();

    releaseB();
    expect(timer.isPaused()).toBe(false);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("暫停期間系統時間越過期限，恢復時仍重新起算、不立即觸發", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });
    timer.start();

    const release = timer.pause();
    vi.setSystemTime(Date.now() + 30 * MINUTE);
    timer.recordActivity();
    timer.checkExpiry();
    expect(onTimeout).not.toHaveBeenCalled();

    release();
    timer.checkExpiry();
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("計時器未啟動時暫停與釋放不會啟動計時", () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({ onTimeout });

    timer.pause()();
    expect(timer.isRunning()).toBe(false);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test("runPaused：操作期間暫停，成功或失敗後皆恢復，失敗時原錯誤照樣拋出", async () => {
    const timer = createIdleTimer({ onTimeout: vi.fn() });
    timer.start();

    let pausedDuring = false;
    await expect(
      timer.runPaused(async () => {
        pausedDuring = timer.isPaused();
        return "done";
      })
    ).resolves.toBe("done");
    expect(pausedDuring).toBe(true);
    expect(timer.isPaused()).toBe(false);

    await expect(
      timer.runPaused(async () => {
        throw new Error("operation failed");
      })
    ).rejects.toThrow("operation failed");
    expect(timer.isPaused()).toBe(false);
  });
});

describe("bindIdleActivity：瀏覽器事件綁定（薄包裝層）", () => {
  function createTargets() {
    const activityTarget = new EventTarget();
    const visibilityTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const timer = { recordActivity: vi.fn(), checkExpiry: vi.fn() };
    return { activityTarget, visibilityTarget, timer };
  }

  test("本頁互動事件視為活動；其他事件不算", () => {
    const { activityTarget, visibilityTarget, timer } = createTargets();
    bindIdleActivity(timer, activityTarget, visibilityTarget);

    expect([...IDLE_ACTIVITY_EVENTS].sort()).toEqual(
      ["keydown", "pointerdown", "pointermove", "touchstart", "wheel"].sort()
    );
    for (const type of IDLE_ACTIVITY_EVENTS) activityTarget.dispatchEvent(new Event(type));
    expect(timer.recordActivity).toHaveBeenCalledTimes(IDLE_ACTIVITY_EVENTS.length);

    activityTarget.dispatchEvent(new Event("focus"));
    activityTarget.dispatchEvent(new Event("resize"));
    expect(timer.recordActivity).toHaveBeenCalledTimes(IDLE_ACTIVITY_EVENTS.length);
  });

  test("回到前景（visible）時檢查是否已逾時且不視為活動；轉為背景（hidden）時不動作", () => {
    const { activityTarget, visibilityTarget, timer } = createTargets();
    bindIdleActivity(timer, activityTarget, visibilityTarget);

    visibilityTarget.visibilityState = "hidden";
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(timer.checkExpiry).not.toHaveBeenCalled();

    visibilityTarget.visibilityState = "visible";
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(timer.checkExpiry).toHaveBeenCalledTimes(1);
    expect(timer.recordActivity).not.toHaveBeenCalled();
  });

  test("解除綁定後不再回應任何事件", () => {
    const { activityTarget, visibilityTarget, timer } = createTargets();
    const unbind = bindIdleActivity(timer, activityTarget, visibilityTarget);
    unbind();

    activityTarget.dispatchEvent(new Event("keydown"));
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(timer.recordActivity).not.toHaveBeenCalled();
    expect(timer.checkExpiry).not.toHaveBeenCalled();
  });
});
