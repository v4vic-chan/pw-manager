import {
  CryptoError,
  decryptPayload,
  deriveKeys,
  encryptPayload,
  rekey,
  verifyCanaryPayload,
} from "../crypto/crypto";
import {
  openVaultDB,
  readAllCategories,
  readAllEntries,
  readSecurityConfig,
  readVaultSnapshot,
  writeGuarded,
  writeUnguarded,
  type VaultDB,
  type WritePlan,
} from "../storage/db";
import type { Category } from "../types/Category";
import type { Entry } from "../types/Entry";
import type { ExportFile } from "../types/ExportFile";
import type { FailureState, KdfParams, SecurityConfig } from "../types/SecurityConfig";
import type { StoredEntryRecord } from "../types/StoredEntryRecord";
import * as categoryService from "./category";
import * as entryService from "./entry";
import {
  EXPORT_FORMAT_VERSION,
  ImportError,
  PRE_LOGIN_IMPORT_CONFIRMATION,
  buildExportBody,
  buildExportHeader,
  buildImportedSecurityConfig,
  isImportConfirmationValid,
  parseExportBody,
  parseExportFile,
  type ExportBody,
} from "./importExport";
import * as masterPassword from "./masterPassword";
import * as twoFactor from "./twoFactor";

/**
 * Service Layer 持久化編排：呼叫純函式模組取得新狀態 → 於開啟交易前完成全部加密運算 →
 * 經 src/storage/db.ts 以單一交易寫入並確認提交 → 才更新 session 或回傳結果。
 * session（encryptionKey、keyGeneration 快照）與 §4.1.1 寫入鎖定旗標僅存在於本實例記憶體。
 * 本輪範圍外：匯入／匯出（§5.3）、§4.1.3 自動升級觸發。
 */

export type StorageErrorCode = "REKEY_IN_PROGRESS" | "KEY_GENERATION_MISMATCH" | "NOT_AUTHENTICATED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export type LockedResult = { ok: false; reason: "LOCKED"; waitSeconds: number };

export type LoginResult =
  | { ok: true; requiresSecondFactor: boolean }
  | { ok: false; reason: "INVALID_MASTER_PASSWORD" }
  | LockedResult;

export type SecondFactorInput = { totpCode: string } | { recoveryCode: string };

export type SecondFactorResult =
  | { ok: true }
  | { ok: false; reason: "INVALID_TOTP_CODE" | "INVALID_RECOVERY_CODE" }
  | LockedResult;

/** 關閉 2FA、補發救援碼前的主密碼 + 第二因素重新驗證失敗 */
export type ReverificationFailure =
  | { ok: false; reason: "INVALID_MASTER_PASSWORD" | "INVALID_TOTP_CODE" | "INVALID_RECOVERY_CODE" }
  | LockedResult;

export type RecoveryCodesRegenerationResult =
  | { ok: true; batch: twoFactor.RecoveryCodesBatch }
  | ReverificationFailure;

/** 已登入狀態下重新驗證主密碼（變更主密碼前）的結果；失敗計入 loginFailureState */
export type MasterPasswordReverificationResult =
  | { ok: true }
  | { ok: false; reason: "INVALID_MASTER_PASSWORD" }
  | LockedResult;

/** 安全設定畫面所需的唯讀摘要；不含任何秘密 */
export interface SecurityStatus {
  twoFactorEnabled: boolean;
  /** §4.2：剩餘未使用救援碼數（2FA 關閉時為 0），供「≤ 2 組時提示補發」使用 */
  unusedRecoveryCodes: number;
}

export interface VaultStorage {
  isInitialized(): Promise<boolean>;
  /** §4.1 首次設定：單一交易寫入 SecurityConfig 與「未分類」；不建立 session，需再呼叫 login */
  initialize(password: string, kdfParams?: KdfParams): Promise<void>;
  login(password: string): Promise<LoginResult>;
  verifySecondFactor(input: SecondFactorInput): Promise<SecondFactorResult>;
  logout(): void;
  isUnlocked(): boolean;
  close(): void;

