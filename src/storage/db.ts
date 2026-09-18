import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import type { Category } from "../types/Category";
import type { SecurityConfig } from "../types/SecurityConfig";
import type { StoredEntryRecord } from "../types/StoredEntryRecord";

/**
 * Storage Layer（§2.2）：唯一直接存取 IndexedDB 的模組（透過 idb 封裝）。
 * 不 import 任何 Service Layer 模組、不做加解密；只落地已由上層備妥的資料（Entry 密碼一律為 EncryptedPayload）。
 */

export const DEFAULT_DB_NAME = "password-keeper";

/** 升級策略：onupgradeneeded 依 oldVersion 逐版遞進；v1 僅建立 store，無資料遷移 */
export const DB_VERSION = 1;

/** SecurityConfig 為單例（§3.6），以固定 key 存放 */
export const SECURITY_CONFIG_KEY = "singleton";

export interface VaultDBSchema extends DBSchema {
  entries: { key: string; value: StoredEntryRecord };
  categories: { key: string; value: Category };
  securityConfig: { key: string; value: SecurityConfig };
}

export type VaultDB = IDBPDatabase<VaultDBSchema>;
type VaultStoreName = StoreNames<VaultDBSchema>;
type WriteTransaction = IDBPTransaction<VaultDBSchema, VaultStoreName[], "readwrite">;

/**
 * 單一 readwrite 交易的寫入內容。所有值須於開啟交易前備妥；
 * updateSecurityConfig 為同步純函式，以交易內讀到的現行 SecurityConfig 計算新值（交易內不得 await 非 IndexedDB 操作，§5.1.5）。
 */
export interface WritePlan {
  /** 僅首次設定使用：以 add 寫入，已存在時交易失敗 */
  addSecurityConfig?: SecurityConfig;
  updateSecurityConfig?: (current: SecurityConfig) => SecurityConfig;
  deleteEntryIds?: readonly string[];
  deleteCategoryIds?: readonly string[];
  putCategories?: readonly Category[];
  putEntries?: readonly StoredEntryRecord[];
  /** 僅更新既有條目的 categoryId，其餘欄位（含密文、updatedAt）原樣保留（§3.5 分類刪除轉移） */
  patchEntryCategoryIds?: readonly { id: string; categoryId: string }[];
}

export type GuardedWriteOutcome = "committed" | "generation_mismatch";

export function openVaultDB(name: string = DEFAULT_DB_NAME): Promise<VaultDB> {
  return openDB<VaultDBSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("entries", { keyPath: "id" });
        db.createObjectStore("categories", { keyPath: "id" });
        db.createObjectStore("securityConfig");
      }
    },
  });
}

export function readSecurityConfig(db: VaultDB): Promise<SecurityConfig | undefined> {
  return db.get("securityConfig", SECURITY_CONFIG_KEY);
}

export function readAllEntries(db: VaultDB): Promise<StoredEntryRecord[]> {
  return db.getAll("entries");
}

export function readAllCategories(db: VaultDB): Promise<Category[]> {
  return db.getAll("categories");
}

/** 於同一 readonly 交易讀取 SecurityConfig 與全部條目，供重新金鑰化取得一致快照（§4.1.1 步驟 3） */
export async function readVaultSnapshot(
  db: VaultDB
): Promise<{ securityConfig: SecurityConfig | undefined; entries: StoredEntryRecord[] }> {
  const tx = db.transaction(["securityConfig", "entries"], "readonly");
  const [securityConfig, entries] = await Promise.all([
    tx.objectStore("securityConfig").get(SECURITY_CONFIG_KEY),
    tx.objectStore("entries").getAll(),
    tx.done,
  ]);
  return { securityConfig, entries };
}

/**
 * §5.1.5：交易範圍一律包含 securityConfig，於交易開頭比對 keyGeneration；
 * 不符時 abort、不落地任何資料並回傳 "generation_mismatch"。
 */
export function writeGuarded(
  db: VaultDB,
  expectedKeyGeneration: number,
  plan: WritePlan
): Promise<GuardedWriteOutcome> {
  return runWrite(db, plan, expectedKeyGeneration);
}

/** 不做金鑰世代檢查的寫入：僅供首次設定與 loginFailureState／totpFailureState 計數更新（§5.1.5 豁免） */
export async function writeUnguarded(db: VaultDB, plan: WritePlan): Promise<void> {
  await runWrite(db, plan, undefined);
}

function storesFor(plan: WritePlan, guarded: boolean): VaultStoreName[] {
  const stores = new Set<VaultStoreName>();
  if (guarded || plan.addSecurityConfig || plan.updateSecurityConfig) stores.add("securityConfig");
  if (plan.deleteEntryIds?.length || plan.putEntries?.length || plan.patchEntryCategoryIds?.length) {
    stores.add("entries");
  }
  if (plan.deleteCategoryIds?.length || plan.putCategories?.length) stores.add("categories");
  return [...stores];
}

async function runWrite(
  db: VaultDB,
  plan: WritePlan,
  expectedKeyGeneration: number | undefined
): Promise<GuardedWriteOutcome> {
  const stores = storesFor(plan, expectedKeyGeneration !== undefined);
  if (stores.length === 0) return "committed";

  const tx = db.transaction(stores, "readwrite");
  // 先掛上處理器，避免交易 abort 時 tx.done 在尚未 await 前成為未處理的 rejection
  const done = tx.done;
  done.catch(() => undefined);

  try {
    const current = stores.includes("securityConfig")
      ? await tx.objectStore("securityConfig").get(SECURITY_CONFIG_KEY)
      : undefined;

    if (expectedKeyGeneration !== undefined && current?.keyGeneration !== expectedKeyGeneration) {
      abortQuietly(tx);
      await done.catch(() => undefined);
      return "generation_mismatch";
    }

    await applyPlan(tx, plan, current);
  } catch (error) {
    abortQuietly(tx);
    await done.catch(() => undefined);
    throw error;
  }

  await done;
  return "committed";
}

async function applyPlan(tx: WriteTransaction, plan: WritePlan, current: SecurityConfig | undefined): Promise<void> {
  if (plan.addSecurityConfig) {
    await tx.objectStore("securityConfig").add(plan.addSecurityConfig, SECURITY_CONFIG_KEY);
  }
  if (plan.updateSecurityConfig) {
    if (current === undefined) throw new Error("SecurityConfig 不存在，無法更新（保險庫尚未初始化）");
    await tx.objectStore("securityConfig").put(plan.updateSecurityConfig(current), SECURITY_CONFIG_KEY);
  }
  for (const id of plan.deleteEntryIds ?? []) await tx.objectStore("entries").delete(id);
  for (const id of plan.deleteCategoryIds ?? []) await tx.objectStore("categories").delete(id);
  for (const category of plan.putCategories ?? []) await tx.objectStore("categories").put(category);
  for (const record of plan.putEntries ?? []) await tx.objectStore("entries").put(record);
  for (const { id, categoryId } of plan.patchEntryCategoryIds ?? []) {
    const record = await tx.objectStore("entries").get(id);
    if (record === undefined) throw new Error(`找不到待轉移分類的條目：${id}`);
    await tx.objectStore("entries").put({ ...record, categoryId });
  }
}

/** 交易已因請求失敗自動 abort 或已結束時，再次 abort 會拋 InvalidStateError，可忽略 */
function abortQuietly(tx: WriteTransaction): void {
  try {
    tx.abort();
  } catch {
    // 交易已不在可 abort 狀態，結果仍為未提交
  }
}
