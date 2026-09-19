import { useSyncExternalStore } from "react";
import { UNCATEGORIZED_CATEGORY_ID } from "../../services/category";
import type { SortKey } from "../../services/search";
import { CategoryPanel } from "./CategoryPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import type { EntriesController } from "./entriesController";
import {
  hasRevealed,
  selectCategoryOptions,
  selectVisibleEntries,
  type ReadyEntriesState,
} from "./entriesMachine";
import { EntryFormDialog } from "./EntryFormDialog";
import {
  ENTRIES_MESSAGES,
  PASSWORD_MASK,
  UNCATEGORIZED_NAME,
  countSummary,
  deleteCategoryMessage,
  deleteCategoryTitle,
  deleteEntryMessage,
  noMatchMessage,
} from "./messages";

/**
 * 條目列表主畫面：查看、搜尋、篩選、排序（規格 §4.4 密碼顯示與複製、§4.5）。
 * 密碼預設以固定長度遮罩顯示；明文只在該筆被使用者主動顯示時才出現在 DOM。
 * 新增／編輯／刪除條目與分類管理的入口也在此（§4.3、§4.4）：表單與確認以模態對話框呈現，
 * 分類管理為可展開的面板；「未分類」的操作按鈕由 CategoryPanel 直接不渲染。
 * 所有操作轉交控制器；本層不接觸 storage，也不持有明文。
 */

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "appName", label: "App 名稱" },
  { value: "category", label: "分類" },
  { value: "createdAt", label: "建立時間" },
  { value: "updatedAt", label: "更新時間" },
];

interface EntriesScreenProps {
  controller: EntriesController;
  onLogout: () => void;
}

export function EntriesScreen({ controller, onLogout }: EntriesScreenProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.phase === "closed") return null;

  return (
    <main className="entries-page">
      <header className="entries-header">
        <h1>{ENTRIES_MESSAGES.title}</h1>
        <div className="entries-header-actions">
          {state.phase === "ready" && (
            <>
              <button type="button" onClick={() => controller.openCreateEntry()}>
                新增條目
              </button>
              <button
                type="button"
                aria-expanded={state.categoryPanel.open}
                onClick={() => controller.toggleCategoryPanel()}
              >
                管理分類
              </button>
            </>
          )}
          <button type="button" onClick={onLogout}>
            登出
          </button>
        </div>
      </header>
      {state.phase === "loading" && <p role="status">{ENTRIES_MESSAGES.loading}</p>}
      {state.phase === "error" && <p role="alert">{state.error}</p>}
      {state.phase === "ready" && <EntriesReady state={state} controller={controller} />}
    </main>
  );
}

