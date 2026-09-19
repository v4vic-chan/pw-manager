import { UNCATEGORIZED_CATEGORY_ID, canDeleteCategory } from "../../services/category";
import type { EntryUserFields } from "../../services/entry";
import type { SortKey } from "../../services/search";
import { StorageError, type StorageErrorCode, type VaultStorage } from "../../services/storage";
import type { Category } from "../../types/Category";
import type { Entry } from "../../types/Entry";
import { storageErrorMessage } from "../auth/messages";
import {
  initialEntriesState,
  reduceEntries,
  type CopyField,
  type EntriesEvent,
  type EntriesState,
} from "./entriesMachine";
import { ENTRIES_MESSAGES, UNCATEGORIZED_NAME, loadErrorMessage } from "./messages";
import { validateCategoryName, validateEntryForm, type EntryFormValues } from "./validation";

/**
 * 條目列表控制器：持有狀態機、呼叫 Service Layer（storage.ts）並管理明文密碼與剪貼簿的生命週期。
 *
 * 明文處理（§2.3、§5.1.4）：storage.loadEntries() 一次回傳全部解密後的 Entry[]，無法逐筆解密；
 * 因此明文只保留在本閉包內的 secrets Map（不進入 reducer 狀態、React 狀態與 DOM），
 * 畫面狀態只有在使用者主動顯示時才含該筆明文。dispose()（登出、閒置逾時、畫面卸載）時整個清空。
 * 表單輸入的密碼只當參數傳給 storage，不保存於狀態。不使用 console，避免明文落入任何日誌。
 *
 * 寫入（§4.3、§4.4）：先做提交前驗證（UI 層防呆），再呼叫 storage（其驗證為第二層）；
 * 成功後重新讀取 loadEntries()／loadCategories()，保留搜尋、篩選、排序與仍存在條目的顯示狀態。
 */

export type EntriesStorage = Pick<
  VaultStorage,
  | "loadEntries"
  | "loadCategories"
  | "addEntry"
  | "editEntry"
  | "removeEntry"
  | "addCategory"
  | "renameCategory"
  | "reorderCategories"
  | "removeCategory"
>;

/** navigator.clipboard 的最小子集；readText 可能因權限或瀏覽器支援度而不存在 */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText?(): Promise<string>;
}

export interface EntriesControllerDeps {
  storage: EntriesStorage;
  /** 缺少（例如非安全環境）時，複製一律提示失敗 */
  clipboard?: ClipboardLike;
  /**
   * 寫入時發現 session 已失效（NOT_AUTHENTICATED／KEY_GENERATION_MISMATCH）：
   * 先顯示提示，經 SESSION_LOST_LOGOUT_MS 後呼叫（瀏覽器中為 authController.logout()）
   */
  onSessionLost?: () => void;
}

/** 複製結果提示停留時間 */
export const COPY_NOTICE_MS = 2000;

/** §4.4（非強制驗收）：複製密碼後嘗試清除剪貼簿的等待時間 */
export const CLIPBOARD_CLEAR_MS = 30_000;

/** session 失效提示顯示多久後自動登出，讓使用者來得及看到原因 */
export const SESSION_LOST_LOGOUT_MS = 3000;

export interface EntriesController {
  getState(): EntriesState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  setKeyword(keyword: string): void;
  toggleCategory(categoryId: string): void;
  /** 只清除分類勾選 */
  clearFilter(): void;
  /** 清除關鍵字與分類勾選，保留排序 */
  resetQuery(): void;
  setSortKey(key: SortKey): void;
  toggleSortDirection(): void;
  revealPassword(entryId: string): void;
  hidePassword(entryId: string): void;
  copyPassword(entryId: string): Promise<void>;
  copyAccount(entryId: string): Promise<void>;

  openCreateEntry(): void;
  openEditEntry(entryId: string): void;
  openDeleteEntry(entryId: string): void;
  /** 「未分類」不可刪除，不會開啟對話框 */
  openDeleteCategory(categoryId: string): void;
  /** 寫入進行中不可關閉 */
  closeDialog(): void;
  toggleCategoryPanel(): void;

