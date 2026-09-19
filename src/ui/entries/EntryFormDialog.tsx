import { useState, type FormEvent } from "react";
import type { Category } from "../../types/Category";
import { Modal } from "./Modal";
import { generatePassword } from "./passwordGenerator";
import {
  isWeakPassword,
  validateEntryForm,
  type EntryFormField,
  type EntryFormValues,
} from "./validation";

/**
 * 新增／編輯條目表單（規格 §4.4：appName、accountId、password、categoryId 四個欄位）。
 * 欄位值只存在於本元件的區域狀態，關閉即捨棄；密碼欄預設遮罩，可切換顯示或產生隨機密碼。
 * 編輯時密碼欄預設留空（不預填明文，避免現有密碼進入 DOM 屬性），有輸入才送出新密碼。
 * 驗證於輸入與失焦時即時提示；送出時仍會由控制器與 storage 再驗證一次。
 */

interface EntryFormDialogProps {
  mode: "create" | "edit";
  initial: Pick<EntryFormValues, "appName" | "accountId" | "categoryId">;
  /** 已依 sortIndex 排序的分類選項（「未分類」居首） */
  categories: Category[];
  busy: boolean;
  error: string | null;
  onSubmit: (values: EntryFormValues) => void;
  onCancel: () => void;
}

const FIELDS: EntryFormField[] = ["appName", "accountId", "password", "categoryId"];

const WEAK_PASSWORD_WARNING = "密碼少於 8 個字元，強度偏弱（仍可儲存）";

export function EntryFormDialog({ mode, initial, categories, busy, error, onSubmit, onCancel }: EntryFormDialogProps) {
  const [values, setValues] = useState<EntryFormValues>({ ...initial, password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<EntryFormField>>(new Set());

  const errors = validateEntryForm(values, { mode, categories });
  const visibleError = (field: EntryFormField): string | undefined => (touched.has(field) ? errors[field] : undefined);

  const touch = (field: EntryFormField) => setTouched((current) => new Set(current).add(field));
  const change = (field: EntryFormField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    touch(field);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (Object.keys(errors).length > 0) {
      setTouched(new Set(FIELDS));
      return;
    }
    onSubmit(values);
  };

  const title = mode === "create" ? "新增條目" : "編輯條目";

  return (
    <Modal role="dialog" labelledBy="entry-form-title" onEscape={onCancel}>
      <form onSubmit={submit} noValidate>
        <h2 id="entry-form-title">{title}</h2>

        <label htmlFor="entry-form-app-name">App 名稱</label>
        <input
          id="entry-form-app-name"
          type="text"
          autoComplete="off"
          autoFocus
          value={values.appName}
          onChange={(event) => change("appName", event.target.value)}
          onBlur={() => touch("appName")}
          aria-invalid={visibleError("appName") !== undefined}
          aria-describedby="entry-form-app-name-error"
          disabled={busy}
        />
        <FieldError id="entry-form-app-name-error" message={visibleError("appName")} />

        <label htmlFor="entry-form-account-id">帳號</label>
        <input
          id="entry-form-account-id"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={values.accountId}
          onChange={(event) => change("accountId", event.target.value)}
          onBlur={() => touch("accountId")}
          aria-invalid={visibleError("accountId") !== undefined}
          aria-describedby="entry-form-account-id-error"
          disabled={busy}
        />
        <FieldError id="entry-form-account-id-error" message={visibleError("accountId")} />

        <label htmlFor="entry-form-password">密碼</label>
        <div className="entry-form-password">
          <input
            id="entry-form-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={mode === "edit" ? "留空表示不變更" : undefined}
            value={values.password}
            onChange={(event) => change("password", event.target.value)}
            onBlur={() => touch("password")}
            aria-invalid={visibleError("password") !== undefined}
            aria-describedby="entry-form-password-error"
            disabled={busy}
          />
          <button type="button" onClick={() => setShowPassword((current) => !current)}>
            {showPassword ? "隱藏密碼" : "顯示密碼"}
          </button>
          <button type="button" onClick={() => change("password", generatePassword())} disabled={busy}>
            產生隨機密碼
          </button>
        </div>
        <FieldError id="entry-form-password-error" message={visibleError("password")} />
        {isWeakPassword(values.password) && <p className="field-warning">{WEAK_PASSWORD_WARNING}</p>}

        <label htmlFor="entry-form-category">分類</label>
        <select
          id="entry-form-category"
          value={values.categoryId}
          onChange={(event) => change("categoryId", event.target.value)}
          aria-invalid={visibleError("categoryId") !== undefined}
          aria-describedby="entry-form-category-error"
          disabled={busy}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <FieldError id="entry-form-category-error" message={visibleError("categoryId")} />

        {error && <p role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "儲存中…" : "儲存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message === undefined ? null : (
    <p id={id} className="field-error">
      {message}
    </p>
  );
}
