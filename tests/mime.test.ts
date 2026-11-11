import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import { leads, templates } from "@/lib/db/schema";
import {
  assertHeaderText,
  encodeDisplayName,
  encodeUnstructured,
  encodeWords,
  foldHeader,
  formatAddress,
  formatDate,
  MimeError,
} from "@/lib/mail/mime/headers";
import {
  buildEmailMessage,
  MessageBuildError,
  wrapHtmlDocument,
} from "@/lib/mail/mime/message-builder";
import {
  DEMO_MESSAGE_ID_DOMAIN,
  generateMessageId,
  isValidMessageId,
} from "@/lib/mail/mime/message-id";
import { buildMimeMessage, MAX_MESSAGE_BYTES, type MimeInput } from "@/lib/mail/mime/mime";
import { encodeBase64Lines, encodeQuotedPrintable } from "@/lib/mail/mime/transfer-encoding";
import { buildUnsubscribeHeaders } from "@/lib/mail/mime/unsubscribe";
import { seedBuiltinTemplates } from "@/lib/mail/seed";
import { composeEmail } from "@/lib/mail/template-service";
import { seedCategories } from "@/lib/scan/categories";
import { setSetting } from "@/lib/settings";
import { decodeEncodedWords, decodeQuotedPrintable, parseMessage } from "./helpers/mime-parse";

/** MIME ve başlıklar. Hiçbir ileti gönderilmez; ağ yok. */

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const LS = String.fromCharCode(0x2028);
const T = Date.UTC(2026, 9, 30, 10, 15, 7);

/** Sabit "rastgele" kaynak: deterministik çıktı için. */
function fixedRandom(seed = 1) {
  let n = seed;
  return (size: number) =>
    Buffer.from(Array.from({ length: size }, () => (n = (n * 131 + 7) % 256)));
}

function lines(raw: string): string[] {
  return raw.split("\r\n");
}

/* ------------------------------------------------------------------------------------------------
 * RFC 5322 / 2047 başlıklar
 * ---------------------------------------------------------------------------------------------- */

