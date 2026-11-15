import crypto from "node:crypto";
import {
  B64URL_RE,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  SIGN_DOMAIN,
  TOKEN_PREFIX,
  canonicalPayload,
  concludeToken,
  failToken,
  parseClaims,
  prepareToken,
  type PublicKeyEntry,
  type TokenScope,
  type UnsubscribeClaims,
  type VerifyResult,
} from "./token-core";

/**
 * İmzalı abonelikten çıkış belirteci (Aşama 15.6, RFC 8058 tek tıklamalı çıkış için).
 *
 * Bu modül SAFTIR: veritabanı, dosya sistemi veya uygulama gizli deposu içermez; yalnızca `node:crypto`. Uygulama
 * (imzalama/doğrulama) tarafından kullanılır. Aktarıcılar (VPS sunucusu ve Cloudflare Worker) aynı `./token-core`
 * kurallarını WebCrypto ile, yalnızca GENEL anahtarla doğrular (`./web-crypto`).
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

/*
 * Biçim, yük kuralları ve sabitler çalışma ortamından bağımsız `./token-core` içindedir (Cloudflare Worker aktarıcısı
 * da aynı kuralları kullanır); burada yalnızca `node:crypto` ile imzalama/doğrulama vardır. Mevcut içe aktarımlar
 * değişmesin diye çekirdeğin herkese açık adları buradan aynen yeniden dışa aktarılır.
 */
export {
  CLOCK_SKEW_MS,
  DEFAULT_TTL_MS,
  MAX_TOKEN_LENGTH,
  MAX_TTL_MS,
  SIGN_DOMAIN,
  TOKEN_PREFIX,
  canonicalPayload,
  parseClaims,
  type PublicKeyEntry,
  type TokenScope,
  type UnsubscribeClaims,
  type VerifyFailure,
  type VerifyResult,
} from "./token-core";

/** Genel anahtar → kimlik: ham anahtarın SHA-256'sının ilk 8 baytı (hex). */
export function kidOfPublicKey(x: string): string {
  return crypto.createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 16);
}

export function publicKeyObject(x: string): crypto.KeyObject {
  if (!B64URL_RE.test(x) || Buffer.from(x, "base64url").length !== 32)
    throw new Error("invalid key");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
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
  const pre = prepareToken(token, keys);
  if (!pre.ok) return pre;
  const p = pre.prepared;

  let pub: crypto.KeyObject;
  try {
    // Kimlik, anahtarın özetine bağlı olmalı (yanlış etiketlenmiş anahtar girdisi kabul edilmez).
    if (kidOfPublicKey(p.entry.x) !== p.entry.kid) return failToken("unknown_key");
    pub = publicKeyObject(p.entry.x);
  } catch {
    return failToken("unknown_key");
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, p.message, pub, p.signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return failToken("bad_signature");
  return concludeToken(p, now);
}

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
