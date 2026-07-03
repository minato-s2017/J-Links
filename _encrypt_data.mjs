// データ暗号化ツール（配布前に実行）。ブラウザの Web Crypto と同一方式(PBKDF2-SHA256 + AES-GCM)。
// 使い方:  node _encrypt_data.mjs <password> [入力json] [出力enc]
//   例:    node _encrypt_data.mjs <パスワード>
// 出力 .enc を公開リポジトリに置く。平文 .json は公開しない。
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.argv[2];   // 必須。公開リポジトリにパスワードを残さないためハードコードしない
if (!PASSWORD) {
  console.error("使い方: node _encrypt_data.mjs <パスワード> [入力json] [出力enc]");
  process.exit(1);
}
const INP = process.argv[3] || join(HERE, "data", "SCSS_F8T.F10T.json");
const OUT = process.argv[4] || join(HERE, "data", "SCSS_F8T.F10T.enc");
const ITER = 200000;

const plaintext = readFileSync(INP);                 // UTF-8 JSON (Buffer)
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const baseKey = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
  baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
const b64 = (u8) => Buffer.from(u8).toString("base64");
const out = { v: 1, kdf: "PBKDF2", hash: "SHA-256", iter: ITER,
              salt: b64(salt), iv: b64(iv), ct: b64(ct) };
writeFileSync(OUT, JSON.stringify(out));
console.log("OK ->", OUT, "  平文", plaintext.length, "bytes ->  暗号", ct.length, "bytes");
