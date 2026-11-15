/**
 * İmzalı abonelikten çıkış belirtecinin ÇALIŞMA ORTAMINDAN BAĞIMSIZ çekirdeği (Aşama 15.6; Cloudflare Worker
 * aktarıcısı için ayrıldı).
 *
 * Bu modül hiçbir `node:` modülü, `Buffer` veya ağ/dosya erişimi KULLANMAZ: yalnızca dilin kendisi ve
 * `TextEncoder`/`TextDecoder`. Böylece hem Node (uygulama, VPS aktarıcısı) hem Cloudflare Worker aynı biçim/yük
 * kurallarını paylaşır. İmza denetimi BURADA YAPILMAZ; doğrulama iki adımdır:
 *
 *   1. `prepareToken`: biçim → anahtar seçimi (yükteki `k`), imzalanan baytlar ve imza baytları.
 *   2. Çağıran imzayı kendi kripto katmanıyla denetler (Node: `node:crypto`, ./token; Worker/Web: WebCrypto,
 *      ./web-crypto) — anahtar kimliği ↔ özet bağı da bu adımdadır.
 *   3. `concludeToken`: imza GEÇERLİYSE yük kuralları → zaman.
 *
 * Sıra ve sonuç kodları ./token içindeki `verifyToken` ile birebir aynıdır (bkz. tests/unsubscribe-worker.test.ts,
 * iki gerçeklemenin karşılaştırmalı testi).
 */

export const TOKEN_PREFIX = "u2";
export const SIGN_DOMAIN = "um-unsub-v2.";
/** Varsayılan geçerlilik: 180 gün (en uzun dizi + dinlenme süresiyle uyumlu). */
export const DEFAULT_TTL_MS = 180 * 86_400_000;
/** Mutlak üst sınır: bundan uzun geçerlilikli belirteç reddedilir. */
export const MAX_TTL_MS = 400 * 86_400_000;
/**
 * İzin verilen saat sapması (belirteç "verilme zamanı" ileride görünürse). Geniş tutulur (1 saat): aktarıcı saati
 * uygulamadan geride olsa bile GEÇERLİ bir çıkış isteği reddedilmesin (alıcı çıkamaz hâle gelmesin). Güvenlik etkisi
 * yoktur: gelecek tarihli belirteci yalnızca anahtar sahibi üretebilir.
 */
export const CLOCK_SKEW_MS = 60 * 60_000;
export const MAX_TOKEN_LENGTH = 700;
const MAX_PAYLOAD_B64 = 480;

export interface UnsubscribeClaims {
  v: 2;
  k: string;
  c: number;
  m: number | null;
  r: string;
  i: number;
  e: number;
  j: string;
  s: TokenScope;
}

export type TokenScope = "u" | "p";

export interface PublicKeyEntry {
  kid: string;
  /** Ham 32 baytlık Ed25519 genel anahtarı, base64url. */
  x: string;
}

export type VerifyFailure =
  "malformed" | "unknown_key" | "bad_signature" | "bad_claims" | "expired" | "not_yet_valid";

export type VerifyResult =
  { ok: true; claims: UnsubscribeClaims } | { ok: false; reason: VerifyFailure };

export const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[0-9a-f]{16}$/;
const TAG_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_ID = 2_147_483_647;

/* ---------------------------------------------------------------------------------------------- */
/* base64url (dolgusuz, RFC 4648 §5) — `Buffer` olmadan                                            */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Dolgusuz base64url çözümü. Alfabe dışı karakter veya imkânsız uzunluk (4k+1) → null. Son karakterin kullanılmayan
 * bitleri yok sayılır (Node `Buffer.from(s, "base64url")` ile aynı baytlar); kanoniklik gerekiyorsa çağıran
 * `b64urlEncode(çözülen) === s` ile denetler.
 */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c]! : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, o);
}

/** Dolgusuz base64url kodlama. */
export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
    s += ALPHABET[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    s += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    s += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return s;
}

const utf8 = new TextEncoder();
/** BOM korunur (Node `Buffer#toString("utf8")` gibi); geçersiz bayt U+FFFD olur ve kanoniklik denetiminde yakalanır. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export const utf8Encode = (s: string): Uint8Array<ArrayBuffer> => utf8.encode(s);

/* ---------------------------------------------------------------------------------------------- */
/* Yük                                                                                             */

/** Kanonik yük metni: alan sırası sabit. */
export function canonicalPayload(c: UnsubscribeClaims): string {
  return JSON.stringify({ v: c.v, k: c.k, c: c.c, m: c.m, r: c.r, i: c.i, e: c.e, j: c.j, s: c.s });
}

