import { describe, test, expect } from "vitest";
import { searchEntries, filterByCategories, sortEntries } from "../../src/services/search";
import type { Category } from "../../src/types/Category";
import type { Entry } from "../../src/types/Entry";

/**
 * 模組：搜尋、排序、篩選模組（規格 §4.5）
 * 對應驗收標準：§6 AC5（搜尋+篩選+排序同時套用時，結果須同時滿足三者條件，且一致可重現）。
 *
 * TDD 紅燈說明：src/services/search.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

const entries: Entry[] = [
  {
    id: "e1",
    appName: "Alpha Mail",
    categoryId: "c1",
    accountId: "alpha@example.com",
    password: "SuperSecretKeyword",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  {
    id: "e2",
    appName: "Beta Bank",
    categoryId: "c2",
    accountId: "beta-user",
    password: "hunter2",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  },
  {
    id: "e3",
    appName: "Gamma Shop",
    categoryId: "c1",
    accountId: "gamma@example.com",
    password: "hunter3",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
];

describe("searchEntries：以 appName、accountId 模糊比對（§4.5）", () => {
  test("happy path：關鍵字比對 appName（模糊，不需完全相符）", () => {
    const result = searchEntries(entries, "Mail");
    expect(result.map((e: Entry) => e.id)).toEqual(["e1"]);
  });

  test("happy path：關鍵字比對 accountId", () => {
    const result = searchEntries(entries, "beta-user");
    expect(result.map((e: Entry) => e.id)).toEqual(["e2"]);
  });

  test("異常路徑：不得搜尋 password 欄位，即使關鍵字僅存在於 password 中也不應命中", () => {
    const result = searchEntries(entries, "SuperSecretKeyword");
    expect(result).toEqual([]);
  });
});

describe("filterByCategories：依分類篩選，支援多選（§4.5）", () => {
  test("happy path：勾選單一分類僅回傳該分類條目", () => {
    const result = filterByCategories(entries, ["c2"]);
    expect(result.map((e: Entry) => e.id)).toEqual(["e2"]);
  });

  test("happy path：勾選多個分類時回傳任一分類命中的條目", () => {
    const result = filterByCategories(entries, ["c1", "c2"]);
    expect(result.map((e: Entry) => e.id).sort()).toEqual(["e1", "e2", "e3"]);
  });
});

describe("sortEntries：至少支援四種排序鍵與正倒序（§4.5）", () => {
  test("邊界：依 appName 正序排序", () => {
    const result = sortEntries(entries, "appName", "asc");
    expect(result.map((e: Entry) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("邊界：依 appName 倒序排序", () => {
    const result = sortEntries(entries, "appName", "desc");
    expect(result.map((e: Entry) => e.id)).toEqual(["e3", "e2", "e1"]);
  });

  test("邊界：依 createdAt 正序排序", () => {
    const result = sortEntries(entries, "createdAt", "asc");
    expect(result.map((e: Entry) => e.id)).toEqual(["e3", "e1", "e2"]);
  });

  test("邊界：依 updatedAt 倒序排序", () => {
    const result = sortEntries(entries, "updatedAt", "desc");
    expect(result.map((e: Entry) => e.id)).toEqual(["e3", "e1", "e2"]);
  });

  // v1.6 §4.5：此排序鍵依 Category.name 字母序（非 categoryId），需傳入分類清單查找名稱。
  const categoriesForSort: Category[] = [
    { id: "c1", name: "Zeta", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    { id: "c2", name: "Alpha", sortIndex: 1, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
  ];

  test("邊界：依 category（Category.name）正序排序", () => {
    const result = sortEntries(entries, "category", "asc", categoriesForSort);
    // c2="Alpha" < c1="Zeta"；同為 c1 的 e1/e3 以 id 次要排序（"e1" < "e3"）
    expect(result.map((e: Entry) => e.id)).toEqual(["e2", "e1", "e3"]);
  });

  test("異常路徑：key=\"category\" 但未提供 categories 應拋錯", () => {
    expect(() => sortEntries(entries, "category", "asc")).toThrow();
  });
});

describe("AC5：搜尋、篩選、排序同時套用，結果須同時滿足三者條件且可重現", () => {
  test("組合套用：搜尋（accountId 含 example.com）+ 篩選（categoryId=c1）+ 排序（appName 倒序）", () => {
    const searched = searchEntries(entries, "example.com");
    const filtered = filterByCategories(searched, ["c1"]);
    const sorted = sortEntries(filtered, "appName", "desc");

    expect(sorted.map((e: Entry) => e.id)).toEqual(["e3", "e1"]);
  });

  test("可重現：相同輸入重複執行組合查詢應得到完全相同的結果", () => {
    const run = () =>
      sortEntries(
        filterByCategories(searchEntries(entries, "example.com"), ["c1"]),
        "appName",
        "desc"
      ).map((e: Entry) => e.id);

    expect(run()).toEqual(run());
  });
});