  loadEntries(): Promise<Entry[]>;
  loadCategories(): Promise<Category[]>;

  addEntry(input: entryService.EntryUserFields, categories: Category[]): Promise<Entry>;
  editEntry(
    original: Entry,
    changes: Partial<entryService.EntryUserFields>,
    categories?: Category[]
  ): Promise<Entry>;
  removeEntry(entries: Entry[], entryId: string, confirmed: boolean): Promise<Entry[]>;

  addCategory(name: string, existing: Category[]): Promise<Category>;
  renameCategory(categoryId: string, newName: string, existing: Category[]): Promise<Category>;
  reorderCategories(userCategories: Category[], fromIndex: number, toIndex: number): Promise<Category[]>;
  /** 回傳被轉移至「未分類」的條目 */
  removeCategory(categoryId: string, categories: Category[], entries: Entry[]): Promise<Entry[]>;

  beginTwoFactorSetup(): Promise<twoFactor.TwoFactorSetup>;
  confirmTwoFactorSetup(
    totpCode: string,
    setup: twoFactor.TwoFactorSetup
  ): Promise<twoFactor.ConfirmEnableTwoFactorResult>;
  disableTwoFactor(password: string, secondFactor: SecondFactorInput): Promise<{ ok: true } | ReverificationFailure>;
  beginRecoveryCodesRegeneration(password: string, totpCode: string): Promise<RecoveryCodesRegenerationResult>;
  commitRecoveryCodes(batch: twoFactor.RecoveryCodesBatch): Promise<void>;

  /** §4.1.2：以 §4.1.1 共用程序重新金鑰化 */
  changeMasterPassword(newPassword: string): Promise<void>;

  /** 唯讀：須已登入；只回傳 2FA 開關與未使用救援碼數 */
  getSecurityStatus(): Promise<SecurityStatus>;
  /**
   * 須已登入：重新驗證目前主密碼（變更主密碼前使用）。沿用 §4.1 的鎖定與失敗計數（loginFailureState），
   * 成功時歸零；不影響 session，也不交出任何金鑰。
   */
  reverifyMasterPassword(password: string): Promise<MasterPasswordReverificationResult>;

  /** §5.3 匯出：須已登入；回傳 §3.2 ExportFile（明文 header + 以 session 金鑰加密的本體），不含任何明文秘密 */
  exportVault(): Promise<ExportFile>;
  /** §5.3 登入頁匯入入口：確認字串須與 "OVERWRITE" 嚴格相等，通過才發出匯入許可 */
  startPreLoginImport(input: { confirmation: string }): Promise<PreLoginImportTicket>;
  /**
   * §5.3 匯入（整份覆蓋）：已登入時直接執行並受 §5.1.5 檢查；未登入時須帶 startPreLoginImport 發出的許可。
   * 全部驗證於寫入前完成，再以單一交易寫入；提交後清除 session，須以備份當時的主密碼重新登入。
   */
  importVault(input: { fileContent: string; password: string; ticket?: PreLoginImportTicket }): Promise<void>;
}

/** §5.3 登入頁匯入許可：僅由發出它的 storage 實例接受，匯入成功後失效 */
export interface PreLoginImportTicket {
  readonly kind: "pre-login-import";
}

interface Session {
  encryptionKey: CryptoKey;
  /** §5.1.5：主密碼驗證通過當下的 keyGeneration 快照 */
  keyGeneration: number;
  /** 新產生的 EncryptedPayload 使用的 cryptoVersion */
  cryptoVersion: number;
}

const NO_FAILURES: FailureState = { failedAttempts: 0, lockedUntil: null };

/** §3.5：系統初始化自動建立的預設分類名稱 */
const UNCATEGORIZED_NAME = "未分類";

/** §5.3 步驟 3：密碼錯誤與檔案損毀無法區分，提示須同時涵蓋兩者 */
const IMPORT_DECRYPTION_FAILED_MESSAGE = "匯入失敗：備份檔當時的主密碼錯誤，或檔案已損毀（兩者無法區分）";

