import type { Category } from "./Category";

/**
 * Entry（密碼條目，記憶體中的解密形態，供 UI／Service Layer 使用）
 * 對應規格 §3.3 Entry
 *
 * 儲存加密形態見 StoredEntryRecord（§3.4）。
 */
export interface Entry {
  /** 系統自動產生，全域唯一（UUID） */
  id: string;

  /** NFC 正規化後長度 1–100 */
  appName: string;

  /** 參照 Category.id，必須存在於系統分類清單中（含「未分類」） */
  categoryId: Category["id"];

  /** NFC 正規化後長度 1–200（對應「ID」欄位，如帳號/信箱） */
  accountId: string;

  /**
   * 明文，僅存於記憶體，永不落地。
   * 長度 ≥ 1；長度 < 8 時 UI 顯示強度警示，不阻擋儲存。
   */
  password: string;

  /** 系統自動產生（ISO8601 timestamp，UTC Z） */
  createdAt: string;

  /**
   * ISO8601 timestamp（UTC Z）。僅使用者四欄位（appName/categoryId/accountId/password）
   * 變更時更新；系統自動觸發的分類轉移不更新此欄位。
   */
  updatedAt: string;
}
