import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { isImportConfirmationValid } from "../../services/importExport";
import type { AuthController } from "./authController";
import type { AuthState } from "./authMachine";
import { MESSAGES, loginLockedMessage, secondFactorLockedMessage } from "./messages";

/**
 * 登入／解鎖畫面：依狀態機的 phase 切換畫面，所有操作轉交控制器。
 * 主密碼、備份密碼與救援碼一律以遮罩輸入，僅存在於各畫面的本地狀態，離開畫面即捨棄。
 */

type ScreenProps<P extends AuthState["phase"]> = {
  state: Extract<AuthState, { phase: P }>;
  controller: AuthController;
};

export function AuthFlow({ controller }: { controller: AuthController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  switch (state.phase) {
    case "booting":
      return <p role="status">載入中…</p>;
    case "fatal":
      return (
        <main className="auth-card">
          <p role="alert">{state.error}</p>
        </main>
      );
    case "setup":
      return <SetupScreen state={state} controller={controller} />;
    case "login":
      return <LoginScreen state={state} controller={controller} />;
    case "secondFactor":
      return <SecondFactorScreen state={state} controller={controller} />;
    case "importConfirm":
      return <ImportConfirmScreen state={state} controller={controller} />;
    case "importFile":
      return <ImportFileScreen state={state} controller={controller} />;
    case "authenticated":
      return <UnlockedScreen controller={controller} />;
  }
}

/** 鎖定剩餘秒數（無條件進位）；鎖定期間每秒重新繪製 */
function useRemainingSeconds(lockedUntil: number | null): number {
  const [, setTick] = useState(0);
  const remaining = lockedUntil === null ? 0 : Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));

  useEffect(() => {
    if (remaining === 0) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), 1000);
    return () => clearTimeout(timer);
  });

  return remaining;
}

function BusyHint({ busy }: { busy: boolean }) {
  return busy ? <p className="auth-hint">處理中，請稍候…</p> : null;
}

function SetupScreen({ state, controller }: ScreenProps<"setup">) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitSetup(password, confirmation);
  };

  return (
    <main className="auth-card">
      <form onSubmit={submit}>
        <h1>建立保險庫</h1>
        <p>主密碼用來加密此裝置上的所有資料，至少需要 12 個字元。</p>
        <label htmlFor="setup-password">主密碼</label>
        <input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={state.busy}
        />
        <label htmlFor="setup-confirmation">再次輸入主密碼</label>
        <input
          id="setup-confirmation"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={state.busy}
        />
        {state.error && <p role="alert">{state.error}</p>}
        <BusyHint busy={state.busy} />
        <button type="submit" disabled={state.busy}>
          設定主密碼
        </button>
      </form>
    </main>
  );
}

function LoginScreen({ state, controller }: ScreenProps<"login">) {
  const [password, setPassword] = useState("");
  const remaining = useRemainingSeconds(state.lockedUntil);
  const locked = remaining > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitLogin(password);
  };

  return (
    <main className="auth-card">
      <form onSubmit={submit}>
        <h1>解鎖保險庫</h1>
        {state.notice && <p role="status">{state.notice}</p>}
        <label htmlFor="login-password">主密碼</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={state.busy}
        />
        {locked ? (
          <p role="alert">{loginLockedMessage(remaining)}</p>
        ) : (
          state.error && <p role="alert">{state.error}</p>
        )}
        <BusyHint busy={state.busy} />
        <button type="submit" disabled={state.busy || locked}>
          解鎖
        </button>
      </form>
      <button type="button" className="auth-secondary" onClick={() => controller.beginImport()} disabled={state.busy}>
        從備份檔匯入並覆蓋
      </button>
    </main>
  );
}