function lockedResult(waitSeconds: number): LockedResult {
  return { ok: false, reason: "LOCKED", waitSeconds };
}

function recordFailure(field: "loginFailureState" | "totpFailureState", now: Date) {
  return (current: SecurityConfig): SecurityConfig => {
    const updated = masterPassword.recordLoginFailure(current[field] ?? NO_FAILURES, now);
    return field === "loginFailureState"
      ? { ...current, loginFailureState: updated }
      : { ...current, totpFailureState: updated };
  };
}

export interface StorageOptions {
  dbName?: string;
  /** §4.1.1 步驟 1、5：重新金鑰化期間暫停閒置計時（傳入 createIdleTimer 的實例），結束後恢復 */
  idleTimer?: { pause(): () => void };
}

export async function createStorage(options: StorageOptions = {}): Promise<VaultStorage> {
  const db: VaultDB = await openVaultDB(options.dbName);

  let session: Session | null = null;
  /** 主密碼已通過、等待第二因素（§4.2 登入流程）的暫存狀態 */
  let pendingSecondFactor: Session | null = null;
  let rekeyInProgress = false;
  const inFlightWrites = new Set<Promise<unknown>>();
  /** 由 beginTwoFactorSetup 發出的設定，對應發出當下的 keyGeneration；金鑰更換後即失效 */
  const issuedSetups = new WeakMap<twoFactor.TwoFactorSetup, number>();
  /** 僅接受經主密碼 + TOTP 驗證後產生的救援碼批次 */
  const issuedBatches = new WeakSet<twoFactor.RecoveryCodesBatch>();

  function clearSession(): void {
    session = null;
    pendingSecondFactor = null;
  }

  function requireSession(): Session {
    if (session === null) {
      throw new StorageError("NOT_AUTHENTICATED", "尚未登入或 session 已清除，須重新驗證主密碼（§5.1.4）");
    }
    return session;
  }

  async function requireConfig(): Promise<SecurityConfig> {
    const config = await readSecurityConfig(db);
    if (config === undefined) throw new Error("保險庫尚未初始化（§4.1 首次啟動須先設定主密碼）");
    return config;
  }

  /**
   * §4.1.1 寫入鎖定旗標與 session 檢查於呼叫當下同步執行；
   * 進行中的寫入會被追蹤，重新金鑰化開始前須等待其全部結束，避免以舊金鑰寫入的資料混入新金鑰世代。
   */
  function startWrite<T>(operation: (current: Session) => Promise<T>): Promise<T> {
    if (rekeyInProgress) {
      return Promise.reject(new StorageError("REKEY_IN_PROGRESS", "重新金鑰化進行中，寫入 API 暫停（§4.1.1）"));
    }
    let current: Session;
    try {
      current = requireSession();
    } catch (error) {
      return Promise.reject(error);
    }
    const running = operation(current);
    inFlightWrites.add(running);
    const settle = () => inFlightWrites.delete(running);
    running.then(settle, settle);
    return running;
  }

  /** §5.1.5：金鑰世代不符時交易已 abort 且無資料落地，清除 session 並強制重新登入 */
  async function commitGuarded(current: Session, plan: WritePlan): Promise<void> {
    const outcome = await writeGuarded(db, current.keyGeneration, plan);
    if (outcome === "generation_mismatch") {
      clearSession();
      throw new StorageError(
        "KEY_GENERATION_MISMATCH",
        "金鑰世代與 session 快照不符，寫入已中止，請重新登入（§5.1.5）"
      );
    }
  }

  async function toStoredRecord(entry: Entry, current: Session): Promise<StoredEntryRecord> {
    return {
      ...entry,
      password: await encryptPayload(entry.password, current.encryptionKey, current.cryptoVersion),
    };
  }

  /** 關閉 2FA、補發救援碼共用：主密碼與第二因素皆須通過，失敗分別計入 loginFailureState／totpFailureState */
  async function reverify(
    password: string,
    secondFactor: SecondFactorInput
  ): Promise<{ ok: true } | ReverificationFailure> {
    const config = await requireConfig();
    const now = new Date();

    const loginLockout = masterPassword.getLoginLockoutState(config.loginFailureState, now);
    if (loginLockout.locked) return lockedResult(loginLockout.waitSeconds);
    const totpLockout = masterPassword.getLoginLockoutState(config.totpFailureState ?? NO_FAILURES, now);
    if (totpLockout.locked) return lockedResult(totpLockout.waitSeconds);

    const verification = await masterPassword.verifyMasterPassword(password, config);
    if (!verification.ok) {
      await writeUnguarded(db, { updateSecurityConfig: recordFailure("loginFailureState", now) });
      return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
    }

    let secondFactorFailure: "INVALID_TOTP_CODE" | "INVALID_RECOVERY_CODE" | null;
    if ("totpCode" in secondFactor) {
      if (config.twoFactorSecretEncrypted === undefined) throw new Error("2FA 未開啟（§4.2）");
      const valid = await twoFactor.verifyTotp(
        secondFactor.totpCode,
        config.twoFactorSecretEncrypted,
        verification.encryptionKey
      );
      secondFactorFailure = valid ? null : "INVALID_TOTP_CODE";
    } else {
      const result = await twoFactor.verifyRecoveryCode(secondFactor.recoveryCode, config.recoveryCodes ?? []);
      secondFactorFailure = result.ok ? null : "INVALID_RECOVERY_CODE";
    }

    if (secondFactorFailure !== null) {
      await writeUnguarded(db, {
        updateSecurityConfig: (current) => ({
          ...recordFailure("totpFailureState", now)(current),
          loginFailureState: masterPassword.recordLoginSuccess(current.loginFailureState),
        }),
      });
      return { ok: false, reason: secondFactorFailure };
    }
    return { ok: true };
  }

  const issuedImportTickets = new WeakSet<PreLoginImportTicket>();

  /**
   * §5.3 步驟 1–5，全部於開啟交易前完成：解析與版本檢查 → 以備份當時主密碼與 header 參數衍生金鑰 →
   * 解密本體即驗證密碼 → §3 契約驗證 → canary 比對 → 逐筆確認條目與 TOTP 秘鑰可解密（明文不保留）。
   */
  async function decodeImportFile(fileContent: string, password: string): Promise<{ file: ExportFile; body: ExportBody }> {
    const file = parseExportFile(fileContent);

    let key: CryptoKey;
    try {
      key = await deriveKeys(password, file.header.masterPasswordSalt, file.header.kdfParams);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ImportError("INVALID_FORMAT", `備份檔的金鑰衍生參數無效：${error.message}`);
      }
      throw error;
    }

    let bodyJson: string;
    try {
      bodyJson = await decryptPayload(file.encryptedBody, key);
    } catch (error) {
      if (error instanceof CryptoError) throw new ImportError("DECRYPTION_FAILED", IMPORT_DECRYPTION_FAILED_MESSAGE);
      throw error;
    }

    const body = parseExportBody(bodyJson, file.header.cryptoVersion);
    if (!(await verifyCanaryPayload(body.securityConfig.canaryPayload, key))) {
      throw new ImportError("DECRYPTION_FAILED", IMPORT_DECRYPTION_FAILED_MESSAGE);
    }

    const secrets = body.entries.map((entry) => entry.password);
    if (body.securityConfig.twoFactorSecretEncrypted !== undefined) {
      secrets.push(body.securityConfig.twoFactorSecretEncrypted);
    }
    for (const payload of secrets) {
      try {
        await decryptPayload(payload, key);
      } catch (error) {
        if (error instanceof CryptoError) {
          throw new ImportError("INVALID_CONTENT", "備份檔中有無法以該主密碼解密的資料，檔案可能已損毀");
        }
        throw error;
      }
    }
    return { file, body };
  }

  /** §5.3 步驟 6：整份覆蓋於單一交易內完成（清空 → 寫入全部匯入資料 → 取代 SecurityConfig） */
  function importWritePlan(file: ExportFile, body: ExportBody): WritePlan {
    return {
      replaceSecurityConfig: (current) =>
        buildImportedSecurityConfig(file.header, body.securityConfig, current?.keyGeneration),
      clearEntries: true,
      clearCategories: true,
      putCategories: body.categories,
      putEntries: body.entries,
    };
  }

  return {
    exportVault() {
      return startWrite(async (current) => {
        const snapshot = await readVaultSnapshot(db);
        const categories = await readAllCategories(db);
        const config = snapshot.securityConfig;
        if (config === undefined) throw new Error("保險庫尚未初始化");
        // header 的 salt／kdfParams 須對應 session 金鑰，否則產生的備份無法解密
        if (config.keyGeneration !== current.keyGeneration) {
          clearSession();
          throw new StorageError(
            "KEY_GENERATION_MISMATCH",
            "金鑰世代與 session 快照不符，無法以目前金鑰匯出，請重新登入（§5.1.5）"
          );
        }

        const bodyJson = JSON.stringify(buildExportBody(snapshot.entries, categories, config));
        try {
          parseExportBody(bodyJson, config.cryptoVersion);
        } catch (error) {
          if (error instanceof ImportError) throw new Error(`匯出內容自檢未通過，請重試：${error.message}`);
          throw error;
        }

        return {
          formatVersion: EXPORT_FORMAT_VERSION,
          header: buildExportHeader(config),
          encryptedBody: await encryptPayload(bodyJson, current.encryptionKey, config.cryptoVersion),
        };
      });
    },

    async startPreLoginImport({ confirmation }) {
      if (!isImportConfirmationValid(confirmation)) {
        throw new ImportError(
          "CONFIRMATION_MISMATCH",
          `須輸入 "${PRE_LOGIN_IMPORT_CONFIRMATION}"（大小寫須完全相符）才可繼續匯入（§5.3）`
        );
      }
      const ticket: PreLoginImportTicket = Object.freeze({ kind: "pre-login-import" });
      issuedImportTickets.add(ticket);
      return ticket;
    },

    importVault({ fileContent, password, ticket }) {
      if (session !== null) {
        return startWrite(async (current) => {
          const { file, body } = await decodeImportFile(fileContent, password);
          await commitGuarded(current, importWritePlan(file, body));
          clearSession();
        });
      }

      return (async () => {
        if (rekeyInProgress) {
          throw new StorageError("REKEY_IN_PROGRESS", "重新金鑰化進行中，匯入暫停（§4.1.1）");
        }
        if (ticket === undefined || !issuedImportTickets.has(ticket)) {
          throw new ImportError("CONFIRMATION_REQUIRED", "登入頁匯入須先通過確認字串（§5.3）");
        }
        const { file, body } = await decodeImportFile(fileContent, password);
        // 登入前無 session 快照可比對，不受 §5.1.5 檢查；keyGeneration 遞增仍會使其他舊 session 的寫入失效
        await writeUnguarded(db, importWritePlan(file, body));
        issuedImportTickets.delete(ticket);
        clearSession();
      })();
    },

    async isInitialized() {
      return (await readSecurityConfig(db)) !== undefined;
    },

    async initialize(password, kdfParams) {
      const securityConfig = await masterPassword.setMasterPassword(password, kdfParams);
      const uncategorized: Category = {
        id: categoryService.UNCATEGORIZED_CATEGORY_ID,
        name: UNCATEGORIZED_NAME,
        sortIndex: -1,
        isSystemDefault: true,
        createdAt: new Date().toISOString(),
      };
      await writeUnguarded(db, { addSecurityConfig: securityConfig, putCategories: [uncategorized] });
    },

    async login(password) {
      const config = await requireConfig();
      const now = new Date();

      const lockout = masterPassword.getLoginLockoutState(config.loginFailureState, now);
      if (lockout.locked) return lockedResult(lockout.waitSeconds);

      const verification = await masterPassword.verifyMasterPassword(password, config);
      if (!verification.ok) {
        await writeUnguarded(db, { updateSecurityConfig: recordFailure("loginFailureState", now) });
        return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
      }

      await writeUnguarded(db, {
        updateSecurityConfig: (current) => ({
          ...current,
          loginFailureState: masterPassword.recordLoginSuccess(current.loginFailureState),
        }),
      });

      clearSession();
      const authenticated: Session = {
        encryptionKey: verification.encryptionKey,
        keyGeneration: config.keyGeneration,
        cryptoVersion: config.cryptoVersion,
      };
      if (config.twoFactorEnabled) {
        pendingSecondFactor = authenticated;
        return { ok: true, requiresSecondFactor: true };
      }
      session = authenticated;
      return { ok: true, requiresSecondFactor: false };
    },

    async verifySecondFactor(input) {
      const pending = pendingSecondFactor;
      if (pending === null) {
        throw new StorageError("NOT_AUTHENTICATED", "須先通過主密碼驗證（§4.2 登入流程）");
      }
      const config = await requireConfig();
      const now = new Date();

      const lockout = masterPassword.getLoginLockoutState(config.totpFailureState ?? NO_FAILURES, now);
      if (lockout.locked) return lockedResult(lockout.waitSeconds);

      if ("totpCode" in input) {
        if (config.twoFactorSecretEncrypted === undefined) throw new Error("2FA 未開啟（§4.2）");
        const valid = await twoFactor.verifyTotp(input.totpCode, config.twoFactorSecretEncrypted, pending.encryptionKey);
        if (!valid) {
          await writeUnguarded(db, { updateSecurityConfig: recordFailure("totpFailureState", now) });
          return { ok: false, reason: "INVALID_TOTP_CODE" };
        }
        await writeUnguarded(db, {
          updateSecurityConfig: (current) => ({ ...current, totpFailureState: NO_FAILURES }),
        });
      } else {
        const result = await twoFactor.verifyRecoveryCode(input.recoveryCode, config.recoveryCodes ?? []);
        if (!result.ok) {
          await writeUnguarded(db, { updateSecurityConfig: recordFailure("totpFailureState", now) });
          return { ok: false, reason: "INVALID_RECOVERY_CODE" };
        }
        // 規則 2：used=true 與失敗計數歸零於同一交易提交成功後才放行；失敗時交易回滾、該碼仍未使用
        const outcome = await writeGuarded(db, pending.keyGeneration, {
          updateSecurityConfig: (current) => ({
            ...current,
            recoveryCodes: result.recoveryCodes,
            totpFailureState: NO_FAILURES,
          }),
        });
        if (outcome === "generation_mismatch") {
          clearSession();
          throw new StorageError(
            "KEY_GENERATION_MISMATCH",
            "金鑰世代與登入時快照不符，請重新登入（§5.1.5）"
          );
        }
      }

      if (pendingSecondFactor !== pending) {
        throw new StorageError("NOT_AUTHENTICATED", "驗證期間已登出，須重新登入");
      }
      session = pending;
      pendingSecondFactor = null;
      return { ok: true };
    },

    logout() {
      clearSession();
    },

    isUnlocked() {
      return session !== null;
    },

    close() {
      clearSession();
      db.close();
    },

    async loadEntries() {
      const current = requireSession();
      const records = await readAllEntries(db);
      return Promise.all(
        records.map(async (record) => ({
          ...record,
          password: await decryptPayload(record.password, current.encryptionKey),
        }))
      );
    },

    async loadCategories() {
      requireSession();
      return readAllCategories(db);
    },

    addEntry(input, categories) {
      return startWrite(async (current) => {
        const entry = entryService.createEntry(input, categories);
        await commitGuarded(current, { putEntries: [await toStoredRecord(entry, current)] });
        return entry;
      });
    },

    editEntry(original, changes, categories) {
      return startWrite(async (current) => {
        const updated = entryService.updateEntry(original, changes, categories);
        await commitGuarded(current, { putEntries: [await toStoredRecord(updated, current)] });
        return updated;
      });
    },

    removeEntry(entries, entryId, confirmed) {
      return startWrite(async (current) => {
        const remaining = entryService.deleteEntry(entries, entryId, confirmed);
        const deleteEntryIds = entries.filter((entry) => !remaining.includes(entry)).map((entry) => entry.id);
        if (deleteEntryIds.length > 0) await commitGuarded(current, { deleteEntryIds });
        return remaining;
      });
    },

    addCategory(name, existing) {
      return startWrite(async (current) => {
        const category = categoryService.createCategory(name, existing);
        await commitGuarded(current, { putCategories: [category] });
        return category;
      });
    },

    renameCategory(categoryId, newName, existing) {
      return startWrite(async (current) => {
        const category = categoryService.renameCategory(categoryId, newName, existing);
        await commitGuarded(current, { putCategories: [category] });
        return category;
      });
    },

    reorderCategories(userCategories, fromIndex, toIndex) {
      return startWrite(async (current) => {
        const reordered = categoryService.reorderCategories(userCategories, fromIndex, toIndex);
        await commitGuarded(current, { putCategories: reordered });
        return reordered;
      });
    },

    removeCategory(categoryId, categories, entries) {
      return startWrite(async (current) => {
        if (!categoryService.canDeleteCategory(categoryId, categories)) {
          throw new RangeError(`此分類不可刪除或不存在（§4.3）：${categoryId}`);
        }
        const moved = categoryService.reassignEntriesToUncategorized(categoryId, entries);
        // 規則 4、§3.5：分類刪除與條目轉移於同一交易提交
        await commitGuarded(current, {
          deleteCategoryIds: [categoryId],
          patchEntryCategoryIds: moved.map((entry) => ({ id: entry.id, categoryId: entry.categoryId })),
        });
        return moved;
      });
    },

    beginTwoFactorSetup() {
      return startWrite(async (current) => {
        const setup = await twoFactor.generateTwoFactorSetup(current.encryptionKey, current.cryptoVersion);
        issuedSetups.set(setup, current.keyGeneration);
        return setup;
      });
    },

    confirmTwoFactorSetup(totpCode, setup) {
      return startWrite(async (current) => {
        if (issuedSetups.get(setup) !== current.keyGeneration) {
          throw new Error("2FA 設定未由本 session 產生或金鑰已更換，請重新開始開啟流程（§4.2）");
        }
        const result = await twoFactor.confirmEnableTwoFactor(totpCode, setup);
        if (!result.ok) return result;
        await commitGuarded(current, { updateSecurityConfig: (config) => ({ ...config, ...result.changes }) });
        issuedSetups.delete(setup);
        return result;
      });
    },

    disableTwoFactor(password, secondFactor) {
      return startWrite(async (current) => {
        const verification = await reverify(password, secondFactor);
        if (!verification.ok) return verification;

        await commitGuarded(current, {
          updateSecurityConfig: (config) => {
            const result = twoFactor.disableTwoFactor(config, {
              masterPasswordVerified: true,
              totpVerified: "totpCode" in secondFactor,
              usedValidRecoveryCode: "recoveryCode" in secondFactor,
            });
            if (!result.ok) throw new Error("關閉 2FA 需主密碼與第二因素雙重驗證（§4.2）");
            return { ...result.securityConfig, loginFailureState: NO_FAILURES };
          },
        });
        return { ok: true };
      });
    },

    beginRecoveryCodesRegeneration(password, totpCode) {
      return startWrite(async () => {
        const verification = await reverify(password, { totpCode });
        if (!verification.ok) return verification;

        await writeUnguarded(db, {
          updateSecurityConfig: (config) => ({
            ...config,
            loginFailureState: NO_FAILURES,
            totpFailureState: NO_FAILURES,
          }),
        });
        const batch = await twoFactor.regenerateRecoveryCodes();
        issuedBatches.add(batch);
        return { ok: true, batch };
      });
    },

    commitRecoveryCodes(batch) {
      return startWrite(async (current) => {
        if (!issuedBatches.has(batch)) {
          throw new Error("此批救援碼未經主密碼 + TOTP 驗證產生，不得提交（§4.2 救援碼補發）");
        }
        // 規則 3：新碼寫入與舊碼失效於同一交易發生；提交前舊碼維持有效
        await commitGuarded(current, {
          updateSecurityConfig: (config) => {
            if (!config.twoFactorEnabled) throw new Error("2FA 未開啟，無法補發救援碼（§4.2）");
            return {
              ...config,
              recoveryCodes: batch.recoveryCodes,
              recoveryCodesRemainingWarningShown: batch.recoveryCodesRemainingWarningShown,
            };
          },
        });
        issuedBatches.delete(batch);
      });
    },

    async getSecurityStatus() {
      requireSession();
      const config = await requireConfig();
      const unusedRecoveryCodes = config.twoFactorEnabled
        ? (config.recoveryCodes ?? []).filter((code) => !code.used).length
        : 0;
      return { twoFactorEnabled: config.twoFactorEnabled, unusedRecoveryCodes };
    },

    async reverifyMasterPassword(password) {
      requireSession();
      const config = await requireConfig();
      const now = new Date();

      const lockout = masterPassword.getLoginLockoutState(config.loginFailureState, now);
      if (lockout.locked) return lockedResult(lockout.waitSeconds);

      // 衍生出的金鑰僅用於比對 canary，驗證後即捨棄，不取代 session 金鑰
      const verification = await masterPassword.verifyMasterPassword(password, config);
      if (!verification.ok) {
        await writeUnguarded(db, { updateSecurityConfig: recordFailure("loginFailureState", now) });
        return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
      }
      await writeUnguarded(db, {
        updateSecurityConfig: (current) => ({
          ...current,
          loginFailureState: masterPassword.recordLoginSuccess(current.loginFailureState),
        }),
      });
      return { ok: true };
    },

    async changeMasterPassword(newPassword) {
      if (rekeyInProgress) {
        throw new StorageError("REKEY_IN_PROGRESS", "重新金鑰化進行中，不可再次觸發（§4.1.1）");
      }
      const current = requireSession();
      masterPassword.assertValidMasterPassword(newPassword);

      rekeyInProgress = true;
      const releaseIdleTimer = options.idleTimer?.pause();
      try {
        await Promise.allSettled([...inFlightWrites]);

        const snapshot = await readVaultSnapshot(db);
        if (snapshot.securityConfig === undefined) throw new Error("保險庫尚未初始化");
        const config = snapshot.securityConfig;

        // §4.1.1 步驟 2–3：全部加密運算於開啟交易前在記憶體完成
        const result = await rekey({
          password: newPassword,
          targetKdfParams: config.kdfParams,
          targetCryptoVersion: config.cryptoVersion,
          oldKey: current.encryptionKey,
          entries: snapshot.entries,
          twoFactorSecretEncrypted: config.twoFactorSecretEncrypted,
        });

        // §4.1.1 步驟 4、規則 1：單一交易寫入新 SecurityConfig 與全部條目，失敗則整筆回滾
        let keyGeneration = current.keyGeneration;
        await commitGuarded(current, {
          updateSecurityConfig: (latest) => {
            keyGeneration = latest.keyGeneration + 1;
            const next: SecurityConfig = {
              ...latest,
              masterPasswordSalt: result.masterPasswordSalt,
              kdfParams: result.kdfParams,
              cryptoVersion: result.cryptoVersion,
              canaryPayload: result.canaryPayload,
              keyGeneration,
            };
            if (result.twoFactorSecretEncrypted !== undefined) {
              next.twoFactorSecretEncrypted = result.twoFactorSecretEncrypted;
            }
            return next;
          },
          putEntries: result.entries,
        });

        // §4.1.1 步驟 5：交易提交成功後才改持新金鑰與新快照
        if (session === current) {
          session = { encryptionKey: result.encryptionKey, keyGeneration, cryptoVersion: result.cryptoVersion };
        }
      } finally {
        rekeyInProgress = false;
        releaseIdleTimer?.();
      }
    },
  };
}
