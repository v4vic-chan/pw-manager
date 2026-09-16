/**
 * Category（分類）
 * 對應規格 §3.5 Category
 */
export interface Category {
  /** 系統自動產生，全域唯一（UUID） */
  id: string;

  /** 長度 1–50，同名分類不可重複建立 */
  name: string;

  /** 使用者自訂排序位置；「未分類」固定為 -1，其餘分類 ≥ 0 */
  sortIndex: number;

  /** 僅系統預設「未分類」為 true */
  isSystemDefault: boolean;

  /** 系統自動產生（ISO8601 timestamp） */
  createdAt: string;
}
