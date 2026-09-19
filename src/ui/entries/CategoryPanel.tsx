import { useState, type FormEvent } from "react";
import type { Category } from "../../types/Category";
import type { EntriesController } from "./entriesController";
import { validateCategoryName } from "./validation";

/**
 * 分類管理面板（規格 §4.3）：新增、重新命名、上移／下移、刪除（開啟確認對話框）。
 * 「未分類」為系統預設分類（§3.5）：不可重新命名、刪除或調整排序，
 * 因此它的列**不渲染**任何操作按鈕，而不是點了才顯示錯誤。
 * 輸入框的文字為區域狀態；驗證即時提示，控制器與 storage 仍會再驗證。
 */

interface CategoryPanelProps {
  controller: EntriesController;
  /** 已依 sortIndex 排序（「未分類」居首） */
  categories: Category[];
  busy: boolean;
  error: string | null;
}

export function CategoryPanel({ controller, categories, busy, error }: CategoryPanelProps) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const userCategories = categories.filter((category) => !category.isSystemDefault);
  const newNameError = newName === "" ? null : validateCategoryName(newName, categories);
  const canAdd = newName !== "" && newNameError === null && !busy;
  const renameError = renaming === null ? null : validateCategoryName(renaming.value, categories, renaming.id);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    if (await controller.createCategory(newName)) setNewName("");
  };

  const saveRename = async () => {
    if (renaming === null || renameError !== null || busy) return;
    if (await controller.renameCategory(renaming.id, renaming.value)) setRenaming(null);
  };

  return (
    <section className="category-panel" aria-label="分類管理">
      <h2>分類管理</h2>

      <form onSubmit={add} className="category-add">
        <label htmlFor="category-new-name">新分類名稱</label>
        <input
          id="category-new-name"
          type="text"
          autoComplete="off"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          aria-invalid={newNameError !== null}
          aria-describedby="category-new-name-error"
          disabled={busy}
        />
        <button type="submit" disabled={!canAdd}>
          新增分類
        </button>
        {newNameError !== null && (
          <p id="category-new-name-error" className="field-error">
            {newNameError}
          </p>
        )}
      </form>

      {error && <p role="alert">{error}</p>}

      <ul className="category-list" aria-label="分類列表">
        {categories.map((category) => {
          if (category.isSystemDefault) {
            return (
              <li key={category.id} className="category-row">
                <span className="category-name">{category.name}</span>
                <span className="category-badge">系統預設</span>
              </li>
            );
          }

          const index = userCategories.findIndex((candidate) => candidate.id === category.id);
          const activeRename = renaming !== null && renaming.id === category.id ? renaming : null;
          return (
            <li key={category.id} className="category-row">
              {activeRename !== null ? (
                <>
                  <input
                    type="text"
                    autoComplete="off"
                    autoFocus
                    aria-label={`分類「${category.name}」的新名稱`}
                    aria-invalid={renameError !== null}
                    value={activeRename.value}
                    onChange={(event) => setRenaming({ id: category.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveRename();
                      } else if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    disabled={busy}
                  />
                  <button type="button" onClick={() => void saveRename()} disabled={busy || renameError !== null}>
                    儲存名稱
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} disabled={busy}>
                    取消重新命名
                  </button>
                  {renameError !== null && <p className="field-error">{renameError}</p>}
                </>
              ) : (
                <>
                  <span className="category-name">{category.name}</span>
                  <span className="category-actions">
                    <button
                      type="button"
                      aria-label={`重新命名分類 ${category.name}`}
                      onClick={() => setRenaming({ id: category.id, value: category.name })}
                      disabled={busy}
                    >
                      重新命名
                    </button>
                    <button
                      type="button"
                      aria-label={`上移分類 ${category.name}`}
                      onClick={() => void controller.moveCategory(category.id, "up")}
                      disabled={busy || index === 0}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      aria-label={`下移分類 ${category.name}`}
                      onClick={() => void controller.moveCategory(category.id, "down")}
                      disabled={busy || index === userCategories.length - 1}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`刪除分類 ${category.name}`}
                      onClick={() => controller.openDeleteCategory(category.id)}
                      disabled={busy}
                    >
                      刪除
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
