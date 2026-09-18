import { describe, test, expect } from "vitest";
import {
  EXPORT_FORMAT_VERSION,
  PRE_LOGIN_IMPORT_CONFIRMATION,
  ImportError,
  buildExportBody,
  buildExportHeader,
  buildImportedSecurityConfig,
  computeImportedKeyGeneration,
  isImportConfirmationValid,
  parseExportBody,
  parseExportFile,
  type ExportBody,
} from "../../src/services/importExport";
import { UNCATEGORIZED_CATEGORY_ID } from "../../src/services/category";
import { CURRENT_CRYPTO_VERSION } from "../../src/services/masterPassword";
import type { Category } from "../../src/types/Category";
import type { EncryptedPayload } from "../../src/types/EncryptedPayload";
import type { ExportFile } from "../../src/types/ExportFile";
import type { KdfParams, RecoveryCode, SecurityConfig } from "../../src/types/SecurityConfig";
import type { StoredEntryRecord } from "../../src/types/StoredEntryRecord";

/**
 * 模組：匯入／匯出純函式（規格 §3.2 ExportFile、§5.3 資料匯出/匯入；AC10、AC16）
 * 格式解析、§3 資料契約驗證、確認字串判定、keyGeneration 計算；加解密與交易由 storage.ts 編排。
 */

const TS = "2026-09-14T00:00:00.000Z";

const payload = (cryptoVersion = 1): EncryptedPayload => ({
  ciphertext: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJ",
  iv: "AAECAwQFBgcICQoL",
  cryptoVersion,
});

const recoveryCodes = (count: number): RecoveryCode[] =>
  Array.from({ length: count }, () => ({
    codeHash: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k=",
    salt: "AAECAwQFBgcICQoLDA0ODw==",
    used: false,
  }));

const uncategorized: Category = {
  id: UNCATEGORIZED_CATEGORY_ID,
  name: "未分類",
  sortIndex: -1,
  isSystemDefault: true,
  createdAt: TS,
};
const work: Category = { id: "c1", name: "Work", sortIndex: 0, isSystemDefault: false, createdAt: TS };
const entry: StoredEntryRecord = {
  id: "e1",
  appName: "Example",
  categoryId: "c1",
  accountId: "user@example.com",
  password: payload(),
  createdAt: TS,
  updatedAt: TS,
};

const validBody = (): ExportBody => ({
  entries: [structuredClone(entry)],
  categories: [structuredClone(uncategorized), structuredClone(work)],
  securityConfig: { canaryPayload: payload(), keyGeneration: 3, twoFactorEnabled: false },
});

const twoFactorBody = (): ExportBody => ({
  ...validBody(),
  securityConfig: {
    canaryPayload: payload(),
    keyGeneration: 3,
    twoFactorEnabled: true,
    twoFactorSecretEncrypted: payload(),
    recoveryCodes: recoveryCodes(10),
    recoveryCodesRemainingWarningShown: false,
  },
});

const validFile = (): ExportFile => ({
  formatVersion: EXPORT_FORMAT_VERSION,
  header: {
    cryptoVersion: 1,
    masterPasswordSalt: "AAAAAAAAAAAAAAAAAAAAAA==",
    kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  },
  encryptedBody: payload(),
});

/** 回傳拋出的 ImportError.code；未拋錯回傳 undefined，拋出其他錯誤時回傳描述字串 */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ImportError ? error.code : `non-ImportError: ${String(error)}`;
  }
  return undefined;
}

const bodyCode = (body: unknown, cryptoVersion = 1) =>
  codeOf(() => parseExportBody(JSON.stringify(body), cryptoVersion));

const fileCode = (file: unknown) => codeOf(() => parseExportFile(JSON.stringify(file)));

describe("登入頁匯入確認字串（§5.3、AC16）", () => {
  test("僅與 \"OVERWRITE\" 嚴格相等才通過，不做 trim、大小寫或正規化處理", () => {
    expect(PRE_LOGIN_IMPORT_CONFIRMATION).toBe("OVERWRITE");
    expect(isImportConfirmationValid("OVERWRITE")).toBe(true);
    for (const input of ["", "overwrite", "Overwrite", " OVERWRITE", "OVERWRITE ", "OVERWRITE\n", "ＯＶＥＲＷＲＩＴＥ", "OVERWRITÉ"]) {
      expect(isImportConfirmationValid(input)).toBe(false);
    }
  });
});

