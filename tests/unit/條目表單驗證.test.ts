import { describe, test, expect } from "vitest";
import {
  ACCOUNT_ID_MAX_LENGTH,
  APP_NAME_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  isWeakPassword,
  validateCategoryName,
  validateEntryForm,
  type EntryFormValues,
} from "../../src/ui/entries/validation";
import { createCategory, renameCategory } from "../../src/services/category";
import { createEntry, updateEntry } from "../../src/services/entry";
import type { Category } from "../../src/types/Category";
import { CATEGORIES, ENTRIES, EMAIL_ID, WORK_ID } from "./_shared/entriesFixtures";

/**
 * 模組：條目／分類表單的即時驗證（UI 層純函式）
 * 對應規格 §3.3（appName 1–100、accountId 1–200、password ≥ 1）、§3.5（分類名稱 1–50、重名判斷）。
 * services 的長度常數為 private，UI 端重複定義；本檔以真實 service 行為對照，防止兩邊漂移。
 */

const VALID: EntryFormValues = {
  appName: "Example",
  accountId: "user@example.com",
  password: "secret-pw",
  categoryId: WORK_ID,
};

const serviceAccepts = (fn: () => unknown): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

describe("常數與規格一致", () => {
  test("長度上限", () => {
    expect(APP_NAME_MAX_LENGTH).toBe(100);
    expect(ACCOUNT_ID_MAX_LENGTH).toBe(200);
    expect(CATEGORY_NAME_MAX_LENGTH).toBe(50);
  });
});

describe("validateEntryForm：新增", () => {
  test("合法輸入沒有錯誤", () => {
    expect(validateEntryForm(VALID, { mode: "create", categories: CATEGORIES })).toEqual({});
  });

  test("appName：必填、上限 100，以 NFC 正規化後計算長度", () => {
    const check = (appName: string) => validateEntryForm({ ...VALID, appName }, { mode: "create", categories: CATEGORIES });
    expect(check("").appName).toBe("請輸入 App 名稱");
    expect(check("a".repeat(100)).appName).toBeUndefined();
    expect(check("a".repeat(101)).appName).toBe("App 名稱最多 100 個字元");
    // NFD 的 é（2 個 code unit）正規化後為 1 個
    expect(check("é".repeat(51)).appName).toBeUndefined();
    expect(check("é".repeat(101)).appName).toBe("App 名稱最多 100 個字元");
  });

  test("accountId：必填、上限 200", () => {
    const check = (accountId: string) => validateEntryForm({ ...VALID, accountId }, { mode: "create", categories: CATEGORIES });
    expect(check("").accountId).toBe("請輸入帳號");
    expect(check("a".repeat(200)).accountId).toBeUndefined();
    expect(check("a".repeat(201)).accountId).toBe("帳號最多 200 個字元");
  });

  test("password：新增時必填，不做 trim（純空白也算有內容）", () => {
    const check = (password: string) => validateEntryForm({ ...VALID, password }, { mode: "create", categories: CATEGORIES });
    expect(check("").password).toBe("請輸入密碼");
    expect(check(" ").password).toBeUndefined();
    expect(check("x").password).toBeUndefined();
  });

  test("分類必須存在於分類清單（含「未分類」）", () => {
    const check = (categoryId: string) => validateEntryForm({ ...VALID, categoryId }, { mode: "create", categories: CATEGORIES });
    expect(check("no-such-category").categoryId).toBe("請選擇有效的分類");
    expect(check("").categoryId).toBe("請選擇有效的分類");
    expect(check("00000000-0000-0000-0000-000000000000").categoryId).toBeUndefined();
  });

  test("多個欄位同時錯誤時全部回報", () => {
    const errors = validateEntryForm(
      { appName: "", accountId: "", password: "", categoryId: "x" },
      { mode: "create", categories: CATEGORIES }
    );
    expect(Object.keys(errors).sort()).toEqual(["accountId", "appName", "categoryId", "password"]);
  });
});

describe("validateEntryForm：編輯", () => {
  test("密碼留空表示不變更，不視為錯誤；其他欄位規則不變", () => {
    expect(validateEntryForm({ ...VALID, password: "" }, { mode: "edit", categories: CATEGORIES })).toEqual({});
    expect(validateEntryForm({ ...VALID, appName: "" }, { mode: "edit", categories: CATEGORIES }).appName).toBe(
      "請輸入 App 名稱"
    );
  });
});

