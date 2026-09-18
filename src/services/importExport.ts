import type { Category } from "../types/Category";
import type { EncryptedPayload } from "../types/EncryptedPayload";
import type { ExportFile, ExportFileHeader } from "../types/ExportFile";
import type { RecoveryCode, SecurityConfig } from "../types/SecurityConfig";
import type { StoredEntryRecord } from "../types/StoredEntryRecord";
import { UNCATEGORIZED_CATEGORY_ID } from "./category";
import { CURRENT_CRYPTO_VERSION } from "./masterPassword";

/**
 * §3.2、§5.3 匯入／匯出的純函式：檔案格式解析、§3 資料契約驗證、確認字串判定與匯入後 SecurityConfig 組裝。
 * 不存取 IndexedDB、不做加解密；加解密、canary 比對與單一交易寫入由 storage.ts 編排。
 * 驗證一律嚴格：缺欄位、型態不符、未定義的欄位皆拒絕，避免未知欄位（例如明文備註）隨匯入落地。
 */

export const EXPORT_FORMAT_VERSION = 1;

/** §5.3 登入頁匯入確認字串 */
export const PRE_LOGIN_IMPORT_CONFIRMATION = "OVERWRITE";

export type ImportErrorCode =
  | "CONFIRMATION_MISMATCH"
  | "CONFIRMATION_REQUIRED"
  | "INVALID_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "DECRYPTION_FAILED"
  | "INVALID_CONTENT";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

/** §3.2：SecurityConfig 中除 header 欄位與兩個失敗計數以外、隨本體加密匯出的部分 */
export type ExportedSecurityConfig = Omit<
  SecurityConfig,
  "cryptoVersion" | "masterPasswordSalt" | "kdfParams" | "loginFailureState" | "totpFailureState"
>;

/** §3.2：encryptedBody 解密後的本體 */
export interface ExportBody {
  entries: StoredEntryRecord[];
  categories: Category[];
  securityConfig: ExportedSecurityConfig;
}

/** §5.3、AC16：嚴格相等比較，不做 NFC 正規化、trim() 或忽略大小寫 */
export function isImportConfirmationValid(input: string): boolean {
  return input === PRE_LOGIN_IMPORT_CONFIRMATION;
}

export function buildExportHeader(securityConfig: SecurityConfig): ExportFileHeader {
  return {
    cryptoVersion: securityConfig.cryptoVersion,
    masterPasswordSalt: securityConfig.masterPasswordSalt,
    kdfParams: { ...securityConfig.kdfParams },
  };
}

export function buildExportBody(
  entries: StoredEntryRecord[],
  categories: Category[],
  securityConfig: SecurityConfig
): ExportBody {
  const {
    cryptoVersion: _cryptoVersion,
    masterPasswordSalt: _salt,
    kdfParams: _kdfParams,
    loginFailureState: _loginFailures,
    totpFailureState: _totpFailures,
    ...exported
  } = securityConfig;
  return { entries, categories, securityConfig: exported };
}

/** §5.3 步驟 6：max(當前, 匯入) + 1；當前值不存在或不是有效的非負整數時視為 0 */
export function computeImportedKeyGeneration(current: unknown, imported: number): number {
  const base = typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  return Math.max(base, imported) + 1;
}

/** §5.3 步驟 6：組出整份覆蓋後的 SecurityConfig，兩個失敗計數重置 */
export function buildImportedSecurityConfig(
  header: ExportFileHeader,
  exported: ExportedSecurityConfig,
  currentKeyGeneration: unknown
): SecurityConfig {
  return {
    ...exported,
    masterPasswordSalt: header.masterPasswordSalt,
    kdfParams: { ...header.kdfParams },
    cryptoVersion: header.cryptoVersion,
    keyGeneration: computeImportedKeyGeneration(currentKeyGeneration, exported.keyGeneration),
    loginFailureState: { failedAttempts: 0, lockedUntil: null },
    totpFailureState: { failedAttempts: 0, lockedUntil: null },
  };
}