describe("parseExportFile：外層格式與版本（§3.2、§5.3 步驟 1）", () => {
  test("happy path：合法檔案解析後與原內容一致", () => {
    expect(parseExportFile(JSON.stringify(validFile()))).toEqual(validFile());
  });

  test("非 JSON 或非物件：INVALID_FORMAT", () => {
    expect(codeOf(() => parseExportFile("not json"))).toBe("INVALID_FORMAT");
    expect(codeOf(() => parseExportFile("[]"))).toBe("INVALID_FORMAT");
    expect(codeOf(() => parseExportFile("null"))).toBe("INVALID_FORMAT");
  });

  test("formatVersion 不認得：UNSUPPORTED_VERSION", () => {
    expect(fileCode({ ...validFile(), formatVersion: EXPORT_FORMAT_VERSION + 1 })).toBe("UNSUPPORTED_VERSION");
  });

  test("header.cryptoVersion 高於程式支援版本：UNSUPPORTED_VERSION；低於或等於時允許", () => {
    const file = validFile();
    file.header.cryptoVersion = CURRENT_CRYPTO_VERSION + 1;
    expect(fileCode(file)).toBe("UNSUPPORTED_VERSION");
    expect(fileCode(validFile())).toBeUndefined();
  });

  test("欄位缺失、型態不符、多餘欄位：INVALID_FORMAT", () => {
    const { header: _header, ...missingHeader } = validFile();
    expect(fileCode(missingHeader)).toBe("INVALID_FORMAT");

    const badKdf = validFile() as unknown as { header: { kdfParams: Record<string, unknown> } };
    badKdf.header.kdfParams.iterations = "2";
    expect(fileCode(badKdf)).toBe("INVALID_FORMAT");

    expect(fileCode({ ...validFile(), extra: true })).toBe("INVALID_FORMAT");
    expect(fileCode({ ...validFile(), encryptedBody: { ...payload(), iv: "AAECAwQFBgc=" } })).toBe("INVALID_FORMAT");
    expect(fileCode({ ...validFile(), encryptedBody: "plaintext" })).toBe("INVALID_FORMAT");
  });

  // 防資源耗盡：不受信任的備份檔不得在金鑰衍生前取得超大 Argon2id 參數
  test("kdfParams 超過上限（memoryKiB > 1048576、iterations > 10）或 parallelism ≠ 1：格式驗證階段即以 INVALID_FORMAT 拒絕", () => {
    const withKdf = (kdf: Partial<KdfParams>) => {
      const file = validFile();
      file.header.kdfParams = { ...file.header.kdfParams, ...kdf };
      return file;
    };

    expect(fileCode(withKdf({ memoryKiB: 1_048_577 }))).toBe("INVALID_FORMAT");
    expect(fileCode(withKdf({ memoryKiB: Number.MAX_SAFE_INTEGER }))).toBe("INVALID_FORMAT");
    expect(fileCode(withKdf({ iterations: 11 }))).toBe("INVALID_FORMAT");
    expect(fileCode(withKdf({ iterations: 1_000_000 }))).toBe("INVALID_FORMAT");
    expect(fileCode(withKdf({ parallelism: 2 }))).toBe("INVALID_FORMAT");
    expect(fileCode(withKdf({ parallelism: 9 }))).toBe("INVALID_FORMAT");
  });

  test("邊界：kdfParams 恰為上限（memoryKiB = 1048576、iterations = 10、parallelism = 1）時允許", () => {
    const file = validFile();
    file.header.kdfParams = { memoryKiB: 1_048_576, iterations: 10, parallelism: 1 };
    expect(fileCode(file)).toBeUndefined();
  });
});

