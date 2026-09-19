import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * 自製模態對話框（不使用 <dialog>.showModal：jsdom 支援不穩）：
 * Esc 觸發 onEscape、Tab 焦點限制在對話框內、關閉時焦點回到開啟前的元素。
 * 初始焦點由子元素的 autoFocus 決定（表單聚焦第一欄、刪除確認聚焦「取消」）。
 * 點擊背景不會關閉，避免誤觸丟失輸入。
 */

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  role: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  onEscape: () => void;
  children: ReactNode;
}

export function Modal({ role, labelledBy, describedBy, onEscape, children }: ModalProps) {
  // 於 render 階段記下開啟前的焦點：子元素 autoFocus 在 commit 時就會搶走焦點，等到 effect 才記就太晚
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => opener?.focus?.(), [opener]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== "Tab" || dialogRef.current === null) return;

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
