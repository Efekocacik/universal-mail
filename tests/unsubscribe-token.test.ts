import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_MS,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  SIGN_DOMAIN,
  canonicalPayload,
  kidOfPublicKey,
  newClaims,
  parseClaims,
  signToken,
  verifyToken,
  type PublicKeyEntry,
  type UnsubscribeClaims,
} from "@/lib/unsubscribe/token";

/** İmzalı çıkış belirteci (Aşama 15.6): saf işlevler, gerçek anahtar üretimi, ağ yok. */

const NOW = Date.UTC(2026, 10, 10, 10, 0, 0);
const TAG = "A".repeat(22);

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = kidOfPublicKey(x);
  return { privateKey, entry: { kid, x } as PublicKeyEntry, kid };
}

const A = keypair();
const B = keypair();
const claims = (over: Partial<UnsubscribeClaims> = {}): UnsubscribeClaims => ({
  ...newClaims({ kid: A.kid, campaignLeadId: 7, messageId: 9, recipientTag: TAG, now: NOW }),
  ...over,
});
const sign = (c: UnsubscribeClaims = claims()) => signToken(c, A.privateKey);
const verify = (t: unknown, now = NOW + 1000, keys: PublicKeyEntry[] = [A.entry]) =>
  verifyToken(t, keys, now);

/** Anahtarla imzalı ama biçimi bozuk (kanonik olmayan) yük üretir: imza geçerli, yük kuralları ihlalli. */
function rawSigned(payloadText: string, key = A.privateKey, domain = SIGN_DOMAIN): string {
  const payload = Buffer.from(payloadText, "utf8").toString("base64url");
  const sig = crypto.sign(null, Buffer.from(`${domain}${payload}`, "utf8"), key);
  return `u2.${payload}.${sig.toString("base64url")}`;
}