/** §3.2、§5.3 步驟 1：解析外層格式；版本不相容回報 UNSUPPORTED_VERSION，其餘格式問題回報 INVALID_FORMAT */
export function parseExportFile(fileContent: string): ExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fileContent);
  } catch {
    throw new ImportError("INVALID_FORMAT", "匯入檔案不是有效的 JSON");
  }

  return asImportError("INVALID_FORMAT", () => {
    const file = asObject(raw, "file");
    assertKeys(file, "file", ["formatVersion", "header", "encryptedBody"]);

    const formatVersion = asInteger(file.formatVersion, "file.formatVersion", 1);
    if (formatVersion !== EXPORT_FORMAT_VERSION) {
      throw new ImportError("UNSUPPORTED_VERSION", `不支援的匯出檔格式版本：${formatVersion}`);
    }

    const header = asObject(file.header, "header");
    assertKeys(header, "header", ["cryptoVersion", "masterPasswordSalt", "kdfParams"]);
    const cryptoVersion = asInteger(header.cryptoVersion, "header.cryptoVersion", 1);
    if (cryptoVersion > CURRENT_CRYPTO_VERSION) {
      throw new ImportError(
        "UNSUPPORTED_VERSION",
        `備份檔 cryptoVersion ${cryptoVersion} 高於目前支援的版本 ${CURRENT_CRYPTO_VERSION}，請先更新應用程式`
      );
    }
    const kdf = asObject(header.kdfParams, "header.kdfParams");
    assertKeys(kdf, "header.kdfParams", ["memoryKiB", "iterations", "parallelism"]);

    return {
      formatVersion,
      header: {
        cryptoVersion,
        masterPasswordSalt: asBase64(header.masterPasswordSalt, "header.masterPasswordSalt"),
        kdfParams: {
          memoryKiB: asInteger(kdf.memoryKiB, "header.kdfParams.memoryKiB", 1, IMPORT_KDF_MAX_MEMORY_KIB),
          iterations: asInteger(kdf.iterations, "header.kdfParams.iterations", 1, IMPORT_KDF_MAX_ITERATIONS),
          parallelism: asInteger(
            kdf.parallelism,
            "header.kdfParams.parallelism",
            IMPORT_KDF_PARALLELISM,
            IMPORT_KDF_PARALLELISM
          ),
        },
      },
      encryptedBody: parsePayload(file.encryptedBody, "encryptedBody", cryptoVersion),
    };
  });
}

/**
 * §5.3 步驟 4、5：本體須符合 §3 資料契約；「未分類」恰好一筆、每筆 Entry 的 categoryId 皆可對應。
 * 所有 EncryptedPayload.cryptoVersion 須等於檔案的 cryptoVersion（§4.1.1 一律設為同一版本）。
 */
export function parseExportBody(bodyJson: string, cryptoVersion: number): ExportBody {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson);
  } catch {
    throw new ImportError("INVALID_CONTENT", "備份本體不是有效的 JSON");
  }

  return asImportError("INVALID_CONTENT", () => {
    const body = asObject(raw, "body");
    assertKeys(body, "body", ["entries", "categories", "securityConfig"]);
    const categories = asArray(body.categories, "categories").map((value, index) =>
      parseCategory(value, `categories[${index}]`)
    );
    const entries = asArray(body.entries, "entries").map((value, index) =>
      parseEntry(value, `entries[${index}]`, cryptoVersion)
    );
    const securityConfig = parseExportedSecurityConfig(body.securityConfig, cryptoVersion);

    assertCategoryRules(categories);
    assertEntryRules(entries, categories);
    return { entries, categories, securityConfig };
  });
}

/* ---------- 內部驗證工具 ---------- */

class ContractViolation extends Error {}

function violation(message: string): never {
  throw new ContractViolation(message);
}

function asImportError<T>(code: ImportErrorCode, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractViolation) throw new ImportError(code, error.message);
    throw error;
  }
}

type JsonObject = Record<string, unknown>;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** 12 bytes 經 Base64 編碼恰為 16 個字元，無 padding */
const IV_12_BYTES_PATTERN = /^[A-Za-z0-9+/]{16}$/;
/** §3 通用約束：Date.prototype.toISOString() 輸出格式 */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECOVERY_CODE_MIN = 8;
const RECOVERY_CODE_MAX = 10;

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) violation(`${path} 須為物件`);
  return value as JsonObject;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) violation(`${path} 須為陣列`);
  return value;
}

function assertKeys(
  value: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) violation(`${path}.${key} 為必填欄位`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) violation(`${path}.${key} 為未定義的欄位`);
  }
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") violation(`${path} 須為字串`);
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  const text = asString(value, path);
  if (text.length === 0) violation(`${path} 不可為空字串`);
  return text;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") violation(`${path} 須為布林值`);
  return value;
}

