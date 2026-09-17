import { describe, test, expect } from "vitest";
import { createEntry, updateEntry, deleteEntry } from "../../src/services/entry";
import type { Category } from "../../src/types/Category";
import type { Entry } from "../../src/types/Entry";

/**
 * 模組：條目 CRUD 模組（規格 §4.4）
 *
 * 此模組於規格中缺乏明確驗收標準，測試依模組描述（§4.4）與資料契約（§3.3）自行推導。
 * （複製到剪貼簿自動清空屬「安全性加分項，非強制驗收」，本檔案不涵蓋。）
 *
 * TDD 紅燈說明：src/services/entry.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

const categories: Category[] = [
  { id: "c1", name: "Email", sortIndex: 0, isSystemDefault: false, createdAt: "2026-09-14T00:00:00.000Z" },
];

const validInput = {
  appName: "Example Service",
  categoryId: "c1",
  accountId: "user@example.com",
  password: "correct horse battery staple",
};

describe("createEntry：新增條目，四欄位皆必填（§4.4、§3.3）", () => {
  test("happy path：合法輸入建立 Entry，含自動產生的 id/createdAt/updatedAt", () => {
    const entry: Entry = createEntry(validInput, categories);
    expect(typeof entry.id).toBe("string");
    expect(entry.appName).toBe(validInput.appName);
    expect(entry.categoryId).toBe(validInput.categoryId);
    expect(entry.accountId).toBe(validInput.accountId);
    expect(typeof entry.createdAt).toBe("string");
    expect(typeof entry.updatedAt).toBe("string");
  });

  test("邊界：appName 長度恰為 1 與 100 皆可成功建立", () => {
    expect(() => createEntry({ ...validInput, appName: "A" }, categories)).not.toThrow();
    expect(() => createEntry({ ...validInput, appName: "A".repeat(100) }, categories)).not.toThrow();
  });

  test("邊界：appName 長度為 0 或 101 應被拒絕", () => {
    expect(() => createEntry({ ...validInput, appName: "" }, categories)).toThrow();
    expect(() => createEntry({ ...validInput, appName: "A".repeat(101) }, categories)).toThrow();
  });

  test("邊界：accountId 長度恰為 1 與 200 皆可成功建立", () => {
    expect(() => createEntry({ ...validInput, accountId: "A" }, categories)).not.toThrow();
    expect(() => createEntry({ ...validInput, accountId: "A".repeat(200) }, categories)).not.toThrow();
  });

  test("邊界：accountId 長度為 0 或 201 應被拒絕", () => {
    expect(() => createEntry({ ...validInput, accountId: "" }, categories)).toThrow();
    expect(() => createEntry({ ...validInput, accountId: "A".repeat(201) }, categories)).toThrow();
  });

  test("異常路徑：categoryId 必須存在於使用者已建立的分類清單中", () => {
    expect(() => createEntry({ ...validInput, categoryId: "non-existent" }, categories)).toThrow();
  });

  test("異常路徑：password 為必填欄位，空字串應被拒絕", () => {
    expect(() => createEntry({ ...validInput, password: "" }, categories)).toThrow();
  });
});

describe("updateEntry：編輯條目，允許修改任一欄位並更新 updatedAt（§4.4）", () => {
  test("狀態轉換：編輯後 updatedAt 必須改變，其餘未變更欄位維持原值", async () => {
    const original = createEntry(validInput, categories);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = updateEntry(original, { appName: "Renamed Service" });

    expect(updated.appName).toBe("Renamed Service");
    expect(updated.accountId).toBe(original.accountId);
    expect(updated.id).toBe(original.id);
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  test("邊界：changes 內欄位值與原值完全相同時，非真實變更，updatedAt 不應改變", async () => {
    const original = createEntry(validInput, categories);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = updateEntry(original, {
      appName: original.appName,
      categoryId: original.categoryId,
      accountId: original.accountId,
      password: original.password,
    });

    expect(updated).toEqual(original);
    expect(updated.updatedAt).toBe(original.updatedAt);
  });
});

describe("deleteEntry：刪除需二次確認，為硬刪除（§4.4）", () => {
  test("異常路徑：未確認（confirmed=false）時不得刪除", () => {
    const entry = createEntry(validInput, categories);
    const result = deleteEntry([entry], entry.id, false);
    expect(result.some((e: Entry) => e.id === entry.id)).toBe(true);
  });

  test("happy path：已確認（confirmed=true）時應硬刪除該條目", () => {
    const entry = createEntry(validInput, categories);
    const result = deleteEntry([entry], entry.id, true);
    expect(result.some((e: Entry) => e.id === entry.id)).toBe(false);
  });
});
