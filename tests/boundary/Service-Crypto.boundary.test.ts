import { describe, test, expect, beforeAll } from "vitest";
import type { Entry } from "../../src/types/Entry";
import type { KdfParams } from "../../src/types/SecurityConfig";
import {
  generateSalt,
  deriveKeys,
  encryptPayload,
  decryptPayload,
} from "../../src/crypto/crypto";
import { isEncryptedPayloadShape } from "./_shared/shapeGuards";

/**
 * 邊界：應用邏輯層（Service Layer） <-> 加密層（Crypto Layer）
 * 對應規格 §2.2 分層架構、§2.3 資料流向硬性約束、§3.3 Entry、§5.1.2 資料加密。
 *
 * 此邊界涉及加解密（加密層），依指令規則需包含加解密往返一致性測試。
 * Crypto 層（src/crypto/crypto.ts）已實作，往返測試以真實金鑰衍生與加解密執行。
 */

const KDF_PARAMS: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
let key: CryptoKey;

beforeAll(async () => {
  key = await deriveKeys("correct horse battery", await generateSalt(), KDF_PARAMS);
});

describe("Service-Crypto boundary: 型態一致性", () => {
  test("Service 層傳入加密層的明文密碼，型態與 Entry.password 契約一致（string）", () => {
    const plaintextPassword: Entry["password"] = "correct horse battery staple";
    expect(typeof plaintextPassword).toBe("string");
  });
});

describe("Service-Crypto boundary: 加解密往返一致性（round-trip）", () => {
  test("明文輸入 -> 加密層加密 -> 加密層解密 -> 輸出與原始明文完全相同", async () => {
    const plaintext: Entry["password"] = "correct horse battery staple";
    const encrypted = await encryptPayload(plaintext, key, 1);
    expect(isEncryptedPayloadShape(encrypted)).toBe(true);
    const decrypted = await decryptPayload(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });
});