  /** 依目前開啟的表單（新增或編輯）送出；編輯時密碼留空表示不變更 */
  submitEntryForm(values: EntryFormValues): Promise<void>;
  confirmDeleteEntry(): Promise<void>;
  /** 回傳是否成功，畫面據此清空輸入框 */
  createCategory(name: string): Promise<boolean>;
  renameCategory(categoryId: string, name: string): Promise<boolean>;
  moveCategory(categoryId: string, direction: "up" | "down"): Promise<void>;
  confirmDeleteCategory(): Promise<void>;

  /** 捨棄所有明文與計時器，並盡力清除剪貼簿中殘留的密碼；之後所有操作皆無效 */
  dispose(): void;
}

/** 畫面層防守：sortEntries(key="category") 遇到找不到分類會拋錯，故確保分類清單一定含「未分類」 */
function withUncategorized(categories: Category[]): Category[] {
  if (categories.some((category) => category.id === UNCATEGORIZED_CATEGORY_ID)) return categories;
  return [
    {
      id: UNCATEGORIZED_CATEGORY_ID,
      name: UNCATEGORIZED_NAME,
      sortIndex: -1,
      isSystemDefault: true,
      createdAt: new Date(0).toISOString(),
    },
    ...categories,
  ];
}

/** session 已失效的錯誤碼：storage 已清除 session，後續寫入都不可能成功 */
function sessionLostCode(error: unknown): StorageErrorCode | null {
  if (error instanceof StorageError && (error.code === "NOT_AUTHENTICATED" || error.code === "KEY_GENERATION_MISMATCH")) {
    return error.code;
  }
  return null;
}

/**
 * storage 拒絕寫入時的使用者文案。services 只有 StorageError 帶錯誤碼；欄位規則不符為 RangeError，
 * 其餘（含分類重名的普通 Error）一律通用文案——重名已在提交前以相同規則檢查，storage 收到的分類清單與
 * UI 檢查時完全相同，因此 storage 端的重名拒絕實際上不會發生。內部訊息不外洩。
 */
function describeWriteError(error: unknown): string {
  if (error instanceof StorageError) return storageErrorMessage(error.code);
  if (error instanceof RangeError) return ENTRIES_MESSAGES.validationRejected;
  return ENTRIES_MESSAGES.writeFailed;
}

/** 寫入的結果呈現位置：對話框（條目表單與刪除確認）或分類管理面板 */
interface WriteChannel {
  canStart(): boolean;
  begin(): void;
  fail(message: string): void;
  done(): void;
}