function SecondFactorScreen({ state, controller }: ScreenProps<"secondFactor">) {
  const [code, setCode] = useState("");
  const remaining = useRemainingSeconds(state.lockedUntil);
  const locked = remaining > 0;
  const isTotp = state.method === "totp";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitSecondFactor(code);
  };

  const switchMethod = () => {
    setCode("");
    controller.switchSecondFactorMethod(isTotp ? "recovery" : "totp");
  };

  return (
    <main className="auth-card">
      <form onSubmit={submit}>
        <h1>第二因素驗證</h1>
        <p>{isTotp ? "請輸入驗證器 App 顯示的 6 位數驗證碼。" : "請輸入一組尚未使用過的救援碼。"}</p>
        <label htmlFor="second-factor-code">{isTotp ? "驗證碼" : "救援碼"}</label>
        <input
          key={state.method}
          id="second-factor-code"
          type={isTotp ? "text" : "password"}
          inputMode={isTotp ? "numeric" : "text"}
          autoComplete={isTotp ? "one-time-code" : "off"}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={state.busy}
        />
        {locked ? (
          <p role="alert">{secondFactorLockedMessage(remaining)}</p>
        ) : (
          state.error && <p role="alert">{state.error}</p>
        )}
        <BusyHint busy={state.busy} />
        <button type="submit" disabled={state.busy || locked}>
          驗證
        </button>
      </form>
      <button type="button" className="auth-secondary" onClick={switchMethod} disabled={state.busy}>
        {isTotp ? "改用救援碼" : "改用驗證碼"}
      </button>
      <button
        type="button"
        className="auth-secondary"
        onClick={() => controller.cancelSecondFactor()}
        disabled={state.busy}
      >
        返回登入
      </button>
    </main>
  );
}

function ImportConfirmScreen({ state, controller }: ScreenProps<"importConfirm">) {
  const [confirmation, setConfirmation] = useState("");
  // §5.3：與 "OVERWRITE" 嚴格相等才可繼續；Service Layer 亦會再次驗證
  const valid = isImportConfirmationValid(confirmation);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) void controller.submitImportConfirmation(confirmation);
  };

  return (
    <main className="auth-card">
      <form onSubmit={submit}>
        <h1>從備份檔匯入並覆蓋</h1>
        <p className="auth-warning">{MESSAGES.importWarning}</p>
        <p>若要繼續，請輸入大寫的 OVERWRITE。</p>
        <label htmlFor="import-confirmation">確認字串</label>
        <input
          id="import-confirmation"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={state.busy}
        />
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={!valid || state.busy}>
          繼續
        </button>
      </form>
      <button type="button" className="auth-secondary" onClick={() => controller.cancelImport()} disabled={state.busy}>
        取消
      </button>
    </main>
  );
}

function ImportFileScreen({ state, controller }: ScreenProps<"importFile">) {
  const [password, setPassword] = useState("");
  const canSubmit = state.fileName !== null && password.length > 0 && !state.busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) void controller.submitImport(password);
  };

  return (
    <main className="auth-card">
      <form onSubmit={submit}>
        <h1>從備份檔匯入並覆蓋</h1>
        <p className="auth-warning">{MESSAGES.importWarning}</p>
        <label htmlFor="import-file">備份檔</label>
        <input
          id="import-file"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void controller.selectImportFile(file);
          }}
          disabled={state.busy}
        />
        {state.fileName && <p>已選擇：{state.fileName}</p>}
        <label htmlFor="import-password">備份檔當時的主密碼</label>
        <input
          id="import-password"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={state.busy || state.fileName === null}
        />
        {state.error && <p role="alert">{state.error}</p>}
        <BusyHint busy={state.busy} />
        <button type="submit" disabled={!canSubmit}>
          匯入並覆蓋
        </button>
      </form>
      <button type="button" className="auth-secondary" onClick={() => controller.cancelImport()} disabled={state.busy}>
        取消
      </button>
    </main>
  );
}

function UnlockedScreen({ controller }: { controller: AuthController }) {
  return (
    <main className="auth-card">
      <h1>已解鎖</h1>
      <p>保險庫已解鎖。</p>
      <button type="button" onClick={() => controller.logout()}>
        登出
      </button>
    </main>
  );
}
