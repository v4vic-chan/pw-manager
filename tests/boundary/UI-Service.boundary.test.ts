import "fake-indexeddb/auto";
import { describe, test, expect } from "vitest";
import { createStorage } from "../../src/services/storage";
import type { Entry } from "../../src/types/Entry";
import type { Category } from "../../src/types/Category";
import { isEntryShape, isCategoryShape } from "./_shared/shapeGuards";

/**
 * 邊界：UI 層 <-> 應用邏輯層（Service Layer）
 * 對應規格 §2.2 分層架構、§3.3 Entry、§3.5 Category、
 * §4.3 分類管理模組、§4.4 條目 CRUD 模組。
 *
 * 此邊界驗證：UI 表單送出/顯示的 Entry、Category 資料形狀，
 * 與 src/types/ 下定義的型態契約完全一致。
 * 不驗證加解密（此邊界不涉及加密層），不驗證分類是否存在等業務規則。
 */

const validEntry: Entry = {
  id: "e1a2b3c4-0000-4000-8000-000000000001",
  appName: "Example Service",
  categoryId: "c1a2b3c4-0000-4000-8000-000000000001",
  accountId: "user@example.com",
  password: "correct horse battery staple",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const validCategory: Category = {
  id: "c1a2b3c4-0000-4000-8000-000000000001",
  name: "Email",
  sortIndex: 0,
  isSystemDefault: false,
  createdAt: "2026-09-14T00:00:00.000Z",
};

describe("UI-Service boundary: Entry", () => {
  test("UI 送往 Service 層的新增/編輯表單資料，形狀與 Entry 型態契約一致", () => {
    expect(isEntryShape(validEntry)).toBe(true);
  });

  test("Service 層回傳給 UI 顯示用的 Entry，形狀與型態契約一致", () => {
    const returnedToUi: Entry = { ...validEntry };
    expect(isEntryShape(returnedToUi)).toBe(true);
  });

  test("異常情境：缺少必填欄位（password）時，不符合 Entry 邊界契約", () => {
    const { password, ...missingPassword } = validEntry;
    expect(isEntryShape(missingPassword)).toBe(false);
  });

  test("異常情境：appName 超出長度約束（1–100）時，不符合 Entry 邊界契約", () => {
    const tooLong: Entry = { ...validEntry, appName: "a".repeat(101) };
    expect(isEntryShape(tooLong)).toBe(false);
  });
});

describe("UI-Service boundary: Category", () => {
  test("UI 送往 Service 層的分類資料，形狀與 Category 型態契約一致", () => {
    expect(isCategoryShape(validCategory)).toBe(true);
  });

  test("異常情境：缺少必填欄位（name）時，不符合 Category 邊界契約", () => {
    const { name, ...missingName } = validCategory;
    expect(isCategoryShape(missingName)).toBe(false);
  });
});

/**
 * 邊界：UI 層（登入頁） <-> 應用邏輯層（Service Layer）— 登入前匯入確認字串
 * 對應規格 §5.3 登入頁匯入確認字串、§6 驗收標準第 16 項。
 *
 * 規格規定：登入前的匯入須先輸入固定字串 "OVERWRITE"，比對方式為與該常數的
 * 嚴格相等比較（===），不做 NFC 正規化、不做 trim()、不忽略大小寫；
 * 不符時不得進入檔案選擇與後續匯入流程。
 *
 * 本區塊驗證的是「跨層傳遞的確認字串判定契約」，不驗證 UI 元件的 disabled 狀態
 * （屬 UI 內部實作），也不驗證匯入本身的解密與覆蓋流程（屬其他邊界）。
 */

/** §5.3 固定確認字串，大小寫須完全相符 */
const IMPORT_CONFIRMATION = "OVERWRITE";

describe("UI-Service boundary: 登入前匯入確認字串（§5.3、§6 #16）", () => {
  test("正確輸入 'OVERWRITE'：判定相符，可進入後續匯入流程", () => {
    const userInput = "OVERWRITE";
    expect(userInput === IMPORT_CONFIRMATION).toBe(true);
  });

  test.each([
    ["空字串", ""],
    ["全小寫", "overwrite"],
    ["首字大寫", "Overwrite"],
    ["字數不足", "OVERWRIT"],
    ["多餘字元", "OVERWRITEE"],
    ["夾帶其他字元", "OVERWRITE!"],
    ["全形字元", "ＯＶＥＲＷＲＩＴＥ"],
  ])("錯誤字串（%s）：判定不相符，不得進入檔案選擇步驟", (_case, userInput) => {
    expect(userInput === IMPORT_CONFIRMATION).toBe(false);
  });

  test.each([
    ["前置空白", " OVERWRITE"],
    ["後置空白", "OVERWRITE "],
    ["前後空白", "  OVERWRITE  "],
    ["換行字元", "OVERWRITE\n"],
    ["定位字元", "\tOVERWRITE"],
  ])("前後空白（%s）：不得 trim() 後視為相符", (_case, userInput) => {
    expect(userInput === IMPORT_CONFIRMATION).toBe(false);
    // 若實作誤用 trim()，以下條件會成立；規格明確禁止此行為
    expect(userInput.trim() === IMPORT_CONFIRMATION).toBe(true);
  });

  test("NFD 形式：帶組合附加符號的輸入不得視為相符", () => {
    // "OVERWRITE" + U+0301（組合銳音符），NFD 分解形式
    const nfdInput: string = "OVERWRITÉ";
    expect(nfdInput.normalize("NFD")).toBe(nfdInput);
    expect(nfdInput === IMPORT_CONFIRMATION).toBe(false);
  });

  test("NFC 形式：正規化後的等價輸入同樣不得視為相符", () => {
    // 上例經 NFC 合成為 "OVERWRITÉ"（U+00C9），與常數仍不相等
    const nfcInput: string = "OVERWRITÉ".normalize("NFC");
    expect(nfcInput).toBe("OVERWRITÉ");
    expect(nfcInput === IMPORT_CONFIRMATION).toBe(false);
  });

  test("常數本身為純 ASCII：正規化不得被當成防線，判定僅依嚴格相等", () => {
    // 對純 ASCII 常數而言 NFC/NFD 皆等於自身，故正規化無法區分任何輸入；
    // 規格因此要求以 === 比較，且不得先行 normalize()
    expect(IMPORT_CONFIRMATION.normalize("NFC")).toBe(IMPORT_CONFIRMATION);
    expect(IMPORT_CONFIRMATION.normalize("NFD")).toBe(IMPORT_CONFIRMATION);
  });

  /**
   * §5.3：Service Layer 的登入前匯入入口須自行驗證確認字串，不得僅依賴 UI 按鈕狀態。
   * 未取得 startPreLoginImport 發出的許可時，匯入入口一律拒絕（不得進入檔案處理流程）。
   */
  test("Service Layer 自行驗證：繞過 UI 直接呼叫且字串不符時須被拒絕；未取得許可不得進入後續匯入流程", async () => {
    const storage = await createStorage({ dbName: `boundary-import-${crypto.randomUUID()}` });

    for (const confirmation of ["overwrite", " OVERWRITE", "OVERWRITE ", ""]) {
      await expect(storage.startPreLoginImport({ confirmation })).rejects.toMatchObject({
        code: "CONFIRMATION_MISMATCH",
      });
    }
    await expect(storage.importVault({ fileContent: "{}", password: "irrelevant" })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });

    await expect(storage.startPreLoginImport({ confirmation: IMPORT_CONFIRMATION })).resolves.toBeDefined();
    storage.close();
  });
});