export function createEntriesController(deps: EntriesControllerDeps): EntriesController {
  const { storage, clipboard } = deps;

  let state: EntriesState = initialEntriesState;
  const listeners = new Set<() => void>();
  /** entryId → 明文密碼；僅存在於此閉包 */
  const secrets = new Map<string, string>();
  let started = false;
  let disposed = false;
  let sessionLost = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionLostTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次寫入剪貼簿的密碼與其清除計時器；到期或關閉時才比對並清除 */
  let pendingClear: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  function dispatch(event: EntriesEvent): void {
    const next = reduceEntries(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  /**
   * best-effort：只有剪貼簿內容仍是我們寫入的值才清除；
   * 無法讀取（權限被拒、瀏覽器不支援、頁面失焦）時放棄，絕不無條件清空以免誤清使用者之後複製的內容。
   */
  async function clearClipboardIfUnchanged(expected: string): Promise<void> {
    if (clipboard === undefined || clipboard.readText === undefined) return;
    try {
      if ((await clipboard.readText()) === expected) await clipboard.writeText("");
    } catch {
      // 放棄清除
    }
  }

  function scheduleClipboardClear(text: string): void {
    if (pendingClear !== null) clearTimeout(pendingClear.timer);
    const timer = setTimeout(() => {
      const pending = pendingClear;
      pendingClear = null;
      if (pending !== null) void clearClipboardIfUnchanged(pending.text);
    }, CLIPBOARD_CLEAR_MS);
    pendingClear = { text, timer };
  }

  function showCopyNotice(entryId: string, field: CopyField, status: "copied" | "failed"): void {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    dispatch({ type: "COPY_NOTICE_SHOWN", notice: { entryId, field, status } });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      dispatch({ type: "COPY_NOTICE_CLEARED" });
    }, COPY_NOTICE_MS);
  }

  function textToCopy(entryId: string, field: CopyField): string | undefined {
    if (state.phase !== "ready") return undefined;
    if (field === "password") return secrets.get(entryId);
    return state.entries.find((entry) => entry.id === entryId)?.accountId;
  }

  async function copy(entryId: string, field: CopyField): Promise<void> {
    const text = textToCopy(entryId, field);
    if (text === undefined) return;

    try {
      if (clipboard === undefined) throw new Error("clipboard unavailable");
      await clipboard.writeText(text);
    } catch {
      if (!disposed) showCopyNotice(entryId, field, "failed");
      return;
    }

    if (disposed) {
      // 寫入完成前就已關閉：密碼已在剪貼簿上，立即嘗試清除
      if (field === "password") void clearClipboardIfUnchanged(text);
      return;
    }
    if (field === "password") scheduleClipboardClear(text);
    showCopyNotice(entryId, field, "copied");
  }

  /**
   * 載入結果轉成畫面資料：明文收進 secrets（先清空舊的），狀態中的條目去識別化。
   * AC4 保證不會有孤兒條目；仍於顯示層將其視為「未分類」（不寫回資料），確保排序前置條件成立。
   */
  function ingest(entries: Entry[], categories: Category[]): { redacted: Entry[]; displayCategories: Category[] } {
    const displayCategories = withUncategorized(categories);
    const knownCategoryIds = new Set(displayCategories.map((category) => category.id));
    secrets.clear();
    const redacted = entries.map((entry) => {
      secrets.set(entry.id, entry.password);
      return {
        ...entry,
        categoryId: knownCategoryIds.has(entry.categoryId) ? entry.categoryId : UNCATEGORIZED_CATEGORY_ID,
        password: "",
      };
    });
    return { redacted, displayCategories };
  }

  /** 寫入成功後重新讀取；已顯示的明文以新讀到的為準（編輯密碼後會更新，條目被刪除後移除） */
  async function reload(): Promise<void> {
    const [entries, categories] = await Promise.all([storage.loadEntries(), storage.loadCategories()]);
    if (disposed) return;

    const previouslyRevealed = state.phase === "ready" ? Object.keys(state.revealed) : [];
    const { redacted, displayCategories } = ingest(entries, categories);
    const revealed: Record<string, string> = {};
    for (const entryId of previouslyRevealed) {
      const password = secrets.get(entryId);
      if (password !== undefined) revealed[entryId] = password;
    }
    dispatch({ type: "RELOADED", entries: redacted, categories: displayCategories, revealed });
  }

  function scheduleSessionLostLogout(): void {
    if (sessionLostTimer !== null) return;
    sessionLostTimer = setTimeout(() => {
      sessionLostTimer = null;
      deps.onSessionLost?.();
    }, SESSION_LOST_LOGOUT_MS);
  }

  const dialogChannel: WriteChannel = {
    canStart: () => state.phase === "ready" && state.dialog !== null && !state.dialog.busy,
    begin: () => dispatch({ type: "DIALOG_SUBMITTING" }),
    fail: (error) => dispatch({ type: "DIALOG_FAILED", error }),
    done: () => dispatch({ type: "DIALOG_CLOSED" }),
  };

  const panelChannel: WriteChannel = {
    canStart: () => state.phase === "ready" && !state.categoryPanel.busy,
    begin: () => dispatch({ type: "CATEGORY_PANEL_SUBMITTING" }),
    fail: (error) => dispatch({ type: "CATEGORY_PANEL_FAILED", error }),
    done: () => dispatch({ type: "CATEGORY_PANEL_IDLE" }),
  };

  function reportWriteError(channel: WriteChannel, error: unknown): void {
    const code = sessionLostCode(error);
    if (code === null) {
      channel.fail(describeWriteError(error));
      return;
    }
    // storage 已清除 session，之後任何寫入都不會成功：先讓使用者看到原因，再自動登出
    sessionLost = true;
    channel.fail(`${storageErrorMessage(code)}${ENTRIES_MESSAGES.sessionLostSuffix}`);
    scheduleSessionLostLogout();
  }

  /** 寫入 → 重新讀取 → 完成。回傳是否整個流程成功；任何一步失敗都保留畫面（對話框／面板）並顯示文案 */
  async function runWrite(channel: WriteChannel, write: () => Promise<void>): Promise<boolean> {
    if (disposed || sessionLost || !channel.canStart()) return false;
    channel.begin();

    try {
      await write();
    } catch (error) {
      if (!disposed) reportWriteError(channel, error);
      return false;
    }
    if (disposed) return false;

    try {
      await reload();
    } catch (error) {
      if (!disposed) {
        if (sessionLostCode(error) !== null) reportWriteError(channel, error);
        else channel.fail(ENTRIES_MESSAGES.reloadFailed);
      }
      return false;
    }
    if (disposed) return false;

    channel.done();
    return true;
  }

  function canWriteFromPanel(): boolean {
    return !disposed && !sessionLost && state.phase === "ready" && !state.categoryPanel.busy;
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load() {
      if (started || disposed) return;
      started = true;
      try {
        const [entries, categories] = await Promise.all([storage.loadEntries(), storage.loadCategories()]);
        if (disposed) return;
        const { redacted, displayCategories } = ingest(entries, categories);
        dispatch({ type: "LOADED", entries: redacted, categories: displayCategories });
      } catch (error) {
        if (!disposed) dispatch({ type: "LOAD_FAILED", error: loadErrorMessage(error) });
      }
    },

    setKeyword: (keyword) => dispatch({ type: "KEYWORD_CHANGED", keyword }),
    toggleCategory: (categoryId) => dispatch({ type: "CATEGORY_TOGGLED", categoryId }),
    clearFilter: () => dispatch({ type: "FILTER_CLEARED" }),
    resetQuery: () => dispatch({ type: "QUERY_RESET" }),
    setSortKey: (key) => dispatch({ type: "SORT_KEY_CHANGED", key }),
    toggleSortDirection: () => dispatch({ type: "SORT_DIRECTION_TOGGLED" }),

    revealPassword(entryId) {
      const password = secrets.get(entryId);
      if (state.phase !== "ready" || password === undefined) return;
      dispatch({ type: "PASSWORD_REVEALED", entryId, password });
    },

    hidePassword: (entryId) => dispatch({ type: "PASSWORD_HIDDEN", entryId }),

    copyPassword: (entryId) => copy(entryId, "password"),
    copyAccount: (entryId) => copy(entryId, "account"),

    openCreateEntry: () => dispatch({ type: "DIALOG_OPENED", target: { type: "entryForm", entryId: null } }),
    openEditEntry: (entryId) => dispatch({ type: "DIALOG_OPENED", target: { type: "entryForm", entryId } }),
    openDeleteEntry: (entryId) => dispatch({ type: "DIALOG_OPENED", target: { type: "deleteEntry", entryId } }),
    openDeleteCategory: (categoryId) => dispatch({ type: "DIALOG_OPENED", target: { type: "deleteCategory", categoryId } }),

    closeDialog() {
      if (state.phase === "ready" && state.dialog !== null && !state.dialog.busy) dispatch({ type: "DIALOG_CLOSED" });
    },

    toggleCategoryPanel: () => dispatch({ type: "CATEGORY_PANEL_TOGGLED" }),

    async submitEntryForm(values) {
      if (disposed || sessionLost || state.phase !== "ready") return;
      const { dialog, categories, entries } = state;
      if (dialog === null || dialog.busy || dialog.target.type !== "entryForm") return;
      const { entryId } = dialog.target;

      const errors = validateEntryForm(values, { mode: entryId === null ? "create" : "edit", categories });
      if (Object.keys(errors).length > 0) {
        dispatch({ type: "DIALOG_FAILED", error: ENTRIES_MESSAGES.formInvalid });
        return;
      }

      await runWrite(dialogChannel, async () => {
        if (entryId === null) {
          await storage.addEntry(
            {
              appName: values.appName,
              categoryId: values.categoryId,
              accountId: values.accountId,
              password: values.password,
            },
            categories
          );
          return;
        }

        const current = entries.find((entry) => entry.id === entryId);
        const originalPassword = secrets.get(entryId);
        if (current === undefined || originalPassword === undefined) throw new Error("entry not found");

        // original 帶真實密碼，updateEntry 才能正確判斷密碼是否真的變更（避免重新輸入相同密碼時誤更新 updatedAt）
        const changes: Partial<EntryUserFields> = {
          appName: values.appName,
          accountId: values.accountId,
          categoryId: values.categoryId,
        };
        if (values.password !== "") changes.password = values.password;
        await storage.editEntry({ ...current, password: originalPassword }, changes, categories);
      });
    },

    async confirmDeleteEntry() {
      if (state.phase !== "ready" || state.dialog === null || state.dialog.target.type !== "deleteEntry") return;
      const { entryId } = state.dialog.target;
      const { entries } = state;
      await runWrite(dialogChannel, async () => {
        await storage.removeEntry(entries, entryId, true);
      });
    },

    async createCategory(name) {
      if (!canWriteFromPanel() || state.phase !== "ready") return false;
      const { categories } = state;
      const error = validateCategoryName(name, categories);
      if (error !== null) {
        dispatch({ type: "CATEGORY_PANEL_FAILED", error });
        return false;
      }
      return runWrite(panelChannel, async () => {
        await storage.addCategory(name, categories);
      });
    },

    async renameCategory(categoryId, name) {
      if (!canWriteFromPanel() || state.phase !== "ready") return false;
      const { categories } = state;
      const target = categories.find((category) => category.id === categoryId);
      // 「未分類」不可重新命名（§3.5）：UI 不渲染按鈕，此處為第二道防線
      if (target === undefined || target.isSystemDefault) return false;

      const error = validateCategoryName(name, categories, categoryId);
      if (error !== null) {
        dispatch({ type: "CATEGORY_PANEL_FAILED", error });
        return false;
      }
      return runWrite(panelChannel, async () => {
        await storage.renameCategory(categoryId, name, categories);
      });
    },

    async moveCategory(categoryId, direction) {
      if (!canWriteFromPanel() || state.phase !== "ready") return;
      // §4.3：僅使用者分類可調整順序，「未分類」固定居首；位置以依 sortIndex 排序後的使用者分類為準
      const userCategories = state.categories
        .filter((category) => !category.isSystemDefault)
        .sort((a, b) => a.sortIndex - b.sortIndex);
      const from = userCategories.findIndex((category) => category.id === categoryId);
      const to = direction === "up" ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= userCategories.length) return;

      await runWrite(panelChannel, async () => {
        await storage.reorderCategories(userCategories, from, to);
      });
    },

    async confirmDeleteCategory() {
      if (state.phase !== "ready" || state.dialog === null || state.dialog.target.type !== "deleteCategory") return;
      const { categoryId } = state.dialog.target;
      const { categories, entries } = state;
      if (!canDeleteCategory(categoryId, categories)) return;

      // §3.5、AC4：分類刪除與條目轉移「未分類」由 storage 於同一交易完成
      await runWrite(dialogChannel, async () => {
        await storage.removeCategory(categoryId, categories, entries);
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      secrets.clear();
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = null;
      if (sessionLostTimer !== null) clearTimeout(sessionLostTimer);
      sessionLostTimer = null;
      const pending = pendingClear;
      pendingClear = null;
      if (pending !== null) {
        clearTimeout(pending.timer);
        void clearClipboardIfUnchanged(pending.text);
      }
      dispatch({ type: "CLOSED" });
    },
  };
}
