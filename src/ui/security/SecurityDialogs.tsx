import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../entries/Modal";
import type { SecurityController } from "./securityController";
import type { Operation } from "./securityMachine";
import { SECURITY_MESSAGES, acknowledgeLabel, lockedMessage } from "./messages";

/**
 * 安全設定的操作對話框（沿用 entries/Modal：Tab 焦點限制、關閉後焦點歸位）。
 * Esc 一律轉為 closeOperation：寫入中或秘鑰／救援碼顯示中由狀態機拒絕，因此這些畫面按 Esc 不會關閉。
 * 輸入的密碼與驗證碼只存在於各對話框的區域狀態，關閉即捨棄。
 */

type OperationOf<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;

interface DialogProps<K extends Operation["kind"]> {
  operation: OperationOf<K>;
  controller: SecurityController;
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

/** 處理中說明、錯誤與鎖定提示 */
function OperationFeedback({ operation, remaining }: { operation: Operation; remaining: number }) {
  return (
    <>
      {operation.busy && operation.progress && (
        <p role="status" className="security-progress">
          {operation.progress}
        </p>
      )}
      {remaining > 0 ? (
        <p role="alert">{lockedMessage(remaining)}</p>
      ) : (
        operation.error && <p role="alert">{operation.error}</p>
      )}
    </>
  );
}

function PasswordVisibilityToggle({
  visible,
  onToggle,
  disabled,
}: {
  visible: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <button type="button" className="auth-secondary" onClick={onToggle} disabled={disabled}>
      {visible ? "隱藏密碼" : "顯示密碼"}
    </button>
  );
}

export function ChangePasswordDialog({ operation, controller }: DialogProps<"changePassword">) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const remaining = useRemainingSeconds(operation.lockedUntil);
  const { busy } = operation;

  const hints: string[] = [];
  if (newPassword.length > 0 && newPassword.length < 12) hints.push(SECURITY_MESSAGES.newPasswordTooShort);
  if (confirmation.length > 0 && confirmation !== newPassword) hints.push(SECURITY_MESSAGES.newPasswordMismatch);
  if (newPassword.length > 0 && newPassword === currentPassword) hints.push(SECURITY_MESSAGES.newPasswordSameAsCurrent);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitChangePassword({ currentPassword, newPassword, confirmation });
  };
  const type = visible ? "text" : "password";

  return (
    <Modal role="dialog" labelledBy="change-password-title" onEscape={() => controller.closeOperation()}>
      <form onSubmit={submit} noValidate>
        <h2 id="change-password-title">變更主密碼</h2>
        <p>變更後會以新主密碼重新加密所有資料，可能需要一些時間。完成後維持登入狀態。</p>

        <label htmlFor="change-current-password">目前主密碼</label>
        <input
          id="change-current-password"
          type={type}
          autoComplete="current-password"
          autoFocus
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="change-new-password">新主密碼</label>
        <input
          id="change-new-password"
          type={type}
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="change-confirmation">再次輸入新主密碼</label>
        <input
          id="change-confirmation"
          type={type}
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={busy}
        />
        <PasswordVisibilityToggle visible={visible} onToggle={() => setVisible((value) => !value)} disabled={busy} />
        {hints.map((hint) => (
          <p key={hint} className="field-error">
            {hint}
          </p>
        ))}

        <OperationFeedback operation={operation} remaining={remaining} />
        <div className="modal-actions">
          <button type="button" onClick={() => controller.closeOperation()} disabled={busy}>
            取消
          </button>
          <button type="submit" disabled={busy || remaining > 0}>
            變更主密碼
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 救援碼清單、下載與「已保存」勾選（開啟 2FA 與補發共用）；不提供複製，避免殘留於剪貼簿 */
function RecoveryCodesBlock({
  codes,
  acknowledged,
  busy,
  controller,
}: {
  codes: string[];
  acknowledged: boolean;
  busy: boolean;
  controller: SecurityController;
}) {
  return (
    <>
      <p>每組救援碼只能使用一次。遺失驗證器時，可用救援碼登入或關閉兩步驟驗證。</p>
      <ol className="recovery-codes" aria-label="救援碼">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <button type="button" onClick={() => controller.downloadRecoveryCodes()} disabled={busy}>
        下載為文字檔
      </button>
      <label className="security-acknowledge">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => controller.setAcknowledged(event.target.checked)}
          disabled={busy}
        />
        <span>{acknowledgeLabel(codes.length)}</span>
      </label>
    </>
  );
}

