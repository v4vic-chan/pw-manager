import { UNCATEGORIZED_CATEGORY_ID } from "../../../src/services/category";
import type { Category } from "../../../src/types/Category";
import type { Entry } from "../../../src/types/Entry";

/** 條目列表相關測試共用的資料（僅供測試；不含任何功能模組實作） */

export const UNCATEGORIZED_ID = UNCATEGORIZED_CATEGORY_ID;
export const EMAIL_ID = "c0000000-0000-4000-8000-000000000001";
export const WORK_ID = "c0000000-0000-4000-8000-000000000002";

/** 刻意不依 sortIndex 排列，用來驗證畫面層自行排序分類選項 */
export const CATEGORIES: Category[] = [
  { id: WORK_ID, name: "Work", sortIndex: 1, isSystemDefault: false, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: UNCATEGORIZED_ID, name: "未分類", sortIndex: -1, isSystemDefault: true, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: EMAIL_ID, name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-01-01T00:00:00.000Z" },
];

/** 明文密碼各不相同且不會被 appName／accountId 搜尋命中，方便斷言「畫面／狀態中有無此明文」 */
export const ENTRIES: Entry[] = [
  {
    id: "entry-1",
    appName: "GitHub",
    categoryId: WORK_ID,
    accountId: "alice@dev.io",
    password: "pw-github-7Hq2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  },
  {
    id: "entry-2",
    appName: "gmail",
    categoryId: EMAIL_ID,
    accountId: "alice@gmail.com",
    password: "pw-gmail-4Zt9",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  },
  {
    id: "entry-3",
    appName: "Zoo",
    categoryId: UNCATEGORIZED_ID,
    accountId: "zookeeper",
    password: "pw-zoo-8Lm5",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  },
  {
    id: "entry-4",
    appName: "Slack",
    categoryId: WORK_ID,
    accountId: "bob@dev.io",
    password: "pw-slack-2Vc6",
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
  },
];

export const ALL_PASSWORDS: string[] = ENTRIES.map((entry) => entry.password);

/** 模擬 storage.loadEntries()：每次回傳全新的深拷貝，避免測試間共用參照 */
export function cloneEntries(entries: Entry[] = ENTRIES): Entry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function cloneCategories(categories: Category[] = CATEGORIES): Category[] {
  return categories.map((category) => ({ ...category }));
}

/** 畫面層狀態使用的去識別化條目：password 恆為空字串 */
export function redactedEntries(entries: Entry[] = ENTRIES): Entry[] {
  return entries.map((entry) => ({ ...entry, password: "" }));
}
