/**
 * §5.1.4 閒置計時：逾時後呼叫 onTimeout（呼叫端於其中執行 storage.logout() 並捨棄 UI 內的已解密資料）。
 * 判定一律以牆鐘時間（Date.now）計算，不依賴 setTimeout 準時觸發：背景分頁節流或裝置休眠後，
 * 下一次活動或回到前景時先判定是否已逾時，已逾時則先觸發，不以該次互動延長 session。
 * 暫停採參考計數，供重新金鑰化等長時間安全操作使用；全部釋放後依 §5.1.4「重新起算」。
 */

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
export const MIN_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_IDLE_TIMEOUT_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/** 視為使用者活動的本頁互動事件；分頁可見性變化本身不算活動 */
export const IDLE_ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

export interface IdleTimerOptions {
  onTimeout: () => void;
  /** 預設 10 分鐘，可調範圍 5–15 分鐘（§5.1.4） */
  timeoutMinutes?: number;
}

export interface IdleTimer {
  /** 登入成功後開始計時（從現在起算） */
  start(): void;
  /** 登出時停止計時，不觸發 onTimeout */
  stop(): void;
  /** 使用者活動：已逾時則立即觸發 onTimeout，否則從完整時長重新起算 */
  recordActivity(): void;
  /** 以牆鐘時間檢查是否已逾時（例如回到前景時），不視為活動 */
  checkExpiry(): void;
  /** 暫停計時並回傳只生效一次的 release；所有暫停皆釋放後從完整時長重新起算 */
  pause(): () => void;
  runPaused<T>(operation: () => Promise<T>): Promise<T>;
  isRunning(): boolean;
  isPaused(): boolean;
}

/** §5.1.4：逾時時長須介於 5–15 分鐘 */
export function assertValidIdleTimeoutMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < MIN_IDLE_TIMEOUT_MINUTES || minutes > MAX_IDLE_TIMEOUT_MINUTES) {
    throw new RangeError(
      `閒置逾時須介於 ${MIN_IDLE_TIMEOUT_MINUTES}–${MAX_IDLE_TIMEOUT_MINUTES} 分鐘（§5.1.4），實際為 ${minutes}`
    );
  }
}

export function remainingIdleMs(lastActivityAt: number, now: number, timeoutMs: number): number {
  return Math.max(0, lastActivityAt + timeoutMs - now);
}

export function isIdleExpired(lastActivityAt: number, now: number, timeoutMs: number): boolean {
  return remainingIdleMs(lastActivityAt, now, timeoutMs) === 0;
}

export function createIdleTimer(options: IdleTimerOptions): IdleTimer {
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
  assertValidIdleTimeoutMinutes(timeoutMinutes);
  const timeoutMs = timeoutMinutes * MS_PER_MINUTE;

  let running = false;
  let pauseCount = 0;
  let lastActivityAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;

  function clearHandle(): void {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  function restartCountdown(): void {
    lastActivityAt = Date.now();
    schedule();
  }

  function schedule(): void {
    clearHandle();
    if (!running || pauseCount > 0) return;
    handle = setTimeout(checkExpiry, remainingIdleMs(lastActivityAt, Date.now(), timeoutMs));
  }

  function fire(): void {
    running = false;
    clearHandle();
    options.onTimeout();
  }

  function checkExpiry(): void {
    if (!running || pauseCount > 0) return;
    if (isIdleExpired(lastActivityAt, Date.now(), timeoutMs)) {
      fire();
    } else {
      schedule();
    }
  }

  function pause(): () => void {
    pauseCount += 1;
    clearHandle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pauseCount -= 1;
      if (pauseCount === 0 && running) restartCountdown();
    };
  }

  return {
    start() {
      running = true;
      restartCountdown();
    },

    stop() {
      running = false;
      clearHandle();
    },

    recordActivity() {
      if (!running || pauseCount > 0) return;
      if (isIdleExpired(lastActivityAt, Date.now(), timeoutMs)) {
        fire();
        return;
      }
      restartCountdown();
    },

    checkExpiry,
    pause,

    async runPaused(operation) {
      const release = pause();
      try {
        return await operation();
      } finally {
        release();
      }
    },

    isRunning() {
      return running;
    },

    isPaused() {
      return pauseCount > 0;
    },
  };
}

/**
 * 瀏覽器事件綁定（薄包裝層）：activityTarget 通常為 window，visibilityTarget 通常為 document。
 * 以 capture 監聽，避免元件 stopPropagation 使活動漏判。回傳解除綁定函式。
 */
export function bindIdleActivity(
  timer: Pick<IdleTimer, "recordActivity" | "checkExpiry">,
  activityTarget: EventTarget,
  visibilityTarget: EventTarget & { visibilityState: DocumentVisibilityState }
): () => void {
  const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };
  const onActivity = () => timer.recordActivity();
  const onVisibilityChange = () => {
    if (visibilityTarget.visibilityState === "visible") timer.checkExpiry();
  };

  for (const type of IDLE_ACTIVITY_EVENTS) activityTarget.addEventListener(type, onActivity, listenerOptions);
  visibilityTarget.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    for (const type of IDLE_ACTIVITY_EVENTS) activityTarget.removeEventListener(type, onActivity, listenerOptions);
    visibilityTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