describe("parseExportBody：本體須符合 §3 資料契約（§5.3 步驟 4、5）", () => {
  test("happy path：合法本體（含 2FA 開啟狀態）解析後與原內容一致", () => {
    expect(parseExportBody(JSON.stringify(validBody()), 1)).toEqual(validBody());
    expect(parseExportBody(JSON.stringify(twoFactorBody()), 1)).toEqual(twoFactorBody());
  });

  test("非 JSON：INVALID_CONTENT", () => {
    expect(codeOf(() => parseExportBody("{", 1))).toBe("INVALID_CONTENT");
  });

  test("「未分類」須恰好一筆（nil UUID 且 isSystemDefault=true），不得有其他系統預設分類", () => {
    const missing = validBody();
    missing.categories = [structuredClone(work)];
    missing.entries = [];
    expect(bodyCode(missing)).toBe("INVALID_CONTENT");

    const duplicated = validBody();
    duplicated.categories.push(structuredClone(uncategorized));
    expect(bodyCode(duplicated)).toBe("INVALID_CONTENT");

    const extraDefault = validBody();
    extraDefault.categories[1] = { ...work, isSystemDefault: true };
    expect(bodyCode(extraDefault)).toBe("INVALID_CONTENT");

    const wrongSortIndex = validBody();
    wrongSortIndex.categories[0] = { ...uncategorized, sortIndex: 0 };
    expect(bodyCode(wrongSortIndex)).toBe("INVALID_CONTENT");
  });

  test("每筆 Entry 的 categoryId 須對應匯入資料內的分類；id 不得重複", () => {
    const orphan = validBody();
    orphan.entries[0].categoryId = "deleted-category";
    expect(bodyCode(orphan)).toBe("INVALID_CONTENT");

    const duplicateEntry = validBody();
    duplicateEntry.entries.push(structuredClone(entry));
    expect(bodyCode(duplicateEntry)).toBe("INVALID_CONTENT");

    const duplicateCategory = validBody();
    duplicateCategory.categories.push({ ...work, name: "Other" });
    expect(bodyCode(duplicateCategory)).toBe("INVALID_CONTENT");
  });

  test("Entry 欄位約束：長度、NFC 正規化、password 須為 EncryptedPayload、不得有多餘欄位", () => {
    const tooLong = validBody();
    tooLong.entries[0].appName = "A".repeat(101);
    expect(bodyCode(tooLong)).toBe("INVALID_CONTENT");

    const notNfc = validBody();
    notNfc.entries[0].accountId = "Café";
    expect(bodyCode(notNfc)).toBe("INVALID_CONTENT");

    const plaintext = validBody() as unknown as { entries: Record<string, unknown>[] };
    plaintext.entries[0].password = "correct horse battery staple";
    expect(bodyCode(plaintext)).toBe("INVALID_CONTENT");

    const extraField = validBody() as unknown as { entries: Record<string, unknown>[] };
    extraField.entries[0].notes = "plaintext note";
    expect(bodyCode(extraField)).toBe("INVALID_CONTENT");
  });

  test("Category 欄位約束：名稱長度 1–50", () => {
    const tooLong = validBody();
    tooLong.categories[1].name = "N".repeat(51);
    expect(bodyCode(tooLong)).toBe("INVALID_CONTENT");
  });

  test("時間戳須為 toISOString() 產生的 UTC Z 毫秒格式", () => {
    for (const bad of ["2026-09-14T00:00:00Z", "2026-09-14T08:00:00.000+08:00", "2026-13-40T00:00:00.000Z", "yesterday"]) {
      const body = validBody();
      body.entries[0].updatedAt = bad;
      expect(bodyCode(body)).toBe("INVALID_CONTENT");
    }
  });

  test("EncryptedPayload.cryptoVersion 須與檔案 header.cryptoVersion 一致", () => {
    expect(bodyCode(validBody(), 2)).toBe("INVALID_CONTENT");
  });

  test("SecurityConfig：2FA 欄位須與 twoFactorEnabled 一致、救援碼 8–10 組、不得含失敗計數等排除欄位", () => {
    const enabledWithoutSecret = twoFactorBody();
    delete enabledWithoutSecret.securityConfig.twoFactorSecretEncrypted;
    expect(bodyCode(enabledWithoutSecret)).toBe("INVALID_CONTENT");

    const tooFewCodes = twoFactorBody();
    tooFewCodes.securityConfig.recoveryCodes = recoveryCodes(7);
    expect(bodyCode(tooFewCodes)).toBe("INVALID_CONTENT");

    const disabledWithCodes = validBody();
    disabledWithCodes.securityConfig.recoveryCodes = recoveryCodes(10);
    expect(bodyCode(disabledWithCodes)).toBe("INVALID_CONTENT");

    const withFailureState = validBody() as unknown as { securityConfig: Record<string, unknown> };
    withFailureState.securityConfig.loginFailureState = { failedAttempts: 0, lockedUntil: null };
    expect(bodyCode(withFailureState)).toBe("INVALID_CONTENT");

    const badGeneration = validBody();
    badGeneration.securityConfig.keyGeneration = 0;
    expect(bodyCode(badGeneration)).toBe("INVALID_CONTENT");
  });
});

