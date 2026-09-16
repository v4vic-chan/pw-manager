import { describe, test, expect } from "vitest";
import {
  createCategory,
  renameCategory,
  canDeleteCategory,
  reorderCategories,
} from "../../src/services/category";
import type { Category } from "../../src/types/Category";
import type { Entry } from "../../src/types/Entry";

/**
 * 模組：分類管理模組（規格 §4.3）
 * 對應驗收標準：§6 AC4（刪除分類不得產生孤兒 Entry）。
 * 新增/重新命名的長度與重名限制依 §3.5 Category 約束推導。
 *
 * TDD 紅燈說明：src/services/category.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

describe("createCategory：新增分類（§4.3、§3.5）", () => {
  test("happy path：合法名稱可成功建立分類", () => {
    const category = createCategory("Email", []);
    expect(typeof category.id).toBe("string");
    expect(category.name).toBe("Email");
    expect(typeof category.createdAt).toBe("string");
  });

  test("邊界：名稱長度恰為 1 與 50 皆可成功建立", () => {
    expect(() => createCategory("A", [])).not.toThrow();
    expect(() => createCategory("A".repeat(50), [])).not.toThrow();
  });

  test("邊界：名稱長度為 0 或 51 應被拒絕", () => {
    expect(() => createCategory("", [])).toThrow();
    expect(() => createCategory("A".repeat(51), [])).toThrow();
  });

  test("異常路徑：同名分類不可重複建立", () => {
    const existing: Category[] = [
      { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    ];
    expect(() => createCategory("Email", existing)).toThrow();
  });
});

describe("renameCategory：重新命名分類（§4.3、§3.5）", () => {
  test("happy path：重新命名為未使用過的合法名稱應成功", () => {
    const existing: Category[] = [
      { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    ];
    const renamed = renameCategory("c1", "Work Email", existing);
    expect(renamed.name).toBe("Work Email");
  });

  test("異常路徑：重新命名為已存在的其他分類名稱應被拒絕", () => {
    const existing: Category[] = [
      { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
      { id: "c2", name: "Bank", sortIndex: 1, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    ];
    expect(() => renameCategory("c1", "Bank", existing)).toThrow();
  });
});

// TODO（語意變更，待後續輪次處理）：v1.6 §3.5 規定刪除分類一律自動轉移至「未分類」，
// 不再提供「阻擋刪除」；以下 canDeleteCategory 的阻擋語意沿用 v1.2，本輪僅做欄位改名。
describe("canDeleteCategory：刪除分類不得產生孤兒 Entry（§4.3、AC4）", () => {
  const entryInCategory: Entry = {
    id: "e1",
    appName: "Example",
    categoryId: "c1",
    accountId: "user@example.com",
    password: "secret",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };

  test("happy path：無 Entry 參照該分類時可刪除", () => {
    expect(canDeleteCategory("c1", [])).toBe(true);
  });

  test("AC4：仍有 Entry 參照該分類時必須阻擋刪除", () => {
    expect(canDeleteCategory("c1", [entryInCategory])).toBe(false);
  });
});

describe("reorderCategories：自訂排序（§4.3）", () => {
  test("happy path：將第一項移動至第三個位置後，清單順序依新位置排列", () => {
    const categories: Category[] = [
      { id: "c1", name: "A", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
      { id: "c2", name: "B", sortIndex: 1, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
      { id: "c3", name: "C", sortIndex: 2, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    ];
    const reordered = reorderCategories(categories, 0, 2);
    expect(reordered.map((c: Category) => c.id)).toEqual(["c2", "c3", "c1"]);
  });
});