describe("üretim ve doğrulama", () => {
  it("geçerli belirteç: alanlar korunur, kişisel veri yok, makul uzunluk", () => {
    const t = sign();
    const r = verify(t);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toMatchObject({ v: 2, k: A.kid, c: 7, m: 9, r: TAG, s: "u" });
    expect(t.length).toBeLessThan(400);
    expect(t).toMatch(/^u2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("varsayılan süre 180 gün, üst sınır 400 gün; benzersiz kimlik her seferinde farklı", () => {
    const c = claims();
    expect((c.e - c.i) * 1000).toBe(DEFAULT_TTL_MS);
    const long = newClaims({
      kid: A.kid,
      campaignLeadId: 1,
      recipientTag: TAG,
      now: NOW,
      ttlMs: 10 * MAX_TTL_MS,
    });
    expect((long.e - long.i) * 1000).toBe(MAX_TTL_MS);
    expect(claims().j).not.toBe(claims().j);
    expect(claims({ m: null }).m).toBeNull();
  });

  it("anahtar kimliği genel anahtarın özetidir ve 16 hex karakterdir", () => {
    expect(A.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(kidOfPublicKey(A.entry.x)).toBe(A.kid);
    expect(A.kid).not.toBe(B.kid);
  });

  it("imzalama geçersiz yükle belirteç ÜRETMEZ", () => {
    for (const bad of [
      claims({ c: 0 }),
      claims({ c: 1.5 }),
      claims({ e: NOW / 1000 - 5 }),
      claims({ r: "kisa" }),
      claims({ k: "XYZ" }),
      { ...claims(), s: "x" } as unknown as UnsubscribeClaims,
      { ...claims(), extra: 1 } as unknown as UnsubscribeClaims,
    ]) {
      expect(() => sign(bad)).toThrow();
    }
  });
});

describe("sahte ve değiştirilmiş belirteçler", () => {
  it("imza bayt değişikliği, yük değişikliği ve başka belirteçten imza alma: bad_signature", () => {
    const t = sign();
    const [p, pl, sg] = t.split(".") as [string, string, string];
    const flipped = Buffer.from(sg, "base64url");
    flipped[0]! ^= 0xff;
    expect(verify(`${p}.${pl}.${flipped.toString("base64url")}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // yük değişikliği (başka alıcı): imza artık uymaz
    const forgedClaims = { ...JSON.parse(Buffer.from(pl, "base64url").toString()), c: 8 };
    const forgedPayload = Buffer.from(JSON.stringify(forgedClaims)).toString("base64url");
    expect(verify(`${p}.${forgedPayload}.${sg}`)).toEqual({ ok: false, reason: "bad_signature" });
    // başka bir belirtecin imzası
    const other = sign(claims({ c: 8 })).split(".")[2]!;
    expect(verify(`${p}.${pl}.${other}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("başka anahtarla imzalanmış (aynı kid iddiasıyla) belirteç reddedilir", () => {
    const forged = signToken(claims(), B.privateKey); // kid=A, imza B'ninki
    expect(verify(forged)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("bilinmeyen anahtar kimliği, iptal edilmiş (listede olmayan) anahtar ve kimliği özetle uyuşmayan girdi", () => {
    const t = sign();
    expect(verify(t, NOW + 1000, [B.entry])).toEqual({ ok: false, reason: "unknown_key" });
    expect(verify(t, NOW + 1000, [])).toEqual({ ok: false, reason: "unknown_key" });
    expect(verify(t, NOW + 1000, [{ kid: A.kid, x: B.entry.x }])).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("alan ayrımı: 'um-unsub-v2.' önekiyle imzalanmamış (ham yük imzası) belirteç reddedilir", () => {
    const t = rawSigned(canonicalPayload(claims()), A.privateKey, "baska-amac.");
    expect(verify(t)).toEqual({ ok: false, reason: "bad_signature" });
    const noDomain = rawSigned(canonicalPayload(claims()), A.privateKey, "");
    expect(verify(noDomain)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("geçerli imzalı ama kanonik OLMAYAN veya kural dışı yük: bad_claims", () => {
    const c = claims();
    const canon = canonicalPayload(c);
    const o = JSON.parse(canon) as Record<string, unknown>;
    const cases: [string, string][] = [
      ["boşluklu", canon.replace(",", ", ")],
      [
        "alan sırası farklı",
        JSON.stringify({ k: o.k, v: o.v, c: o.c, m: o.m, r: o.r, i: o.i, e: o.e, j: o.j, s: o.s }),
      ],
      ["fazladan alan", JSON.stringify({ ...o, x: 1 })],
      ["eksik alan", JSON.stringify({ ...o, m: undefined })],
      ["v=1", JSON.stringify({ ...o, v: 1 })],
      ["kapsam başka", JSON.stringify({ ...o, s: "admin" })],
      ["c dize", JSON.stringify({ ...o, c: "7" })],
      ["c negatif", JSON.stringify({ ...o, c: -1 })],
      ["süre sırası ters", JSON.stringify({ ...o, e: (o.i as number) - 1 })],
      [
        "süre üst sınırı aşıyor",
        JSON.stringify({ ...o, e: (o.i as number) + (MAX_TTL_MS / 1000 + 10) }),
      ],
      ["etiket kısa", JSON.stringify({ ...o, r: "x" })],
      ["jti kısa", JSON.stringify({ ...o, j: "x" })],
      ["dizi", "[1,2]"],
      ["null", "null"],
    ];
    for (const [name, text] of cases) {
      const r = verify(rawSigned(text));
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(["bad_claims", "malformed"], name).toContain(r.reason);
    }
  });

  it("anahtar kimliği yükte başka bir anahtara işaret ediyorsa imza o anahtarla denenir (kid B → B listede değilse unknown_key)", () => {
    const o = JSON.parse(canonicalPayload(claims())) as Record<string, unknown>;
    const t = rawSigned(JSON.stringify({ ...o, k: B.kid }), A.privateKey);
    expect(verify(t, NOW + 1000, [A.entry])).toEqual({ ok: false, reason: "unknown_key" });
    expect(verify(t, NOW + 1000, [A.entry, B.entry])).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("biçim hataları: önek, parça sayısı, boş, aşırı uzun, geçersiz karakter, imza uzunluğu, JWT benzeri", () => {
    const t = sign();
    const [, pl, sg] = t.split(".") as [string, string, string];
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      "u2",
      "u2..",
      `u1.${pl}.${sg}`,
      `u3.${pl}.${sg}`,
      `${pl}.${sg}`,
      `u2.${pl}.${sg}.x`,
      `u2.${pl}.`,
      `u2..${sg}`,
      `u2.${pl}.${sg.slice(0, -4)}`,
      `u2.${pl}.${sg}AAAA`,
      `u2.${pl}=.${sg}`,
      `u2.${pl}+.${sg}`,
      `u2.${pl} .${sg}`,
      `u2.${"A".repeat(2000)}.${sg}`,
      "eyJhbGciOiJub25lIn0.eyJjIjo3fQ.",
      "eyJhbGciOiJFZERTQSJ9.eyJjIjo3fQ.c2ln",
      `u2.${pl}.${sg}\n`,
    ];
    for (const b of bad) expect(verify(b), String(b).slice(0, 40)).toMatchObject({ ok: false });
    for (const b of bad) {
      const r = verify(b);
      if (!r.ok)
        expect(["malformed", "bad_signature", "bad_claims", "unknown_key"]).toContain(r.reason);
    }
  });

  it("base64url kanonik değilse (aynı baytlar, farklı kodlama) reddedilir", () => {
    const t = sign();
    const [p, pl, sg] = t.split(".") as [string, string, string];
    // 64 bayt = 86 karakter; son karakterin alt 4 biti kullanılmaz: düşük biti çevirmek AYNI baytlara çözülür.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alt = alphabet[alphabet.indexOf(sg.at(-1)!) ^ 1]!;
    const forgedSig = sg.slice(0, -1) + alt;
    expect(Buffer.from(forgedSig, "base64url").equals(Buffer.from(sg, "base64url"))).toBe(true);
    expect(forgedSig).not.toBe(sg);
    expect(verify(`${p}.${pl}.${forgedSig}`)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("zaman ve kapsam", () => {
  it("süre dolumu: sınırdan önce geçerli, sınırda ve sonrasında 'expired'", () => {
    const c = claims();
    const t = sign(c);
    expect(verify(t, c.e * 1000 - 1).ok).toBe(true);
    expect(verify(t, c.e * 1000)).toEqual({ ok: false, reason: "expired" });
    expect(verify(t, c.e * 1000 + 86_400_000)).toEqual({ ok: false, reason: "expired" });
  });
  it("henüz geçerli değil: saat sapması payı içinde geçerli, dışında reddedilir", () => {
    const c = claims();
    const t = sign(c);
    expect(verify(t, c.i * 1000 - CLOCK_SKEW_MS).ok).toBe(true);
    expect(verify(t, c.i * 1000 - CLOCK_SKEW_MS - 1000)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });
  it("kapsam yalnızca 'u'; parseClaims kesin: fazla/eksik alan ve yanlış türler", () => {
    expect(parseClaims(claims())).not.toBeNull();
    expect(parseClaims({ ...claims(), s: "x" })).toBeNull();
    expect(parseClaims({ ...claims(), extra: 1 })).toBeNull();
    expect(parseClaims(null)).toBeNull();
    expect(parseClaims([])).toBeNull();
    expect(parseClaims({ ...claims(), m: 0 })).toBeNull();
    expect(parseClaims({ ...claims(), m: null })).not.toBeNull();
  });
});
