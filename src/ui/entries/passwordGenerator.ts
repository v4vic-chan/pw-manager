/**
 * 隨機密碼產生（純函式）。
 * 規格 §4.4 未涵蓋此功能，行為依使用者裁決：crypto.getRandomValues + rejection sampling，
 * 長度 20，字元集為大小寫字母、數字、符號；每個位置在字元集內均勻取樣，不保證各類字元一定出現。
 */

export const PASSWORD_LENGTH = 20;

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";

export const PASSWORD_CHARSET = UPPERCASE + LOWERCASE + DIGITS + SYMBOLS;

/** 以亂數填滿傳入的位元組緩衝並回傳；預設為 crypto.getRandomValues，測試可注入 */
export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const cryptoFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

export function generatePassword(random: RandomFill = cryptoFill): string {
  const size = PASSWORD_CHARSET.length;
  // rejection sampling：只接受 [0, limit) 的位元組，limit 為 size 的倍數，取模後每個字元機率完全相同
  const limit = 256 - (256 % size);

  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    const bytes = random(new Uint8Array(PASSWORD_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      password += PASSWORD_CHARSET[byte % size];
      if (password.length === PASSWORD_LENGTH) break;
    }
    bytes.fill(0);
  }
  return password;
}