/** 放棄前的再次確認；預設聚焦「繼續設定」，避免連按 Enter 誤棄 */
function AbandonConfirmation({ message, controller }: { message: string; controller: SecurityController }) {
  return (
    <div className="security-abandon" role="group" aria-label="確認放棄">
      <p className="auth-warning">{message}</p>
      <div className="modal-actions">
        <button type="button" autoFocus onClick={() => controller.cancelAbandon()}>
          繼續設定
        </button>
        <button type="button" className="danger" onClick={() => controller.confirmAbandon()}>
          確定放棄
        </button>
      </div>
    </div>
  );
}

/** 每 4 字一組，方便手動輸入驗證器；複製後貼上時驗證器 App 會忽略空白 */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}

export function EnableTwoFactorDialog({ operation, controller }: DialogProps<"enableTwoFactor">) {
  const [code, setCode] = useState("");
  const { setup, step, busy } = operation;

  if (setup === null) {
    return (
      <Modal role="dialog" labelledBy="enable-2fa-title" onEscape={() => controller.closeOperation()}>
        <h2 id="enable-2fa-title">開啟兩步驟驗證</h2>
        <OperationFeedback operation={operation} remaining={0} />
        <div className="modal-actions">
          <button type="button" autoFocus onClick={() => controller.closeOperation()} disabled={busy}>
            取消
          </button>
        </div>
      </Modal>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitEnableTwoFactor(code);
  };

  return (
    <Modal role="dialog" labelledBy="enable-2fa-title" onEscape={() => controller.closeOperation()}>
      <h2 id="enable-2fa-title">開啟兩步驟驗證</h2>
      {operation.confirmingAbandon ? (
        <AbandonConfirmation message={SECURITY_MESSAGES.abandonEnable} controller={controller} />
      ) : (
        <>
          {step === "scan" && (
            <>
              <h3>步驟 1／3：綁定驗證器</h3>
              <p>以驗證器 App（例如 Google Authenticator、Microsoft Authenticator）掃描 QR code，或手動輸入秘鑰。</p>
              <img className="totp-qr" src={setup.qrCodeDataUrl} alt="兩步驟驗證 QR code" width={200} height={200} />
              <p>
                手動輸入秘鑰：
                <code className="totp-secret" data-testid="totp-secret">
                  {groupSecret(setup.secret)}
                </code>
              </p>
              <div className="modal-actions">
                <button type="button" onClick={() => controller.requestAbandon()}>
                  放棄
                </button>
                <button type="button" autoFocus onClick={() => controller.goToEnableStep("codes")}>
                  下一步
                </button>
              </div>
            </>
          )}

          {step === "codes" && (
            <>
              <h3>步驟 2／3：保存救援碼</h3>
              <RecoveryCodesBlock
                codes={setup.recoveryCodes}
                acknowledged={operation.acknowledged}
                busy={busy}
                controller={controller}
              />
              <div className="modal-actions">
                <button type="button" onClick={() => controller.requestAbandon()}>
                  放棄
                </button>
                <button type="button" onClick={() => controller.goToEnableStep("scan")}>
                  上一步
                </button>
                <button
                  type="button"
                  onClick={() => controller.goToEnableStep("verify")}
                  disabled={!operation.acknowledged}
                >
                  下一步
                </button>
              </div>
            </>
          )}

          {step === "verify" && (
            <form onSubmit={submit} noValidate>
              <h3>步驟 3／3：輸入驗證碼</h3>
              <p>輸入驗證器 App 目前顯示的 6 位數驗證碼。按下「確認並開啟」後才會開啟兩步驟驗證。</p>
              <label htmlFor="enable-2fa-code">驗證碼</label>
              <input
                id="enable-2fa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy}
              />
              <OperationFeedback operation={operation} remaining={0} />
              <div className="modal-actions">
                <button type="button" onClick={() => controller.requestAbandon()} disabled={busy}>
                  放棄
                </button>
                <button type="button" onClick={() => controller.goToEnableStep("codes")} disabled={busy}>
                  上一步
                </button>
                <button type="submit" disabled={busy}>
                  確認並開啟
                </button>
              </div>
            </form>
          )}
          {step !== "verify" && operation.error && <p role="alert">{operation.error}</p>}
        </>
      )}
    </Modal>
  );
}

export function DisableTwoFactorDialog({ operation, controller }: DialogProps<"disableTwoFactor">) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const remaining = useRemainingSeconds(operation.lockedUntil);
  const { busy, method } = operation;
  const isTotp = method === "totp";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitDisableTwoFactor({ password, code });
  };
  const switchMethod = () => {
    setCode("");
    controller.switchDisableMethod(isTotp ? "recovery" : "totp");
  };

  return (
    <Modal role="dialog" labelledBy="disable-2fa-title" onEscape={() => controller.closeOperation()}>
      <form onSubmit={submit} noValidate>
        <h2 id="disable-2fa-title">關閉兩步驟驗證</h2>
        <p className="auth-warning">{SECURITY_MESSAGES.disableWarning}</p>

        <label htmlFor="disable-2fa-password">主密碼</label>
        <input
          id="disable-2fa-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="disable-2fa-code">{isTotp ? "驗證碼" : "救援碼"}</label>
        <input
          key={method}
          id="disable-2fa-code"
          type={isTotp ? "text" : "password"}
          inputMode={isTotp ? "numeric" : "text"}
          autoComplete={isTotp ? "one-time-code" : "off"}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={busy}
        />
        <button type="button" className="auth-secondary" onClick={switchMethod} disabled={busy}>
          {isTotp ? "改用救援碼" : "改用驗證碼"}
        </button>

        <OperationFeedback operation={operation} remaining={remaining} />
        <div className="modal-actions">
          <button type="button" onClick={() => controller.closeOperation()} disabled={busy}>
            取消
          </button>
          <button type="submit" className="danger" disabled={busy || remaining > 0}>
            關閉兩步驟驗證
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RegenerateRecoveryCodesDialog({ operation, controller }: DialogProps<"regenerateRecoveryCodes">) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const remaining = useRemainingSeconds(operation.lockedUntil);
  const { busy, recoveryCodes } = operation;

  if (recoveryCodes === null) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void controller.submitRegenerateVerification({ password, totpCode });
    };
    return (
      <Modal role="dialog" labelledBy="regenerate-title" onEscape={() => controller.closeOperation()}>
        <form onSubmit={submit} noValidate>
          <h2 id="regenerate-title">補發救援碼</h2>
          <p>{SECURITY_MESSAGES.regenerateNote}</p>
          <label htmlFor="regenerate-password">主密碼</label>
          <input
            id="regenerate-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <label htmlFor="regenerate-totp">驗證碼</label>
          <input
            id="regenerate-totp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
            disabled={busy}
          />
          <OperationFeedback operation={operation} remaining={remaining} />
          <div className="modal-actions">
            <button type="button" onClick={() => controller.closeOperation()} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy || remaining > 0}>
              驗證並產生新救援碼
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal role="dialog" labelledBy="regenerate-title" onEscape={() => controller.closeOperation()}>
      <h2 id="regenerate-title">補發救援碼</h2>
      <p className="auth-warning security-pending">{SECURITY_MESSAGES.codesNotYetActive}</p>
      {operation.confirmingAbandon ? (
        <AbandonConfirmation message={SECURITY_MESSAGES.abandonRegenerate} controller={controller} />
      ) : (
        <>
          <RecoveryCodesBlock
            codes={recoveryCodes}
            acknowledged={operation.acknowledged}
            busy={busy}
            controller={controller}
          />
          <OperationFeedback operation={operation} remaining={0} />
          <div className="modal-actions">
            <button type="button" onClick={() => controller.requestAbandon()} disabled={busy}>
              放棄
            </button>
            <button
              type="button"
              onClick={() => void controller.commitRecoveryCodes()}
              disabled={busy || !operation.acknowledged}
            >
              確認取代
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ExportDialog({ operation, controller }: DialogProps<"export">) {
  const { busy } = operation;
  return (
    <Modal role="dialog" labelledBy="export-title" onEscape={() => controller.closeOperation()}>
      <h2 id="export-title">匯出加密備份</h2>
      <p>{SECURITY_MESSAGES.exportExplanation}</p>
      <OperationFeedback operation={operation} remaining={0} />
      <div className="modal-actions">
        <button type="button" onClick={() => controller.closeOperation()} disabled={busy}>
          取消
        </button>
        <button type="button" autoFocus onClick={() => void controller.submitExport()} disabled={busy}>
          下載加密備份
        </button>
      </div>
    </Modal>
  );
}
