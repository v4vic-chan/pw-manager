import { Modal } from "./Modal";

/**
 * 破壞性操作（刪除條目、刪除分類）的二次確認對話框。
 * 預設聚焦「取消」，避免連按 Enter 誤刪；寫入進行中兩個按鈕都停用。
 */

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal role="alertdialog" labelledBy="confirm-title" describedBy="confirm-message" onEscape={onCancel}>
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-message">{message}</p>
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" autoFocus onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "處理中…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
