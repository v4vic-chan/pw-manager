import { useEffect, useSyncExternalStore } from "react";
import type { SecurityController } from "./securityController";
import {
  selectNavigationLocked,
  selectWriteInProgress,
  type ReadySecurityState,
} from "./securityMachine";
import {
  ChangePasswordDialog,
  DisableTwoFactorDialog,
  EnableTwoFactorDialog,
  ExportDialog,
  RegenerateRecoveryCodesDialog,
} from "./SecurityDialogs";
import { SECURITY_MESSAGES, lowRecoveryCodesMessage, twoFactorStatusText } from "./messages";

/**
 * 安全設定畫面（規格 §4.1.2 變更主密碼、§4.2 2FA 開關與救援碼補發、§5.3 匯出）。
 * 依 2FA 狀態只提供合法的操作；寫入中或秘鑰／救援碼顯示中停用登出（分頁切換由 App 依同一個選擇器鎖定）。
 * 寫入進行中註冊 beforeunload，提醒使用者不要在 rekey 等交易途中關閉分頁。
 * 不使用 router／history，秘鑰與救援碼不會出現在可用返回鍵重新取得的地方。
 */

const LOW_RECOVERY_CODES = 2;

interface SecurityScreenProps {
  controller: SecurityController;
  onLogout: () => void;
}

export function SecurityScreen({ controller, onLogout }: SecurityScreenProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const writing = selectWriteInProgress(state);
  const navigationLocked = selectNavigationLocked(state);

  useEffect(() => {
    if (!writing) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 部分瀏覽器需設定 returnValue 才會顯示離頁確認
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [writing]);

  if (state.phase === "closed") return null;

  return (
    <main className="security-page">
      <header className="entries-header">
        <h1>{SECURITY_MESSAGES.title}</h1>
        <button type="button" onClick={onLogout} disabled={navigationLocked}>
          登出
        </button>
      </header>
      {state.phase === "loading" && <p role="status">{SECURITY_MESSAGES.loading}</p>}
      {state.phase === "error" && <p role="alert">{state.error}</p>}
      {state.phase === "ready" && <SecurityReady state={state} controller={controller} />}
    </main>
  );
}

function SecurityReady({ state, controller }: { state: ReadySecurityState; controller: SecurityController }) {
  const { status, operation, notice } = state;
  const actionsDisabled = operation !== null || state.sessionLost;

  return (
    <>
      {notice && (
        <div className="security-notice">
          <p role="status">{notice}</p>
          <button type="button" className="auth-secondary" onClick={() => controller.dismissNotice()}>
            關閉提示
          </button>
        </div>
      )}

      <section className="security-section" aria-labelledby="security-password-heading">
        <h2 id="security-password-heading">主密碼</h2>
        <p>變更主密碼需要先輸入目前主密碼，並會以新主密碼重新加密所有資料。</p>
        <button type="button" onClick={() => controller.openChangePassword()} disabled={actionsDisabled}>
          變更主密碼
        </button>
      </section>

      <section className="security-section" aria-labelledby="security-2fa-heading">
        <h2 id="security-2fa-heading">兩步驟驗證</h2>
        <p>{twoFactorStatusText(status.twoFactorEnabled, status.unusedRecoveryCodes)}</p>
        {status.twoFactorEnabled && status.unusedRecoveryCodes <= LOW_RECOVERY_CODES && (
          <p className="auth-warning">{lowRecoveryCodesMessage(status.unusedRecoveryCodes)}</p>
        )}
        <div className="security-actions">
          {status.twoFactorEnabled ? (
            <>
              <button
                type="button"
                onClick={() => controller.openRegenerateRecoveryCodes()}
                disabled={actionsDisabled}
              >
                補發救援碼
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => controller.openDisableTwoFactor()}
                disabled={actionsDisabled}
              >
                關閉兩步驟驗證
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void controller.openEnableTwoFactor()} disabled={actionsDisabled}>
              開啟兩步驟驗證
            </button>
          )}
        </div>
      </section>

      <section className="security-section" aria-labelledby="security-backup-heading">
        <h2 id="security-backup-heading">備份</h2>
        <p>{SECURITY_MESSAGES.exportExplanation}</p>
        <button type="button" onClick={() => controller.openExport()} disabled={actionsDisabled}>
          匯出加密備份
        </button>
      </section>

      {operation?.kind === "changePassword" && <ChangePasswordDialog operation={operation} controller={controller} />}
      {operation?.kind === "enableTwoFactor" && <EnableTwoFactorDialog operation={operation} controller={controller} />}
      {operation?.kind === "disableTwoFactor" && <DisableTwoFactorDialog operation={operation} controller={controller} />}
      {operation?.kind === "regenerateRecoveryCodes" && (
        <RegenerateRecoveryCodesDialog operation={operation} controller={controller} />
      )}
      {operation?.kind === "export" && <ExportDialog operation={operation} controller={controller} />}
    </>
  );
}