/**
 * 匯入檔 kdfParams 的資源上限：備份檔為不受信任的外部輸入，須在金鑰衍生前擋下可造成記憶體耗盡或長時間凍結的數值。
 * 上限遠高於正常參數（§5.1.1 最低 19456 KiB／2 次），不影響合法備份；parallelism 依 §5.1.1 固定為 1。
 */
const IMPORT_KDF_MAX_MEMORY_KIB = 1_048_576;
const IMPORT_KDF_MAX_ITERATIONS = 10;
const IMPORT_KDF_PARALLELISM = 1;

function asInteger(value: unknown, path: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    violation(max === Number.MAX_SAFE_INTEGER ? `${path} 須為 ≥ ${min} 的整數` : `${path} 須為 ${min}–${max} 的整數`);
  }
  return value;
}

/** §3 通用約束：使用者輸入字串須已 NFC 正規化，長度以正規化後的 UTF-16 code unit 計 */
function asNormalizedText(value: unknown, path: string, min: number, max: number): string {
  const text = asString(value, path);
  if (text.normalize("NFC") !== text) violation(`${path} 須為 NFC 正規化後的值`);
  if (text.length < min || text.length > max) violation(`${path} 長度須為 ${min}–${max}`);
  return text;
}

function asBase64(value: unknown, path: string): string {
  const text = asNonEmptyString(value, path);
  if (!BASE64_PATTERN.test(text)) violation(`${path} 須為有效的 Base64 字串`);
  return text;
}

function asTimestamp(value: unknown, path: string): string {
  const text = asString(value, path);
  const time = Date.parse(text);
  if (!ISO_UTC_PATTERN.test(text) || Number.isNaN(time) || new Date(time).toISOString() !== text) {
    violation(`${path} 須為 toISOString() 產生的 UTC 時間戳`);
  }
  return text;
}

/** §3.1 EncryptedPayload */
function parsePayload(value: unknown, path: string, cryptoVersion: number): EncryptedPayload {
  const payload = asObject(value, path);
  assertKeys(payload, path, ["ciphertext", "iv", "cryptoVersion"]);
  const iv = asString(payload.iv, `${path}.iv`);
  if (!IV_12_BYTES_PATTERN.test(iv)) violation(`${path}.iv 須為 12 bytes 的 Base64`);
  const version = asInteger(payload.cryptoVersion, `${path}.cryptoVersion`, 1);
  if (version !== cryptoVersion) violation(`${path}.cryptoVersion 須與檔案版本 ${cryptoVersion} 一致`);
  return { ciphertext: asBase64(payload.ciphertext, `${path}.ciphertext`), iv, cryptoVersion: version };
}

/** §3.5 Category */
function parseCategory(value: unknown, path: string): Category {
  const category = asObject(value, path);
  assertKeys(category, path, ["id", "name", "sortIndex", "isSystemDefault", "createdAt"]);
  const sortIndex = category.sortIndex;
  if (typeof sortIndex !== "number" || !Number.isSafeInteger(sortIndex)) violation(`${path}.sortIndex 須為整數`);
  return {
    id: asNonEmptyString(category.id, `${path}.id`),
    name: asNormalizedText(category.name, `${path}.name`, 1, 50),
    sortIndex,
    isSystemDefault: asBoolean(category.isSystemDefault, `${path}.isSystemDefault`),
    createdAt: asTimestamp(category.createdAt, `${path}.createdAt`),
  };
}

/** §3.4 StoredEntryRecord（password 須為 EncryptedPayload，不得為明文） */
function parseEntry(value: unknown, path: string, cryptoVersion: number): StoredEntryRecord {
  const entry = asObject(value, path);
  assertKeys(entry, path, ["id", "appName", "categoryId", "accountId", "password", "createdAt", "updatedAt"]);
  return {
    id: asNonEmptyString(entry.id, `${path}.id`),
    appName: asNormalizedText(entry.appName, `${path}.appName`, 1, 100),
    categoryId: asNonEmptyString(entry.categoryId, `${path}.categoryId`),
    accountId: asNormalizedText(entry.accountId, `${path}.accountId`, 1, 200),
    password: parsePayload(entry.password, `${path}.password`, cryptoVersion),
    createdAt: asTimestamp(entry.createdAt, `${path}.createdAt`),
    updatedAt: asTimestamp(entry.updatedAt, `${path}.updatedAt`),
  };
}