function EntriesReady({ state, controller }: { state: ReadyEntriesState; controller: EntriesController }) {
  const visible = selectVisibleEntries(state);
  const total = state.entries.length;
  const categoryNameById = new Map(state.categories.map((category) => [category.id, category.name]));

  return (
    <>
      <section className="entries-controls" aria-label="搜尋、篩選與排序">
        <div className="entries-field">
          <label htmlFor="entries-search">搜尋</label>
          <input
            id="entries-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="App 名稱或帳號"
            value={state.keyword}
            onChange={(event) => controller.setKeyword(event.target.value)}
          />
        </div>

        <div className="entries-field">
          <label htmlFor="entries-sort-key">排序依據</label>
          <select
            id="entries-sort-key"
            value={state.sortKey}
            onChange={(event) => {
              const option = SORT_OPTIONS.find((candidate) => candidate.value === event.target.value);
              if (option) controller.setSortKey(option.value);
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => controller.toggleSortDirection()}>
            排序方向：{state.sortDirection === "asc" ? "升序" : "降序"}
          </button>
        </div>

        <div className="entries-field">
          <fieldset>
            <legend>依分類篩選</legend>
            {selectCategoryOptions(state).map((category) => (
              <label key={category.id} className="entries-checkbox">
                <input
                  type="checkbox"
                  checked={state.categoryIds.includes(category.id)}
                  onChange={() => controller.toggleCategory(category.id)}
                />
                <span>{category.name}</span>
              </label>
            ))}
          </fieldset>
          <button type="button" onClick={() => controller.clearFilter()} disabled={state.categoryIds.length === 0}>
            清除篩選
          </button>
        </div>
      </section>

      {state.categoryPanel.open && (
        <CategoryPanel
          controller={controller}
          categories={selectCategoryOptions(state)}
          busy={state.categoryPanel.busy}
          error={state.categoryPanel.error}
        />
      )}

      {total > 0 && <p className="entries-count">{countSummary(visible.length, total)}</p>}

      {total === 0 && <p className="entries-empty">{ENTRIES_MESSAGES.empty}</p>}
      {total > 0 && visible.length === 0 && (
        <div className="entries-empty">
          <p>{noMatchMessage(total)}</p>
          <button type="button" onClick={() => controller.resetQuery()}>
            清除搜尋與篩選
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <ul className="entries-list" aria-label="條目列表">
          {visible.map((entry) => {
            const revealed = hasRevealed(state, entry.id);
            const notice = state.copyNotice?.entryId === entry.id ? state.copyNotice : null;
            return (
              <li key={entry.id} className="entry-row">
                <div className="entry-main">
                  <h2>{entry.appName}</h2>
                  <span className="entry-account">{entry.accountId}</span>
                  <span className="entry-category">{categoryNameById.get(entry.categoryId) ?? UNCATEGORIZED_NAME}</span>
                </div>
                <div className="entry-secret">
                  <span className="entry-password">{revealed ? state.revealed[entry.id] : PASSWORD_MASK}</span>
                  <button
                    type="button"
                    aria-label={`${revealed ? "隱藏" : "顯示"} ${entry.appName} 的密碼`}
                    onClick={() => (revealed ? controller.hidePassword(entry.id) : controller.revealPassword(entry.id))}
                  >
                    {revealed ? "隱藏" : "顯示"}
                  </button>
                  <button
                    type="button"
                    aria-label={`複製 ${entry.appName} 的帳號`}
                    onClick={() => void controller.copyAccount(entry.id)}
                  >
                    複製帳號
                  </button>
                  <button
                    type="button"
                    aria-label={`複製 ${entry.appName} 的密碼`}
                    onClick={() => void controller.copyPassword(entry.id)}
                  >
                    複製密碼
                  </button>
                  <button
                    type="button"
                    aria-label={`編輯 ${entry.appName}`}
                    onClick={() => controller.openEditEntry(entry.id)}
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`刪除 ${entry.appName}`}
                    onClick={() => controller.openDeleteEntry(entry.id)}
                  >
                    刪除
                  </button>
                </div>
                {notice?.status === "copied" && (
                  <p role="status">
                    {notice.field === "password" ? ENTRIES_MESSAGES.passwordCopied : ENTRIES_MESSAGES.accountCopied}
                  </p>
                )}
                {notice?.status === "failed" && <p role="alert">{ENTRIES_MESSAGES.copyFailed}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <EntriesDialog state={state} controller={controller} />
    </>
  );
}

/** 目前開啟的對話框（同時只有一個）：條目表單、刪除條目確認、刪除分類確認 */
function EntriesDialog({ state, controller }: { state: ReadyEntriesState; controller: EntriesController }) {
  const { dialog } = state;
  if (dialog === null) return null;
  const { target } = dialog;
  const cancel = () => controller.closeDialog();

  switch (target.type) {
    case "entryForm": {
      const entry = target.entryId === null ? undefined : state.entries.find((candidate) => candidate.id === target.entryId);
      return (
        <EntryFormDialog
          key={target.entryId ?? "new"}
          mode={target.entryId === null ? "create" : "edit"}
          initial={
            entry === undefined
              ? { appName: "", accountId: "", categoryId: UNCATEGORIZED_CATEGORY_ID }
              : { appName: entry.appName, accountId: entry.accountId, categoryId: entry.categoryId }
          }
          categories={selectCategoryOptions(state)}
          busy={dialog.busy}
          error={dialog.error}
          onSubmit={(values) => void controller.submitEntryForm(values)}
          onCancel={cancel}
        />
      );
    }

    case "deleteEntry": {
      const entry = state.entries.find((candidate) => candidate.id === target.entryId);
      if (entry === undefined) return null;
      return (
        <ConfirmDialog
          title={ENTRIES_MESSAGES.deleteEntryTitle}
          message={deleteEntryMessage(entry.appName, entry.accountId)}
          confirmLabel={ENTRIES_MESSAGES.deleteEntryConfirm}
          busy={dialog.busy}
          error={dialog.error}
          onConfirm={() => void controller.confirmDeleteEntry()}
          onCancel={cancel}
        />
      );
    }

    case "deleteCategory": {
      const category = state.categories.find((candidate) => candidate.id === target.categoryId);
      if (category === undefined) return null;
      const affected = state.entries.filter((entry) => entry.categoryId === category.id).length;
      return (
        <ConfirmDialog
          title={deleteCategoryTitle(category.name)}
          message={deleteCategoryMessage(affected)}
          confirmLabel={ENTRIES_MESSAGES.deleteCategoryConfirm}
          busy={dialog.busy}
          error={dialog.error}
          onConfirm={() => void controller.confirmDeleteCategory()}
          onCancel={cancel}
        />
      );
    }
  }
}