describe("匯出本體組裝（§3.2）", () => {
  const securityConfig: SecurityConfig = {
    masterPasswordSalt: "AAAAAAAAAAAAAAAAAAAAAA==",
    canaryPayload: payload(),
    keyGeneration: 3,
    cryptoVersion: 1,
    kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
    twoFactorEnabled: true,
    twoFactorSecretEncrypted: payload(),
    recoveryCodes: recoveryCodes(10),
    recoveryCodesRemainingWarningShown: false,
    loginFailureState: { failedAttempts: 2, lockedUntil: null },
    totpFailureState: { failedAttempts: 1, lockedUntil: null },
  };

  test("header 只含 cryptoVersion、masterPasswordSalt、kdfParams", () => {
    expect(buildExportHeader(securityConfig)).toEqual({
      cryptoVersion: 1,
      masterPasswordSalt: securityConfig.masterPasswordSalt,
      kdfParams: securityConfig.kdfParams,
    });
  });

  test("body 排除 header 欄位與 loginFailureState／totpFailureState，保留 2FA 欄位，且可通過本體驗證", () => {
    const body = buildExportBody([entry], [uncategorized, work], securityConfig);
    expect(body.securityConfig).toEqual({
      canaryPayload: securityConfig.canaryPayload,
      keyGeneration: 3,
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: securityConfig.twoFactorSecretEncrypted,
      recoveryCodes: securityConfig.recoveryCodes,
      recoveryCodesRemainingWarningShown: false,
    });
    expect(parseExportBody(JSON.stringify(body), 1)).toEqual(body);
  });
});

describe("匯入後的 SecurityConfig（§5.3 步驟 6）", () => {
  test("keyGeneration = max(當前, 匯入) + 1；當前值不可讀取時視為 0", () => {
    expect(computeImportedKeyGeneration(3, 5)).toBe(6);
    expect(computeImportedKeyGeneration(7, 2)).toBe(8);
    expect(computeImportedKeyGeneration(undefined, 4)).toBe(5);
    expect(computeImportedKeyGeneration(Number.NaN, 4)).toBe(5);
    expect(computeImportedKeyGeneration("corrupted", 4)).toBe(5);
  });

  test("header 參數寫回、2FA 欄位保留、兩個失敗計數重置為 { 0, null }", () => {
    const file = validFile();
    const body = twoFactorBody();
    const config = buildImportedSecurityConfig(file.header, body.securityConfig, 9);

    expect(config).toEqual({
      masterPasswordSalt: file.header.masterPasswordSalt,
      kdfParams: file.header.kdfParams,
      cryptoVersion: file.header.cryptoVersion,
      canaryPayload: body.securityConfig.canaryPayload,
      keyGeneration: 10,
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: body.securityConfig.twoFactorSecretEncrypted,
      recoveryCodes: body.securityConfig.recoveryCodes,
      recoveryCodesRemainingWarningShown: false,
      loginFailureState: { failedAttempts: 0, lockedUntil: null },
      totpFailureState: { failedAttempts: 0, lockedUntil: null },
    });
  });
});
