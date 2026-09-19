import { vi } from "vitest";
import {
  canDeleteCategory,
  createCategory,
  reassignEntriesToUncategorized,
  renameCategory,
  reorderCategories,
} from "../../../src/services/category";
import { createEntry, deleteEntry, updateEntry } from "../../../src/services/entry";
import type { EntriesStorage } from "../../../src/ui/entries/entriesController";
import type { Category } from "../../../src/types/Category";
import type { Entry } from "../../../src/types/Entry";
import { CATEGORIES, ENTRIES, cloneCategories, cloneEntries } from "./entriesFixtures";

/**
 * 有狀態的假 storage：以真實 service 純函式（createEntry／updateEntry／createCategory…）模擬
 * storage.ts 的寫入行為與驗證，寫入後 loadEntries／loadCategories 會反映結果。
 * 每個方法都是 vi.fn，測試可用 overrides 換成拒絕或延遲版本。僅供測試。
 */
export interface FakeVault {
  storage: EntriesStorage;
  getEntries(): Entry[];
  getCategories(): Category[];
}

export function createFakeVault(
  options: { entries?: Entry[]; categories?: Category[]; overrides?: Partial<EntriesStorage> } = {}
): FakeVault {
  let entries = cloneEntries(options.entries ?? ENTRIES);
  let categories = cloneCategories(options.categories ?? CATEGORIES);

  const storage: EntriesStorage = {
    loadEntries: vi.fn<EntriesStorage["loadEntries"]>(async () => cloneEntries(entries)),
    loadCategories: vi.fn<EntriesStorage["loadCategories"]>(async () => cloneCategories(categories)),

    addEntry: vi.fn<EntriesStorage["addEntry"]>(async (input, existingCategories) => {
      const entry = createEntry(input, existingCategories);
      entries = [...entries, entry];
      return { ...entry };
    }),
    editEntry: vi.fn<EntriesStorage["editEntry"]>(async (original, changes, existingCategories) => {
      const updated = updateEntry(original, changes, existingCategories);
      entries = entries.map((entry) => (entry.id === updated.id ? updated : entry));
      return { ...updated };
    }),
    removeEntry: vi.fn<EntriesStorage["removeEntry"]>(async (list, entryId, confirmed) => {
      const remaining = deleteEntry(list, entryId, confirmed);
      const removedIds = new Set(list.filter((entry) => !remaining.includes(entry)).map((entry) => entry.id));
      entries = entries.filter((entry) => !removedIds.has(entry.id));
      return remaining;
    }),

    addCategory: vi.fn<EntriesStorage["addCategory"]>(async (name, existing) => {
      const category = createCategory(name, existing);
      categories = [...categories, category];
      return { ...category };
    }),
    renameCategory: vi.fn<EntriesStorage["renameCategory"]>(async (categoryId, newName, existing) => {
      const renamed = renameCategory(categoryId, newName, existing);
      categories = categories.map((category) => (category.id === categoryId ? renamed : category));
      return { ...renamed };
    }),
    reorderCategories: vi.fn<EntriesStorage["reorderCategories"]>(async (userCategories, fromIndex, toIndex) => {
      const reordered = reorderCategories(userCategories, fromIndex, toIndex);
      categories = categories.map((category) => reordered.find((item) => item.id === category.id) ?? category);
      return reordered;
    }),
    removeCategory: vi.fn<EntriesStorage["removeCategory"]>(async (categoryId, existing, list) => {
      if (!canDeleteCategory(categoryId, existing)) throw new RangeError(`此分類不可刪除或不存在：${categoryId}`);
      const moved = reassignEntriesToUncategorized(categoryId, list);
      categories = categories.filter((category) => category.id !== categoryId);
      entries = entries.map((entry) => moved.find((item) => item.id === entry.id) ?? entry);
      return moved;
    }),

    ...options.overrides,
  };

  return { storage, getEntries: () => entries, getCategories: () => categories };
}

/** 可手動放行／拒絕的 Promise，用來測試寫入進行中的狀態 */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