describe("başlık kodlama (RFC 2047, RFC 5322)", () => {
  it("ASCII konu olduğu gibi kalır; ASCII dışı veya '=?' içeren metin kodlanır ve geri çözülür", () => {
    expect(encodeUnstructured("Supply offer")).toBe("Supply offer");
    for (const s of [
      "Kafe ve restoranlar için teklif",
      "Fiyat =?UTF-8?B?eA==?= hilesi",
      "Çağrı 🎉 ☕ İĞÜŞÖÇ",
    ]) {
      const enc = encodeUnstructured(s);
      expect(enc).toMatch(/^=\?UTF-8\?B\?/);
      expect(/^[\x20-\x7e]+$/.test(enc)).toBe(true);
      expect(decodeEncodedWords(enc)).toBe(s);
    }
  });

  it("kodlanmış sözcükler 75 karakteri aşmaz ve çok baytlı karakterleri bölmez", () => {
    const long = "Şehrinizdeki işletmeler için özel çözüm 🍰 ".repeat(8);
    const enc = encodeWords(long);
    for (const w of enc.split(" ")) {
      expect(w.length).toBeLessThanOrEqual(75);
      // Her sözcük tek başına geçerli UTF-8'e çözülmeli (karakter bölünmemiş).
      const b64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!;
      const decoded = Buffer.from(b64, "base64");
      expect(decoded.toString("utf8").includes("�")).toBe(false);
    }
    expect(decodeEncodedWords(enc)).toBe(long);
  });

  it("görünen ad: atext olduğu gibi, özel karakterler tırnaklı ve kaçışlı, ASCII dışı kodlu", () => {
    expect(encodeDisplayName("Ayse Yilmaz")).toBe("Ayse Yilmaz");
    expect(encodeDisplayName("Yilmaz, Ayse")).toBe('"Yilmaz, Ayse"');
    expect(encodeDisplayName('A "B" \\ C')).toBe('"A \\"B\\" \\\\ C"');
    const tr = encodeDisplayName("Ayşe Yılmaz – Örnek A.Ş.");
    expect(tr.startsWith('"')).toBe(false);
    expect(decodeEncodedWords(tr)).toBe("Ayşe Yılmaz – Örnek A.Ş.");
  });

  it("adres: yalnızca normalleştirilmiş ASCII adres; Unicode yerel kısım (SMTPUTF8) reddedilir", () => {
    expect(formatAddress("info@cafe.example")).toBe("info@cafe.example");
    expect(formatAddress("info@xn--caf-dma.example", "Café")).toMatch(
      /^=\?UTF-8\?B\?.+\?= <info@xn--caf-dma\.example>$/,
    );
    for (const bad of [
      "Info@cafe.example",
      "info@café.example",
      "çağrı@cafe.example",
      "info@cafe",
      "a b@c.example",
    ]) {
      expect(() => formatAddress(bad), bad).toThrow(MimeError);
    }
  });

  it("başlık değerinde CR, LF, NUL, sekme ve Unicode satır ayırıcıları reddedilir", () => {
    for (const v of [
      `a${CR}b`,
      `a${LF}b`,
      `a${CR}${LF}Bcc: x@y.example`,
      `a${NUL}`,
      "a\tb",
      `a${LS}b`,
    ]) {
      expect(() => assertHeaderText(v, "x")).toThrow(MimeError);
      expect(() => encodeUnstructured(v)).toThrow(MimeError);
      expect(() => encodeDisplayName(v)).toThrow(MimeError);
    }
    expect(() => formatAddress(`info@cafe.example${CR}${LF}Bcc: x@y.example`)).toThrow(MimeError);
  });

  it("RFC 5322 tarih biçimi (UTC)", () => {
    expect(formatDate(T)).toBe("Fri, 30 Oct 2026 10:15:07 +0000");
    expect(formatDate(Date.UTC(2027, 0, 3, 0, 0, 0))).toBe("Sun, 03 Jan 2027 00:00:00 +0000");
    expect(() => formatDate(Number.NaN)).toThrow(MimeError);
  });

  it("katlama: kodlanmış sözcüklü satırlar 76 (RFC 2047), hiçbir satır 998 karakteri aşmaz; açılınca değer aynıdır", () => {
    const value = encodeWords("Uzun bir konu satırı ".repeat(20));
    const folded = foldHeader("Subject", value);
    for (const l of lines(folded)) expect(l.length).toBeLessThanOrEqual(76);
    expect(
      lines(folded)
        .slice(1)
        .every((l) => l.startsWith(" ")),
    ).toBe(true);
    expect(folded.replace(/\r\n /g, " ")).toBe(`Subject: ${value}`);
    expect(() => foldHeader("Subject", "x".repeat(1000))).toThrow(MimeError);
    expect(() => foldHeader("Bad Name", "x")).toThrow(MimeError);
    expect(() => foldHeader("X", "çağrı")).toThrow(MimeError);
  });
});

/* ------------------------------------------------------------------------------------------------
 * RFC 2045 aktarım kodlamaları
 * ---------------------------------------------------------------------------------------------- */

