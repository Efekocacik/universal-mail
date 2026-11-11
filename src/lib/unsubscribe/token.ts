import crypto from "node:crypto";

/**
 * İmzalı abonelikten çıkış belirteci (Aşama 15.6, RFC 8058 tek tıklamalı çıkış için).
 *
 * Bu modül SAFTIR: veritabanı, dosya sistemi veya uygulama gizli deposu içermez; yalnızca `node:crypto`. Hem uygulama
 * (imzalama/doğrulama) hem genel HTTPS aktarıcı (yalnızca doğrulama, yalnızca GENEL anahtarla) tarafından kullanılır.
 *
 * Biçim: `u2.<yük_base64url>.<imza_base64url>`
 *  - Algoritma yalnızca Ed25519'dur; belirteçte algoritma alanı YOKTUR (algoritma karışıklığı saldırısı yok).
 *  - İmza girdisi: `um-unsub-v2.` + yük_base64url (alan ayrımı: başka amaçlı imzalar bu belirteç sayılmaz).
 *  - Yük, KESİN kanonik JSON'dur: alan sırası ve türleri sabit; yeniden serileştirilince birebir aynı olmayan yük
 *    reddedilir (imza esnekliği/yük değiştirme yok).
 *  - Kişisel veri YOKTUR: adres yok. Alıcı bağı, uygulamanın gizli anahtarıyla türettiği tek yönlü etiketle (`r`)
 *    yapılır; etiket adres özetinden tahmin edilemez.
 *
 * Yük alanları: v=2, k=anahtar kimliği, c=kampanya alıcısı no, m=giden ileti no (isteğe bağlı, null),
 * r=alıcı etiketi, i=verilme zamanı (sn), e=bitiş zamanı (sn), j=benzersiz kimlik (tekrar oynatma ve tekilleştirme),
 * s=kapsam: "u" = yalnızca abonelikten çıkış; "p" = uç nokta SINAMA belirteci (Aşama 15.7; hiçbir alıcıya bağlanmaz,
 * hiçbir suppression/durdurma üretmez, yalnızca uç noktanın uçtan uca çalıştığını kanıtlar).
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

const B64URL = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[0-9a-f]{16}$/;
const TAG_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_ID = 2_147_483_647;

/** Genel anahtar → kimlik: ham anahtarın SHA-256'sının ilk 8 baytı (hex). */
export function kidOfPublicKey(x: string): string {
  return crypto.createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 16);
}

export function publicKeyObject(x: string): crypto.KeyObject {
  if (!B64URL.test(x) || Buffer.from(x, "base64url").length !== 32) throw new Error("invalid key");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

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

/** Ed25519 özel anahtarıyla imzalar. Girdi doğrulanır; geçersiz yük ile belirteç ÜRETİLMEZ. */
export function signToken(claims: UnsubscribeClaims, privateKey: crypto.KeyObject): string {
  const valid = parseClaims(claims);
  if (!valid) throw new Error("invalid claims");
  const payload = Buffer.from(canonicalPayload(valid), "utf8").toString("base64url");
  const sig = crypto.sign(null, Buffer.from(`${SIGN_DOMAIN}${payload}`, "utf8"), privateKey);
  return `${TOKEN_PREFIX}.${payload}.${sig.toString("base64url")}`;
}

/**
 * Belirteci doğrular. `now` (ms): doğrulama anı; uygulamada tıklama anı olabilir. Sıra: biçim → anahtar → İMZA →
 * yük kuralları → zaman. İmza doğrulanmadan yük içeriğine güvenilmez; imzasız hiçbir alan sonuç belirlemez.
 */
export function verifyToken(
  token: unknown,
  keys: readonly PublicKeyEntry[],
  now: number,
): VerifyResult {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return fail("malformed");
  const [, payloadB64, sigB64] = parts as [string, string, string];
  if (
    !payloadB64 ||
    payloadB64.length > MAX_PAYLOAD_B64 ||
    !B64URL.test(payloadB64) ||
    !B64URL.test(sigB64)
  ) {
    return fail("malformed");
  }
  const sig = Buffer.from(sigB64, "base64url");
  if (sig.length !== 64 || sig.toString("base64url") !== sigB64) return fail("malformed");

  // Yükü yalnızca anahtar kimliğini seçmek için ayrıştır; sonuç İMZADAN sonra belirlenir.
  let text: string;
  let raw: unknown;
  try {
    text = Buffer.from(payloadB64, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== payloadB64) return fail("malformed");
    raw = JSON.parse(text);
  } catch {
    return fail("malformed");
  }
  const kid = (raw as { k?: unknown } | null)?.k;
  if (typeof kid !== "string" || !KID_RE.test(kid)) return fail("malformed");
  const entry = keys.find((k) => k.kid === kid);
  if (!entry) return fail("unknown_key");

  let pub: crypto.KeyObject;
  try {
    // Kimlik, anahtarın özetine bağlı olmalı (yanlış etiketlenmiş anahtar girdisi kabul edilmez).
    if (kidOfPublicKey(entry.x) !== entry.kid) return fail("unknown_key");
    pub = publicKeyObject(entry.x);
  } catch {
    return fail("unknown_key");
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, Buffer.from(`${SIGN_DOMAIN}${payloadB64}`, "utf8"), pub, sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail("bad_signature");

  const claims = parseClaims(raw);
  if (!claims || canonicalPayload(claims) !== text) return fail("bad_claims");
  if (claims.k !== entry.kid) return fail("bad_claims");
  if (claims.i * 1000 > now + CLOCK_SKEW_MS) return fail("not_yet_valid");
  if (now >= claims.e * 1000) return fail("expired");
  return { ok: true, claims };
}

const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });

/** Süreyle sınırlı yeni yük üretir (rastgele benzersiz kimlikle). */
export function newClaims(input: {
  kid: string;
  campaignLeadId: number;
  messageId?: number | null;
  recipientTag: string;
  now: number;
  ttlMs?: number;
  scope?: TokenScope;
}): UnsubscribeClaims {
  const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const i = Math.floor(input.now / 1000);
  return {
    v: 2,
    k: input.kid,
    c: input.campaignLeadId,
    m: input.messageId ?? null,
    r: input.recipientTag,
    i,
    e: i + Math.max(1, Math.floor(ttl / 1000)),
    j: crypto.randomBytes(16).toString("base64url"),
    s: input.scope ?? "u",
  };
}