/** Yük alanlarının kesin doğrulaması; geçerliyse yeni (kopya) nesne döndürür. */
export function parseClaims(o: unknown): UnsubscribeClaims | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const x = o as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== 9) return null;
  const isId = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= MAX_ID;
  const isSec = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n < 4_102_444_800;
  if (x.v !== 2 || (x.s !== "u" && x.s !== "p")) return null;
  if (typeof x.k !== "string" || !KID_RE.test(x.k)) return null;
  if (!isId(x.c)) return null;
  if (x.m !== null && !isId(x.m)) return null;
  if (typeof x.r !== "string" || !TAG_RE.test(x.r)) return null;
  if (typeof x.j !== "string" || !TAG_RE.test(x.j)) return null;
  if (!isSec(x.i) || !isSec(x.e)) return null;
  if (x.e <= x.i || (x.e - x.i) * 1000 > MAX_TTL_MS) return null;
  return {
    v: 2,
    k: x.k,
    c: x.c,
    m: x.m as number | null,
    r: x.r,
    i: x.i,
    e: x.e,
    j: x.j,
    s: x.s as TokenScope,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* İki adımlı doğrulama                                                                            */

export interface PreparedToken {
  /** Yükteki `k` ile seçilen anahtar girdisi; kid ↔ özet bağı ÇAĞIRANDA denetlenir. */
  entry: PublicKeyEntry;
  /** İmzalanan baytlar: `SIGN_DOMAIN + yük_base64url` (UTF-8). */
  message: Uint8Array<ArrayBuffer>;
  /** 64 baytlık Ed25519 imzası. */
  signature: Uint8Array<ArrayBuffer>;
  /** Çözülmüş yük metni ve ayrıştırılmış hâli (imzadan ÖNCE yalnızca anahtar seçimi için kullanılır). */
  text: string;
  raw: unknown;
}

export const failToken = (reason: VerifyFailure): { ok: false; reason: VerifyFailure } => ({
  ok: false,
  reason,
});

/**
 * Doğrulamanın imzadan ÖNCEKİ kısmı: biçim → anahtar seçimi. Başarısızsa `VerifyResult` hatası (malformed /
 * unknown_key) döner. Yük içeriğine burada GÜVENİLMEZ; yalnızca `k` alanı anahtarı seçmek için okunur.
 */
export function prepareToken(
  token: unknown,
  keys: readonly PublicKeyEntry[],
): { ok: true; prepared: PreparedToken } | { ok: false; reason: VerifyFailure } {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return failToken("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return failToken("malformed");
  const [, payloadB64, sigB64] = parts as [string, string, string];
  if (
    !payloadB64 ||
    payloadB64.length > MAX_PAYLOAD_B64 ||
    !B64URL_RE.test(payloadB64) ||
    !B64URL_RE.test(sigB64)
  ) {
    return failToken("malformed");
  }
  const signature = b64urlDecode(sigB64);
  if (!signature || signature.length !== 64 || b64urlEncode(signature) !== sigB64) {
    return failToken("malformed");
  }

  // Yükü yalnızca anahtar kimliğini seçmek için ayrıştır; sonuç İMZADAN sonra belirlenir.
  let text: string;
  let raw: unknown;
  try {
    const bytes = b64urlDecode(payloadB64);
    if (!bytes) return failToken("malformed");
    text = utf8Decoder.decode(bytes);
    if (b64urlEncode(utf8.encode(text)) !== payloadB64) return failToken("malformed");
    raw = JSON.parse(text);
  } catch {
    return failToken("malformed");
  }
  const kid = (raw as { k?: unknown } | null)?.k;
  if (typeof kid !== "string" || !KID_RE.test(kid)) return failToken("malformed");
  const entry = keys.find((k) => k.kid === kid);
  if (!entry) return failToken("unknown_key");
  return {
    ok: true,
    prepared: { entry, message: utf8.encode(`${SIGN_DOMAIN}${payloadB64}`), signature, text, raw },
  };
}

/** Doğrulamanın imzadan SONRAKİ kısmı: yük kuralları → zaman. YALNIZCA imza geçerliyse çağrılmalıdır. */
export function concludeToken(p: PreparedToken, now: number): VerifyResult {
  const claims = parseClaims(p.raw);
  if (!claims || canonicalPayload(claims) !== p.text) return failToken("bad_claims");
  if (claims.k !== p.entry.kid) return failToken("bad_claims");
  if (claims.i * 1000 > now + CLOCK_SKEW_MS) return failToken("not_yet_valid");
  if (now >= claims.e * 1000) return failToken("expired");
  return { ok: true, claims };
}
