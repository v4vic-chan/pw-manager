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
import { SecurityScreen } from "./security/SecurityScreen";
import { createSecurityController, type SecurityController, type SecurityStorage } from "./security/securityController";
import { selectNavigationLocked } from "./security/securityMachine";

export interface AppProps {
  controller: AuthController;
  /** 條目列表與安全設定讀寫資料用（瀏覽器中為 createStorage() 的 VaultStorage） */
  storage: EntriesStorage & SecurityStorage;
  /** 預設使用 navigator.clipboard；測試可注入假剪貼簿 */
  clipboard?: ClipboardLike;
}

/** authenticated 時掛載主畫面（密碼庫／安全設定分頁），其餘階段交給登入／解鎖流程 */
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
 * 兩個畫面控制器的生命週期綁定已登入畫面：登出、閒置逾時（auth 狀態離開 authenticated）都會卸載本元件，
 * cleanup 時 dispose 以捨棄明文、秘鑰與救援碼，並嘗試清除剪貼簿（§5.1.4）。
 * 切換分頁不會 dispose，列表的搜尋／篩選狀態保留。
 */
function AuthenticatedView({
  authController,
  storage,
  clipboard,
}: {
  authController: AuthController;
  storage: EntriesStorage & SecurityStorage;
  clipboard: ClipboardLike | undefined;
}) {
  const [controllers, setControllers] = useState<{ entries: EntriesController; security: SecurityController } | null>(
    null
  );

  useEffect(() => {
    // 寫入時發現 session 已失效：畫面先顯示提示，稍後由此登出（登入頁顯示通用的「已登出」）
    const logout = () => authController.logout();
    // 非安全環境下 navigator.clipboard 可能為 undefined，控制器會將複製視為失敗
    const entries = createEntriesController({
      storage,
      clipboard: clipboard ?? navigator.clipboard,
      onSessionLost: logout,
    });
    const security = createSecurityController({ storage, onSessionLost: logout });
    setControllers({ entries, security });
    void entries.load();
    void security.load();
    return () => {
      entries.dispose();
      security.dispose();
    };
  }, [authController, storage, clipboard]);

  if (controllers === null) return null;
  return <AuthenticatedTabs {...controllers} onLogout={() => authController.logout()} />;
}

type Tab = "entries" | "security";

/** 分頁導覽：安全設定寫入中或秘鑰／救援碼顯示中鎖定切換，避免使用者在途中離開而錯過結果或救援碼 */
function AuthenticatedTabs({
  entries,
  security,
  onLogout,
}: {
  entries: EntriesController;
  security: SecurityController;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>("entries");
  const securityState = useSyncExternalStore(security.subscribe, security.getState);
  const locked = selectNavigationLocked(securityState);

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      aria-current={tab === value ? "page" : undefined}
      onClick={() => setTab(value)}
      disabled={locked && tab !== value}
    >
      {label}
    </button>
  );

  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="主要導覽">
        {tabButton("entries", "密碼庫")}
        {tabButton("security", "安全設定")}
      </nav>
      {tab === "entries" ? (
        <EntriesScreen controller={entries} onLogout={onLogout} />
      ) : (
        <SecurityScreen controller={security} onLogout={onLogout} />
      )}
    </div>
  );
}