describe("quoted-printable ve base64 (RFC 2045)", () => {
  it("bilinen örnekler", () => {
    expect(encodeQuotedPrintable("Ünal = 5 ")).toBe("=C3=9Cnal =3D 5=20");
    expect(encodeQuotedPrintable("a\tb\t")).toBe("a\tb=09");
    expect(encodeQuotedPrintable("satır1\nsatır2\r\nsatır3\rson")).toBe(
      "sat=C4=B1r1\r\nsat=C4=B1r2\r\nsat=C4=B1r3\r\nson",
    );
  });

  it("uzun satırlar yumuşak satır sonuyla 76 karakterde bölünür; =XX bölünmez; geri çözüm birebir", () => {
    const text = `${"ğ".repeat(100)} ${"a=b ".repeat(60)}\nkısa`;
    const qp = encodeQuotedPrintable(text);
    for (const l of lines(qp)) {
      expect(l.length).toBeLessThanOrEqual(76);
      expect(/=[0-9A-F]?$/.test(l) && !l.endsWith("=")).toBe(false); // yarım =XX yok
    }
    expect(decodeQuotedPrintable(qp)).toBe(text.replace(/\n/g, "\r\n"));
  });

  it("rastgele Unicode metinler birebir geri çözülür", () => {
    const alphabet = ["a", " ", "=", "ç", "İ", "€", "🎉", "\t", "\n", ".", "-", "ı"];
    let seed = 7;
    for (let k = 0; k < 200; k++) {
      let s = "";
      const len = (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 300;
      for (let i = 0; i < len; i++)
        s += alphabet[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % alphabet.length];
      const qp = encodeQuotedPrintable(s);
      expect(/^[\x09\x20-\x7e\r\n]*$/.test(qp)).toBe(true);
      expect(decodeQuotedPrintable(qp)).toBe(s.replace(/\n/g, "\r\n"));
    }
  });

  it("base64 76 karakterlik satırlar", () => {
    const b = encodeBase64Lines(Buffer.alloc(200, 0xab));
    for (const l of lines(b)) expect(l.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(b.replace(/\r\n/g, ""), "base64")).toEqual(Buffer.alloc(200, 0xab));
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("Message-ID", () => {
  it("biçim, alan adı ve benzersizlik", () => {
    const id = generateMessageId("Sirket-Iletisim.com", T, fixedRandom());
    expect(id).toMatch(/^<[0-9a-z]+\.[0-9a-f]{32}@sirket-iletisim\.com>$/);
    expect(isValidMessageId(id)).toBe(true);
    const ids = new Set(
      Array.from({ length: 10_000 }, () => generateMessageId(DEMO_MESSAGE_ID_DOMAIN, T)),
    );
    expect(ids.size).toBe(10_000);
    expect(() => generateMessageId("com", T)).toThrow(MimeError);
    expect(() => generateMessageId("a b.example", T)).toThrow(MimeError);
  });

  it("geçersiz Message-ID biçimleri", () => {
    for (const bad of [
      "abc@x.example",
      "<abc>",
      "<a b@x.example>",
      `<a@x.example>${CR}${LF}Bcc: y`,
      `<${"a".repeat(250)}@x.example>`,
      "<a@x>",
    ]) {
      expect(isValidMessageId(bad), bad).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("çıkış başlıkları (RFC 2369, RFC 8058)", () => {
  it("demo: çalışmayan bağlantı çıkış başlığı olarak sunulmaz", () => {
    expect(
      buildUnsubscribeHeaders({
        mode: "demo",
        url: "https://unsubscribe.invalid/demo/1",
        oneClickEndpointVerified: true,
      }),
    ).toEqual([]);
  });

  it("live: yalnızca güvenli HTTPS; tek tıklama başlığı yalnızca doğrulanmış uç noktayla", () => {
    for (const url of [
      undefined,
      "http://optout.firma.com/u",
      "https://unsubscribe.invalid/x",
      "https://optout.example/u",
    ]) {
      expect(() => buildUnsubscribeHeaders({ mode: "live", url }), String(url)).toThrow(MimeError);
    }
    const url = "https://optout.firma-iletisim.com/u/abc";
    expect(buildUnsubscribeHeaders({ mode: "live", url })).toEqual([
      ["List-Unsubscribe", `<${url}>`],
    ]);
    expect(buildUnsubscribeHeaders({ mode: "live", url, oneClickEndpointVerified: false })).toEqual(
      [["List-Unsubscribe", `<${url}>`]],
    );
    expect(buildUnsubscribeHeaders({ mode: "live", url, oneClickEndpointVerified: true })).toEqual([
      ["List-Unsubscribe", `<${url}>`],
      ["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"],
    ]);
    expect(
      buildUnsubscribeHeaders({ mode: "live", url, mailto: "optout@firma-iletisim.com" }),
    ).toEqual([
      ["List-Unsubscribe", `<${url}>, <mailto:optout@firma-iletisim.com?subject=unsubscribe>`],
    ]);
    expect(() => buildUnsubscribeHeaders({ mode: "live", url, mailto: "Optout@X.com" })).toThrow(
      MimeError,
    );
    expect(() =>
      buildUnsubscribeHeaders({ mode: "live", url: `${url}>,<https://evil.example` }),
    ).toThrow(MimeError);
  });
});

/* ------------------------------------------------------------------------------------------------
 * RFC 2046 çok parçalı ileti
 * ---------------------------------------------------------------------------------------------- */

describe("multipart/alternative ileti (RFC 2046)", () => {
  const base: MimeInput = {
    from: { address: "sales@firma-iletisim.com", name: "Ayşe Yılmaz – Örnek A.Ş." },
    to: { address: "info@cafe.example" },
    subject: "Kafe ve restoranlar için teklif",
    date: T,
    messageId: "<abc.123@firma-iletisim.com>",
    language: "tr",
    text: "Merhaba,\nİyi çalışmalar.\n\n-- \n[DEMO]",
    html: '<!DOCTYPE html>\n<html lang="tr"><body><p>Merhaba,<br>İyi çalışmalar.</p></body></html>',
  };

  it("yapı: başlıklar, ayraç, iki parça, kapanış; yalnızca CRLF ve 7 bit ASCII", () => {
    const m = buildMimeMessage(base, fixedRandom());
    expect(/\r(?!\n)|(?<!\r)\n/.test(m.raw)).toBe(false);
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(m.raw)).toBe(true);
    for (const l of lines(m.raw)) expect(l.length).toBeLessThanOrEqual(998);
    for (const l of parseMessage(m.raw).rawHeaderLines)
      expect(l.length, l).toBeLessThanOrEqual(l.includes("=?") ? 76 : 78);

    const p = parseMessage(m.raw);
    const h = (n: string) => p.headers.get(n.toLowerCase());
    expect(decodeEncodedWords(h("From")![0]!)).toBe(
      "Ayşe Yılmaz – Örnek A.Ş. <sales@firma-iletisim.com>",
    );
    expect(h("To")).toEqual(["info@cafe.example"]);
    expect(decodeEncodedWords(h("Subject")![0]!)).toBe(base.subject);
    expect(h("Date")).toEqual(["Fri, 30 Oct 2026 10:15:07 +0000"]);
    expect(h("Message-ID")).toEqual(["<abc.123@firma-iletisim.com>"]);
    expect(h("MIME-Version")).toEqual(["1.0"]);
    expect(h("Content-Language")).toEqual(["tr"]);
    expect(h("Content-Type")![0]).toBe(`multipart/alternative; boundary="${m.boundary}"`);
    for (const forbidden of [
      "cc",
      "bcc",
      "reply-to",
      "precedence",
      "x-mailer",
      "auto-submitted",
      "list-unsubscribe",
    ]) {
      expect(p.headers.has(forbidden), forbidden).toBe(false);
    }

    expect(p.parts).toHaveLength(2);
    expect(p.parts[0]!.headers.get("content-type")).toEqual(["text/plain; charset=utf-8"]);
    expect(p.parts[1]!.headers.get("content-type")).toEqual(["text/html; charset=utf-8"]);
    expect(p.parts[0]!.body).toBe(base.text.replace(/\n/g, "\r\n"));
    expect(p.parts[1]!.body).toBe(base.html.replace(/\n/g, "\r\n"));
    expect(m.raw.endsWith(`--${m.boundary}--\r\n`)).toBe(true);
    expect(m.sizeBytes).toBe(Buffer.byteLength(m.raw));
  });

  it("aynı girdi ve aynı rastgele kaynak aynı iletiyi üretir; farklı kaynak farklı ayraç", () => {
    expect(buildMimeMessage(base, fixedRandom(3)).raw).toBe(
      buildMimeMessage(base, fixedRandom(3)).raw,
    );
    expect(buildMimeMessage(base).boundary).not.toBe(buildMimeMessage(base).boundary);
  });

  it("gövdedeki ayraç benzeri satırlar yapıyı bozamaz", () => {
    const m0 = buildMimeMessage(base, fixedRandom(5));
    const evil = {
      ...base,
      text: `x\n--${m0.boundary}\nContent-Type: text/html\n\n<script>`,
      html: `--${m0.boundary}--`,
    };
    const m = buildMimeMessage(evil, fixedRandom(5));
    const p = parseMessage(m.raw);
    expect(p.parts).toHaveLength(2);
    expect(p.parts[0]!.body).toBe(evil.text.replace(/\n/g, "\r\n"));
  });

  it("başlık enjeksiyonu denemeleri reddedilir", () => {
    const attempts: Partial<MimeInput>[] = [
      { subject: `Teklif${CR}${LF}Bcc: x@y.example` },
      { subject: `Teklif${LS}Bcc: x@y.example` },
      { from: { address: "sales@firma-iletisim.com", name: `Ayşe${LF}Bcc: x@y.example` } },
      { to: { address: `info@cafe.example${CR}${LF}Bcc: x@y.example` } },
      { messageId: `<a@b.example>${CR}${LF}Bcc: x@y.example` },
      { inReplyTo: `<a@b.example>${LF}X: y` },
      { references: ["<a@b.example>", `<c@d.example>${LF}X: y`] },
      { unsubscribeHeaders: [["Bcc", "x@y.example"]] },
      {
        unsubscribeHeaders: [["List-Unsubscribe", `<https://a.example>${CR}${LF}Bcc: x@y.example`]],
      },
      { language: `tr${LF}X: y` },
    ];
    for (const a of attempts) {
      expect(() => buildMimeMessage({ ...base, ...a }), JSON.stringify(a)).toThrow(MimeError);
    }
  });

  it("takip iletisi: In-Reply-To ve References; en çok 20 referans", () => {
    const refs = ["<a.1@firma-iletisim.com>", "<b.2@firma-iletisim.com>"];
    const p = parseMessage(
      buildMimeMessage({ ...base, inReplyTo: refs[1], references: refs }, fixedRandom()).raw,
    );
    expect(p.headers.get("in-reply-to")).toEqual([refs[1]]);
    expect(p.headers.get("references")).toEqual([refs.join(" ")]);
    const many = Array.from({ length: 21 }, (_, i) => `<r.${i}@firma-iletisim.com>`);
    expect(() => buildMimeMessage({ ...base, references: many })).toThrow(MimeError);
  });

  it("boyut sınırı ve boş konu", () => {
    expect(() =>
      buildMimeMessage({ ...base, html: `<p>${"ç".repeat(MAX_MESSAGE_BYTES)}</p>` }),
    ).toThrow(MimeError);
    expect(() => buildMimeMessage({ ...base, subject: "  " })).toThrow(MimeError);
  });
});

/* ------------------------------------------------------------------------------------------------
 * İleti oluşturucu (Aşama 6 çıktısıyla entegrasyon; bellek içi veritabanı)
 * ---------------------------------------------------------------------------------------------- */

describe("ileti oluşturucu", () => {
  let client: Client;
  let db: Db;
  const PROFILE = {
    legalName: "Örnek Dış Ticaret A.Ş.",
    address: "Örnek Mah. 1, İstanbul",
    taxId: "1234567890",
    phone: "+90 212 000 00 00",
    contactName: "Ayşe Yılmaz",
  };
  const DEMO_MAILBOX = {
    provider: "demo",
    address: "demo@universal-mail.invalid",
    status: "connected",
  };

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = ON");
    db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
    await seedCategories(db);
    await seedBuiltinTemplates(db, T);
    await setSetting(db, "company.profile", PROFILE);
  });

  afterEach(() => {
    client.close();
  });

  async function composed(language: "tr" | "en" = "tr", purpose: "send" | "preview" = "send") {
    const [l] = await db
      .insert(leads)
      .values({
        source: "demo",
        status: "enriched",
        countryCode: "GB",
        city: "London",
        categoryKey: "cafe",
        createdAt: T,
        updatedAt: T,
      })
      .returning({ id: leads.id });
    const [t] = await db.select().from(templates).where(eq(templates.language, language));
    return composeEmail(db, { templateId: t!.id, leadId: l!.id, mode: "demo", purpose });
  }

  it("demo: Aşama 6 çıktısından geçerli MIME; çıkış başlığı yok; Message-ID demo alan adında", async () => {
    const c = await composed("tr");
    const before = await client.execute("SELECT COUNT(*) n FROM messages");
    const built = buildEmailMessage(
      {
        composed: c,
        mailbox: DEMO_MAILBOX,
        profile: PROFILE,
        recipient: "info@cafe.example",
        mode: "demo",
        now: T,
      },
      fixedRandom(),
    );
    expect((await client.execute("SELECT COUNT(*) n FROM messages")).rows[0]!.n).toBe(
      before.rows[0]!.n,
    );

    expect(built.messageId).toMatch(/@universal-mail\.invalid>$/);
    const p = parseMessage(built.raw);
    expect(decodeEncodedWords(p.headers.get("from")![0]!)).toBe(
      "Ayşe Yılmaz – Örnek Dış Ticaret A.Ş. <demo@universal-mail.invalid>",
    );
    expect(p.headers.get("to")).toEqual(["info@cafe.example"]);
    expect(decodeEncodedWords(p.headers.get("subject")![0]!)).toBe(c.subject);
    expect(p.headers.has("list-unsubscribe")).toBe(false);
    for (const l of p.rawHeaderLines)
      expect(l.length, l).toBeLessThanOrEqual(l.includes("=?") ? 76 : 78);
    expect(p.headers.has("list-unsubscribe-post")).toBe(false);
    expect(p.parts[0]!.body).toBe(c.text.replace(/\n/g, "\r\n"));
    expect(p.parts[0]!.body).toContain("[DEMO]");
    expect(p.parts[1]!.body).toContain('<html lang="tr">');
    expect(p.parts[1]!.body).toContain("[DEMO]");
    expect(p.parts[1]!.body).not.toMatch(/<img|<script|src=|@import|url\(/i);
  });

  it("live bu sürümde her zaman reddedilir (güvenli bağlantı ve gerçek kutu olsa bile)", async () => {
    const c = await composed("en");
    expect(() =>
      buildEmailMessage({
        composed: { ...c, sendable: true, errors: [] },
        mailbox: { provider: "gmail", address: "sales@firma-iletisim.com", status: "connected" },
        profile: PROFILE,
        recipient: "info@cafe.example",
        mode: "live",
        now: T,
        unsubscribe: {
          url: "https://optout.firma-iletisim.com/u/1",
          oneClickEndpointVerified: true,
        },
      }),
    ).toThrow(expect.objectContaining({ kind: "live_sending_disabled" }));
  });

  it("güvenlik kontrolleri: kapsam uyuşmazlığı, gönderime hazır olmayan içerik, kutu, profil, alıcı", async () => {
    const c = await composed("tr");
    const ok = {
      composed: c,
      mailbox: DEMO_MAILBOX,
      profile: PROFILE,
      recipient: "info@cafe.example",
      mode: "demo" as const,
      now: T,
    };
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          mailbox: { provider: "gmail", address: "sales@firma-iletisim.com", status: "connected" },
        },
        "scope_mismatch",
      ],
      [{ composed: await composed("tr", "preview") }, "not_sendable"],
      [{ composed: { ...c, errors: [{ code: "missing_variables" }] } }, "not_sendable"],
      [{ mailbox: { ...DEMO_MAILBOX, status: "disabled" } }, "mailbox_not_ready"],
      [{ mailbox: { ...DEMO_MAILBOX, address: null } }, "mailbox_not_ready"],
      [{ profile: null }, "sender_profile_incomplete"],
      [{ profile: { ...PROFILE, legalName: " " } }, "sender_profile_incomplete"],
      [{ recipient: "Info@Cafe.example" }, "invalid_recipient"],
      [{ recipient: `info@cafe.example${CR}${LF}Bcc: x@y.example` }, "invalid_recipient"],
      [{ messageId: "<geçersiz>" }, "mime_error"],
    ];
    for (const [over, kind] of cases) {
      let err: unknown = null;
      try {
        buildEmailMessage({ ...ok, ...over } as never);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(over).slice(0, 80)).toBeInstanceOf(MessageBuildError);
      expect((err as MessageBuildError).kind).toBe(kind);
    }
  });

  it("takip iletisi önceki adıma zincirlenir; konuya 'Re:' eklenmez", async () => {
    const c = await composed("en");
    const prev = generateMessageId(DEMO_MESSAGE_ID_DOMAIN, T - 6 * 86_400_000);
    const built = buildEmailMessage({
      composed: c,
      mailbox: DEMO_MAILBOX,
      profile: PROFILE,
      recipient: "info@cafe.example",
      mode: "demo",
      now: T,
      inReplyTo: prev,
      references: [prev],
    });
    const p = parseMessage(built.raw);
    expect(p.headers.get("in-reply-to")).toEqual([prev]);
    expect(p.headers.get("references")).toEqual([prev]);
    expect(decodeEncodedWords(p.headers.get("subject")![0]!)).toBe(c.subject);
    expect(c.subject).not.toMatch(/^re:/i);
  });

  it("HTML belgesi: yeniden temizlenir, dil etiketi, uzak kaynak yok", () => {
    const doc = wrapHtmlDocument(
      '<p>Merhaba</p><img src="https://t.example/p.gif"><script>x()</script>',
      "tr",
    );
    expect(doc).toContain('<html lang="tr">');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).not.toMatch(/<img|<script/);
    expect(wrapHtmlDocument("<p>x</p>", 'tr" onload="x')).not.toContain("onload");
  });

  it("MIME modülleri ağ veya gönderim kodu içermez", () => {
    const dir = path.resolve(__dirname, "../src/lib/mail/mime");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(
        /from "node:(?:net|tls|http|https|dgram|dns)"|nodemailer|googleapis|fetch\(|createTransport|\bsmtp\b/i,
      );
    }
  });
});