describe("與真實 service 行為對照（防止常數漂移）", () => {
  test("appName／accountId 邊界：UI 判定合法 ⇔ createEntry 不拋錯", () => {
    const cases: Partial<EntryFormValues>[] = [
      { appName: "" },
      { appName: "a" },
      { appName: "a".repeat(100) },
      { appName: "a".repeat(101) },
      { appName: "é".repeat(60) },
      { accountId: "" },
      { accountId: "a".repeat(200) },
      { accountId: "a".repeat(201) },
      { password: "" },
      { password: " " },
      { categoryId: "no-such-category" },
    ];
    for (const override of cases) {
      const values = { ...VALID, ...override };
      const uiValid = Object.keys(validateEntryForm(values, { mode: "create", categories: CATEGORIES })).length === 0;
      expect(uiValid, JSON.stringify(override)).toBe(serviceAccepts(() => createEntry(values, CATEGORIES)));
    }
  });

  test("編輯：UI 判定合法 ⇔ updateEntry 不拋錯（密碼留空時不送 password）", () => {
    const original = { ...ENTRIES[0], password: "pw-github-7Hq2" };
    const cases: Partial<EntryFormValues>[] = [
      { appName: "" },
      { appName: "a".repeat(101) },
      { accountId: "a".repeat(201) },
      { password: "" },
      { categoryId: "no-such-category" },
    ];
    for (const override of cases) {
      const values = { ...VALID, ...override };
      const uiValid = Object.keys(validateEntryForm(values, { mode: "edit", categories: CATEGORIES })).length === 0;
      const { password, ...withoutPassword } = values;
      const changes = password === "" ? withoutPassword : values;
      expect(uiValid, JSON.stringify(override)).toBe(serviceAccepts(() => updateEntry(original, changes, CATEGORIES)));
    }
  });
});

describe("validateCategoryName", () => {
  test("合法名稱回傳 null", () => {
    expect(validateCategoryName("Personal", CATEGORIES)).toBeNull();
  });

  test("空白、純空白、長度上限 50", () => {
    expect(validateCategoryName("", CATEGORIES)).toBe("請輸入分類名稱");
    expect(validateCategoryName("   ", CATEGORIES)).toBe("分類名稱不可只有空白");
    expect(validateCategoryName("a".repeat(50), CATEGORIES)).toBeNull();
    expect(validateCategoryName("a".repeat(51), CATEGORIES)).toBe("分類名稱最多 50 個字元");
  });

  test("重名：NFC → trim → toLowerCase 後相等；含與「未分類」比較", () => {
    const duplicate = "已有相同名稱的分類（不分大小寫）";
    expect(validateCategoryName("email", CATEGORIES)).toBe(duplicate);
    expect(validateCategoryName("  EMAIL  ", CATEGORIES)).toBe(duplicate);
    expect(validateCategoryName("未分類", CATEGORIES)).toBe(duplicate);

    const withAccent: Category[] = [
      ...CATEGORIES,
      { id: "cafe", name: "Café", sortIndex: 2, isSystemDefault: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(validateCategoryName("Café", withAccent)).toBe(duplicate);
  });

  test("重新命名時可排除自己（改大小寫合法），但不可與其他分類重名", () => {
    expect(validateCategoryName("EMAIL", CATEGORIES, EMAIL_ID)).toBeNull();
    expect(validateCategoryName("work", CATEGORIES, EMAIL_ID)).toBe("已有相同名稱的分類（不分大小寫）");
  });

  test("與真實 service 行為對照：UI 判定合法 ⇔ createCategory／renameCategory 不拋錯", () => {
    const names = ["Personal", "", "   ", "email", "  EMAIL ", "未分類", "a".repeat(50), "a".repeat(51), "Café"];
    for (const name of names) {
      const uiValid = validateCategoryName(name, CATEGORIES) === null;
      expect(uiValid, JSON.stringify(name)).toBe(serviceAccepts(() => createCategory(name, CATEGORIES)));
      const renameValid = validateCategoryName(name, CATEGORIES, EMAIL_ID) === null;
      expect(renameValid, `rename ${JSON.stringify(name)}`).toBe(
        serviceAccepts(() => renameCategory(EMAIL_ID, name, CATEGORIES))
      );
    }
  });
});

describe("isWeakPassword（§3.3：長度 < 8 顯示強度警示）", () => {
  test("空字串不警示（由必填規則處理）；1–7 字警示；8 字以上不警示", () => {
    expect(isWeakPassword("")).toBe(false);
    expect(isWeakPassword("1234567")).toBe(true);
    expect(isWeakPassword("12345678")).toBe(false);
  });
});
