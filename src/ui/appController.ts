import { bindIdleActivity, createIdleTimer, type IdleTimer } from "../services/idleTimer";
import { createStorage, type VaultStorage } from "../services/storage";
import { createAuthController, type AuthController } from "./auth/authController";

export interface AppOptions {
  dbName?: string;
  /** 使用者活動來源（瀏覽器中為 window） */
  activityTarget: EventTarget;
  /** 分頁可見性來源（瀏覽器中為 document） */
  visibilityTarget: EventTarget & { visibilityState: DocumentVisibilityState };
}

export interface AppContext {
  controller: AuthController;
  storage: VaultStorage;
  idleTimer: IdleTimer;
}

/**
 * 組裝 UI 控制器、Service Layer 與閒置計時器（§5.1.4）：
 * 逾時時由控制器清除 session 並回到登入；storage 取得同一個計時器，重新金鑰化期間自動暫停（§4.1.1）。
 */
export async function createApp(options: AppOptions): Promise<AppContext> {
  let controller: AuthController | null = null;
  const idleTimer = createIdleTimer({ onTimeout: () => controller?.handleIdleTimeout() });
  const storage = await createStorage({ dbName: options.dbName, idleTimer });
  controller = createAuthController({
    storage,
    idleTimer,
    bindActivity: () => bindIdleActivity(idleTimer, options.activityTarget, options.visibilityTarget),
  });
  return { controller, storage, idleTimer };
}
