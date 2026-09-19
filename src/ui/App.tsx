import { useEffect, useState, useSyncExternalStore } from "react";
import { AuthFlow } from "./auth/AuthFlow";
import type { AuthController } from "./auth/authController";
import { EntriesScreen } from "./entries/EntriesScreen";
import {
  createEntriesController,
  type ClipboardLike,
  type EntriesController,
  type EntriesStorage,
} from "./entries/entriesController";

export interface AppProps {
  controller: AuthController;
  /** 條目列表讀取資料用；僅需 loadEntries／loadCategories */
  storage: EntriesStorage;
  /** 預設使用 navigator.clipboard；測試可注入假剪貼簿 */
  clipboard?: ClipboardLike;
}

/** authenticated 時掛載條目列表主畫面，其餘階段交給登入／解鎖流程 */
export function App({ controller, storage, clipboard }: AppProps) {
  useEffect(() => {
    void controller.boot();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.phase === "authenticated") {
    return <AuthenticatedView authController={controller} storage={storage} clipboard={clipboard} />;
  }
  return <AuthFlow controller={controller} />;
}

/**
 * 列表控制器的生命週期綁定畫面掛載：登出、閒置逾時（auth 狀態離開 authenticated）都會卸載本元件，
 * cleanup 時 dispose 以捨棄明文並嘗試清除剪貼簿（§5.1.4）。
 */
function AuthenticatedView({
  authController,
  storage,
  clipboard,
}: {
  authController: AuthController;
  storage: EntriesStorage;
  clipboard: ClipboardLike | undefined;
}) {
  const [entries, setEntries] = useState<EntriesController | null>(null);

  useEffect(() => {
    // 非安全環境下 navigator.clipboard 可能為 undefined，控制器會將複製視為失敗
    // 寫入時發現 session 已失效：列表先顯示提示，稍後由此登出（登入頁顯示通用的「已登出」）
    const controller = createEntriesController({
      storage,
      clipboard: clipboard ?? navigator.clipboard,
      onSessionLost: () => authController.logout(),
    });
    setEntries(controller);
    void controller.load();
    return () => controller.dispose();
  }, [authController, storage, clipboard]);

  if (entries === null) return null;
  return <EntriesScreen controller={entries} onLogout={() => authController.logout()} />;
}
