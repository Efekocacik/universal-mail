import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRM_TTL_MS,
  consumeConfirmNonce,
  issueConfirmToken,
  verifyConfirmToken,
  type ConfirmBinding,
} from "@/lib/mail/test-send-confirm";
import { getSetting } from "@/lib/settings";
import { openMemoryDb } from "./helpers/campaign-fixture";

/**
 * "Kendime test gönder" onay belirteci (saf kütüphane). Ana anahtar ortam değişkeniyle sabitlenir (diske anahtar
 * yazılmaz, gerçek veri klasörüne dokunulmaz). Bu belirteç insan varlığının kesin kanıtı DEĞİLDİR; sahte, başka
 * parametrelere ait, süresi dolmuş veya tekrarlanan istekleri engeller (bkz. test-send-confirm.ts).
 */

const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);
const BINDING: ConfirmBinding = {
  mailboxId: 7,
  templateId: 3,
  leadId: 11,
  address: "satis@firma-ornek.com",
};
const saved: { key?: string } = {};

beforeEach(() => {
  saved.key = process.env.UM_MASTER_KEY;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.UM_MASTER_KEY;
  else process.env.UM_MASTER_KEY = saved.key;
});

describe("belirteç üretimi ve doğrulaması", () => {
  it("geçerli belirteç doğrulanır; süre 120 sn; nonce rastgele ve her seferinde farklı", () => {
    const a = issueConfirmToken(BINDING, NOW);
    const b = issueConfirmToken(BINDING, NOW);
    expect(a.expiresAt).toBe(NOW + CONFIRM_TTL_MS);
    expect(CONFIRM_TTL_MS).toBe(120_000);
    expect(a.token).not.toBe(b.token);
    const ra = verifyConfirmToken(a.token, BINDING, NOW);
    const rb = verifyConfirmToken(b.token, BINDING, NOW);
    expect(ra).toMatchObject({ ok: true, expiresAt: NOW + CONFIRM_TTL_MS });
    expect(rb.ok && ra.ok && ra.nonce !== rb.nonce).toBe(true);
    expect(ra.ok && ra.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("belirteç adresi, kutu numarasını veya ham değerleri AÇIK metin olarak taşımaz (yalnızca özet ve numaralar)", () => {
    const { token } = issueConfirmToken(BINDING, NOW);
    const payload = Buffer.from(token.split(".")[0]!, "base64url").toString("utf8");
    expect(payload).not.toContain("satis@");
    expect(payload).not.toContain("firma-ornek");
    expect(JSON.parse(payload)).toMatchObject({ v: 1, p: "test-send", m: 7, t: 3, l: 11 });
  });

  it("süre: son anda (tam süre sonu) geçerli, bir ms sonra 'süresi dolmuş'", () => {
    const { token } = issueConfirmToken(BINDING, NOW);
    expect(verifyConfirmToken(token, BINDING, NOW + CONFIRM_TTL_MS).ok).toBe(true);
    expect(verifyConfirmToken(token, BINDING, NOW + CONFIRM_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("gelecekte çok ileri tarihli belirteç (saat sapması payını aşan) geçersizdir", () => {
    const { token } = issueConfirmToken(BINDING, NOW + 10 * CONFIRM_TTL_MS);
    expect(verifyConfirmToken(token, BINDING, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("her bağlı alan değişirse geçersiz: kutu, şablon, işletme, adres; adres büyük/küçük harf ve boşluktan etkilenmez", () => {
    const { token } = issueConfirmToken(BINDING, NOW);
    const invalid = { ok: false, reason: "invalid" };
    expect(verifyConfirmToken(token, { ...BINDING, mailboxId: 8 }, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(token, { ...BINDING, templateId: 4 }, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(token, { ...BINDING, leadId: 12 }, NOW)).toEqual(invalid);
    expect(
      verifyConfirmToken(token, { ...BINDING, address: "baska@firma-ornek.com" }, NOW),
    ).toEqual(invalid);
    expect(
      verifyConfirmToken(token, { ...BINDING, address: "  SATIS@Firma-Ornek.com " }, NOW).ok,
    ).toBe(true);
  });

  it("imza: yük veya imza bir bit değişirse, parçalar değişirse, eksik/fazla parça veya yanlış tür varsa geçersiz", () => {
    const { token } = issueConfirmToken(BINDING, NOW);
    const [payload, mac] = token.split(".") as [string, string];
    const flipBit = (b64: string) => {
      const buf = Buffer.from(b64, "base64url");
      buf[buf.length - 1]! ^= 1;
      return buf.toString("base64url");
    };
    const invalid = { ok: false, reason: "invalid" };
    expect(verifyConfirmToken(`${payload}.${flipBit(mac)}`, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(`${flipBit(payload)}.${mac}`, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(`${mac}.${payload}`, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(payload, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(`${token}.x`, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(`${payload}.`, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(".", BINDING, NOW)).toEqual(invalid);
    for (const bad of [undefined, null, 5, {}, [], ""])
      expect(verifyConfirmToken(bad, BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken("x".repeat(1001), BINDING, NOW)).toEqual(invalid);
  });

  it("farklı ana anahtarla imzalanmış belirteç geçmez (anahtar, ana anahtardan türetilir)", () => {
    const { token } = issueConfirmToken(BINDING, NOW);
    process.env.UM_MASTER_KEY = "cd".repeat(32);
    expect(verifyConfirmToken(token, BINDING, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("imza geçerli olsa bile şemaya uymayan veya ekstra alan taşıyan yük reddedilir", () => {
    // Ana anahtardan aynı türetmeyle elle imzalanmış, ama şema dışı yükler.
    const key = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        Buffer.from("ab".repeat(32), "hex"),
        Buffer.alloc(0),
        Buffer.from("universal-mail/test-send-confirm/v1"),
        32,
      ),
    );
    const forge = (obj: unknown) => {
      const p = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
      return `${p}.${crypto.createHmac("sha256", key).update(p).digest().toString("base64url")}`;
    };
    const base = {
      v: 1,
      p: "test-send",
      m: 7,
      t: 3,
      l: 11,
      a: crypto.createHash("sha256").update("satis@firma-ornek.com").digest("hex"),
      n: "0".repeat(32),
      e: NOW + 1000,
    };
    expect(verifyConfirmToken(forge(base), BINDING, NOW).ok).toBe(true); // kontrol: biçim doğru
    const invalid = { ok: false, reason: "invalid" };
    expect(verifyConfirmToken(forge({ ...base, x: 1 }), BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(forge({ ...base, p: "baska-amac" }), BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(forge({ ...base, v: 2 }), BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(forge({ ...base, n: "zz" }), BINDING, NOW)).toEqual(invalid);
    expect(verifyConfirmToken(forge("metin"), BINDING, NOW)).toEqual(invalid);
  });
});

describe("tek kullanım: nonce tüketimi", () => {
  it("ilk tüketim başarılı, aynı nonce ikinci kez reddedilir; farklı nonce bağımsızdır", async () => {
    const { client, db } = await openMemoryDb();
    try {
      const n1 = "1".repeat(32);
      const n2 = "2".repeat(32);
      expect(await consumeConfirmNonce(db, n1, NOW + CONFIRM_TTL_MS, NOW)).toBe(true);
      expect(await consumeConfirmNonce(db, n1, NOW + CONFIRM_TTL_MS, NOW)).toBe(false);
      expect(await consumeConfirmNonce(db, n2, NOW + CONFIRM_TTL_MS, NOW)).toBe(true);
      expect(Object.keys(await getSetting(db, "mail.testSendConfirms")).sort()).toEqual([n1, n2]);
    } finally {
      client.close();
    }
  });

  it("işlem geri alınırsa nonce de geri alınır (belirteç yanmaz); tamamlanırsa kalıcıdır", async () => {
    const { client, db } = await openMemoryDb();
    try {
      const nonce = "3".repeat(32);
      await expect(
        db.transaction(async (tx) => {
          expect(await consumeConfirmNonce(tx, nonce, NOW + CONFIRM_TTL_MS, NOW)).toBe(true);
          throw new Error("kayıt yazılamadı");
        }),
      ).rejects.toThrow("kayıt yazılamadı");
      expect(await getSetting(db, "mail.testSendConfirms")).toEqual({});
      await db.transaction(async (tx) => {
        expect(await consumeConfirmNonce(tx, nonce, NOW + CONFIRM_TTL_MS, NOW)).toBe(true);
      });
      expect(await consumeConfirmNonce(db, nonce, NOW + CONFIRM_TTL_MS, NOW)).toBe(false);
    } finally {
      client.close();
    }
  });

  it("süresi dolmuş kayıtlar budanır, geçerli olanlar korunur", async () => {
    const { client, db } = await openMemoryDb();
    try {
      const old = "a".repeat(32);
      const fresh = "b".repeat(32);
      await consumeConfirmNonce(db, old, NOW - 5 * CONFIRM_TTL_MS, NOW - 10 * CONFIRM_TTL_MS);
      await consumeConfirmNonce(db, fresh, NOW + CONFIRM_TTL_MS, NOW);
      const used = await getSetting(db, "mail.testSendConfirms");
      expect(Object.keys(used)).toEqual([fresh]);
    } finally {
      client.close();
    }
  });
});
