import type { EncryptedPayload } from "./EncryptedPayload";
import type { Entry } from "./Entry";

/**
 * StoredEntryRecord（Entry 的儲存加密形態，Storage Layer 實際持久化的結構）
 * 對應規格 §3.4 StoredEntryRecord
 *
 * id / appName / categoryId / accountId / createdAt / updatedAt 同 Entry，皆為明文儲存；
 * 僅 password 為加密形態。
 */
export interface StoredEntryRecord extends Omit<Entry, "password"> {
  /** 見 §3.1；解密後對應 Entry.password */
  password: EncryptedPayload;
}