function parseRecoveryCode(value: unknown, path: string): RecoveryCode {
  const code = asObject(value, path);
  assertKeys(code, path, ["codeHash", "salt", "used"]);
  return {
    codeHash: asBase64(code.codeHash, `${path}.codeHash`),
    salt: asBase64(code.salt, `${path}.salt`),
    used: asBoolean(code.used, `${path}.used`),
  };
}

/** §3.6：2FA 相關欄位僅於 twoFactorEnabled=true 時存在，救援碼 8–10 組 */
function parseExportedSecurityConfig(value: unknown, cryptoVersion: number): ExportedSecurityConfig {
  const path = "securityConfig";
  const config = asObject(value, path);
  assertKeys(
    config,
    path,
    ["canaryPayload", "keyGeneration", "twoFactorEnabled"],
    ["twoFactorSecretEncrypted", "recoveryCodes", "recoveryCodesRemainingWarningShown"]
  );

  const result: ExportedSecurityConfig = {
    canaryPayload: parsePayload(config.canaryPayload, `${path}.canaryPayload`, cryptoVersion),
    keyGeneration: asInteger(config.keyGeneration, `${path}.keyGeneration`, 1),
    twoFactorEnabled: asBoolean(config.twoFactorEnabled, `${path}.twoFactorEnabled`),
  };

  if (result.twoFactorEnabled) {
    if (config.twoFactorSecretEncrypted === undefined || config.recoveryCodes === undefined) {
      violation("twoFactorEnabled=true 時須同時包含 twoFactorSecretEncrypted 與 recoveryCodes");
    }
    result.twoFactorSecretEncrypted = parsePayload(
      config.twoFactorSecretEncrypted,
      `${path}.twoFactorSecretEncrypted`,
      cryptoVersion
    );
    const codes = asArray(config.recoveryCodes, `${path}.recoveryCodes`);
    if (codes.length < RECOVERY_CODE_MIN || codes.length > RECOVERY_CODE_MAX) {
      violation(`救援碼須為 ${RECOVERY_CODE_MIN}–${RECOVERY_CODE_MAX} 組，實際為 ${codes.length}`);
    }
    result.recoveryCodes = codes.map((code, index) => parseRecoveryCode(code, `${path}.recoveryCodes[${index}]`));
  } else if (config.twoFactorSecretEncrypted !== undefined || config.recoveryCodes !== undefined) {
    violation("twoFactorEnabled=false 時不得包含 twoFactorSecretEncrypted 或 recoveryCodes");
  }

  if (config.recoveryCodesRemainingWarningShown !== undefined) {
    result.recoveryCodesRemainingWarningShown = asBoolean(
      config.recoveryCodesRemainingWarningShown,
      `${path}.recoveryCodesRemainingWarningShown`
    );
  }
  return result;
}

/** §3.5：「未分類」恰好一筆且為唯一系統預設；其餘 sortIndex ≥ 0；id 與名稱皆不得重複 */
function assertCategoryRules(categories: Category[]): void {
  const ids = new Set<string>();
  const nameKeys = new Set<string>();
  let uncategorizedCount = 0;

  for (const category of categories) {
    if (ids.has(category.id)) violation(`分類 id 重複：${category.id}`);
    ids.add(category.id);

    // §3.5 重名判斷：NFC → trim → toLowerCase（不得使用 toLocaleLowerCase）
    const nameKey = category.name.normalize("NFC").trim().toLowerCase();
    if (nameKeys.has(nameKey)) violation(`分類名稱重複：${category.name}`);
    nameKeys.add(nameKey);

    if (category.id === UNCATEGORIZED_CATEGORY_ID) {
      if (!category.isSystemDefault || category.sortIndex !== -1) {
        violation("「未分類」須為 isSystemDefault=true 且 sortIndex=-1");
      }
      uncategorizedCount += 1;
    } else if (category.isSystemDefault || category.sortIndex < 0) {
      violation(`僅「未分類」可為系統預設且 sortIndex 為 -1：${category.id}`);
    }
  }

  if (uncategorizedCount !== 1) violation("須恰好存在一筆 id 為 nil UUID 的「未分類」");
}

/** §5.3 步驟 5：Entry id 不得重複，categoryId 須可對應匯入資料內的分類 */
function assertEntryRules(entries: StoredEntryRecord[], categories: Category[]): void {
  const categoryIds = new Set(categories.map((category) => category.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) violation(`條目 id 重複：${entry.id}`);
    ids.add(entry.id);
    if (!categoryIds.has(entry.categoryId)) violation(`條目 ${entry.id} 參照不存在的分類：${entry.categoryId}`);
  }
}
