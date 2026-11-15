import {
  B64URL_RE,
  b64urlDecode,
  concludeToken,
  failToken,
  prepareToken,
  type PublicKeyEntry,
  type VerifyResult,
} from "./token-core";

/**
 * Aktarıcı tarafı doğrulama: YALNIZCA WebCrypto (`globalThis.crypto.subtle`, Ed25519 + SHA-256).
 *
 * Hem Node 22+ (VPS aktarıcısı, testler) hem Cloudflare Workers bu API'yi yerleşik sunar; `nodejs_compat` bayrağı
 * GEREKMEZ ve `node:` modülü içe aktarılmaz. Biçim ve yük kuralları `./token-core` ile ortaktır; sonuç kodları
 * uygulamanın `verifyToken` (./token, `node:crypto`) gerçeklemesiyle birebir aynıdır (karşılaştırmalı test:
 * tests/unsubscribe-worker.test.ts). Aktarıcıda yalnızca GENEL anahtarlar bulunur; imzalama burada YOKTUR.
 */

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** SHA-256 özetinin onaltılık (hex) gösterimi. */
export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", data));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Genel anahtar → kimlik (ham anahtarın SHA-256'sının ilk 8 baytı, hex); çözülemeyen anahtar için "". */
export async function kidOfPublicKeyWeb(x: string): Promise<string> {
  const raw = B64URL_RE.test(x) ? b64urlDecode(x) : null;
  if (!raw) return "";
  return (await sha256Hex(raw)).slice(0, 16);
}

/** İçe aktarılmış genel anahtarlar (genel bilgi; sınırlı önbellek). */
const keyCache = new Map<string, Promise<CryptoKey>>();
const KEY_CACHE_MAX = 64;

function ed25519PublicKey(x: string): Promise<CryptoKey> {
  const hit = keyCache.get(x);
  if (hit) return hit;
  const raw = B64URL_RE.test(x) ? b64urlDecode(x) : null;
  if (!raw || raw.length !== 32) return Promise.reject(new Error("invalid key"));
  const p = subtle().importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(x, p);
  p.catch(() => keyCache.delete(x));
  return p;
}

/** Ed25519 imza denetimi; anahtar/imza geçersizse veya hata olursa false. */
export async function ed25519Verify(
  x: string,
  message: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    return await subtle().verify(
      { name: "Ed25519" },
      await ed25519PublicKey(x),
      signature,
      message,
    );
  } catch {
    return false;
  }
}

/**
 * Belirteci WebCrypto ile doğrular (./token `verifyToken` ile aynı sıra ve sonuçlar): biçim → anahtar (kid ↔ özet
 * bağı dahil) → İMZA → yük kuralları → zaman.
 */
export async function verifyTokenWeb(
  token: unknown,
  keys: readonly PublicKeyEntry[],
  now: number,
): Promise<VerifyResult> {
  const pre = prepareToken(token, keys);
  if (!pre.ok) return pre;
  const p = pre.prepared;
  try {
    if ((await kidOfPublicKeyWeb(p.entry.x)) !== p.entry.kid) return failToken("unknown_key");
    await ed25519PublicKey(p.entry.x);
  } catch {
    return failToken("unknown_key");
  }
  if (!(await ed25519Verify(p.entry.x, p.message, p.signature))) return failToken("bad_signature");
  return concludeToken(p, now);
}
