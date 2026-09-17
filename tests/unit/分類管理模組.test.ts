import { describe, test, expect } from "vitest";
import {
  createCategory,
  renameCategory,
  canDeleteCategory,
  reorderCategories,
  reassignEntriesToUncategorized,
  UNCATEGORIZED_CATEGORY_ID,
} from "../../src/services/category";
import type { Category } from "../../src/types/Category";
import type { Entry } from "../../src/types/Entry";

/**
 * 模組：分類管理模組（規格 §4.3）
 * 對應驗收標準：§6 AC4（刪除分類時所有原參照該分類的 Entry 須轉移至「未分類」，不得產生孤兒 Entry）。
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

  // 補充邊界：長度檢查通過原始字元數，但 trim 後為空/近乎無內容，視為無意義名稱應拒絕
  test("邊界：純空白名稱（trim 後長度為 0）應拒絕", () => {
    expect(() => createCategory("   ", [])).toThrow();
    expect(() => createCategory("\t\n ", [])).toThrow();
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

  test("邊界：重新命名為純空白名稱（trim 後長度為 0）應拒絕", () => {
    const existing: Category[] = [
      { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    ];
    expect(() => renameCategory("c1", "   ", existing)).toThrow();
  });
});

// v1.6 §3.5／§6 AC4：刪除分類一律自動轉移其下 Entry 至「未分類」，不再提供「阻擋刪除」；
// 唯一的刪除限制是系統預設「未分類」本身不可刪除（§4.3：「刪除（『未分類』除外）」）。
describe("canDeleteCategory：僅「未分類」不可刪除（§3.5、§4.3）", () => {
  const categories: Category[] = [
    { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
    {
      id: UNCATEGORIZED_CATEGORY_ID,
      name: "未分類",
      sortIndex: -1,
      isSystemDefault: true,
      createdAt: "2026-09-14T00:00:00.000Z",
    },
  ];

  test("happy path：使用者分類（含仍有 Entry 參照）可刪除", () => {
    expect(canDeleteCategory("c1", categories)).toBe(true);
  });

  test("異常路徑：系統預設「未分類」不可刪除", () => {
    expect(canDeleteCategory(UNCATEGORIZED_CATEGORY_ID, categories)).toBe(false);
  });
});

describe("reassignEntriesToUncategorized：刪除分類時的 Entry 轉移（§3.5、§6 AC4）", () => {
  const entryInCategory: Entry = {
    id: "e1",
    appName: "Example",
    categoryId: "c1",
    accountId: "user@example.com",
    password: "secret",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
  const entryInOtherCategory: Entry = { ...entryInCategory, id: "e2", categoryId: "c2" };

  test("happy path：僅回傳參照該分類的 Entry，categoryId 改為「未分類」nil UUID", () => {
    const result = reassignEntriesToUncategorized("c1", [entryInCategory, entryInOtherCategory]);
    expect(result).toEqual([{ ...entryInCategory, categoryId: UNCATEGORIZED_CATEGORY_ID }]);
  });

  test("AC4：不更新 updatedAt，且不修改傳入的原陣列（純函式）", () => {
    const original = [entryInCategory];
    const result = reassignEntriesToUncategorized("c1", original);
    expect(result[0].updatedAt).toBe(entryInCategory.updatedAt);
    expect(original[0].categoryId).toBe("c1");
  });

  test("無 Entry 參照該分類時回傳空陣列", () => {
    expect(reassignEntriesToUncategorized("c1", [entryInOtherCategory])).toEqual([]);
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
