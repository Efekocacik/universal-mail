import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkSuppression,
  hashEmail,
  importSuppressionsCsv,
  isDomainSuppressed,
  isPublicSuffix,
  liftProtectedSuppression,
  liftSuppression,
  normalizeDomain,
  parseCsv,
  SuppressionError,
  suppressDomain,
  suppressEmail,
  type SuppressionErrorKind,
} from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import { auditLog, leadEmails, leads, suppressions } from "@/lib/db/schema";

/**
 * Suppression servisi. Veritabanı BELLEKTE açılır; gerçek `.data` veritabanına dokunulmaz.
 */

let client: Client;
let db: Db;
const NOW = 1_790_000_000_000;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
});

afterEach(() => {
  client.close();
});

async function expectError(p: Promise<unknown>, kind: SuppressionErrorKind) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SuppressionError);
  expect((err as SuppressionError).kind).toBe(kind);
}

async function activeRows() {
  return (await db.select().from(suppressions)).filter((r) => r.liftedAt === null);
}

/** Veritabanının tüm metnini (tablolar + denetim kaydı) tek dizge olarak döndürür. */
async function dumpAll(): Promise<string> {
  const s = await db.select().from(suppressions);
  const a = await db.select().from(auditLog);
  return JSON.stringify({ s, a });
}

describe("normalleştirme ve özet", () => {
  it("büyük/küçük harf, boşluk ve IDN alan adı aynı özete gider", async () => {
    await suppressEmail(db, {
      email: "  Info@Café.Example ",
      reason: "unsubscribe",
      source: "manual",
    });
    for (const v of ["info@café.example", "INFO@CAFÉ.EXAMPLE", "info@xn--caf-dma.example"]) {
      expect((await checkSuppression(db, v)).suppressed, v).toBe(true);
    }
    const [row] = await db.select().from(suppressions);
    expect(row).toMatchObject({
      scope: "email",
      emailHash: hashEmail("info@xn--caf-dma.example"),
      hashAlg: "sha256-v1",
      emailMasked: "i***@xn--caf-dma.example",
      domain: "xn--caf-dma.example",
    });
  });

  it("açık adres ne suppression tablosuna ne denetim kaydına yazılır", async () => {
    await suppressEmail(db, {
      email: "maria.rossi@trattoria.example",
      reason: "complaint",
      source: "inbox",
    });
    await importSuppressionsCsv(db, "email,reason\nluca.bianchi@trattoria.example,unsubscribe\n");
    const dump = await dumpAll();
    expect(dump).not.toContain("maria.rossi");
    expect(dump).not.toContain("luca.bianchi");
    // Özet yalnızca suppression tablosunda bulunur; denetim kaydında ne adres ne özet vardır.
    const audit = JSON.stringify(await db.select().from(auditLog));
    expect(audit).not.toContain(hashEmail("maria.rossi@trattoria.example"));
    expect(audit).not.toContain(hashEmail("luca.bianchi@trattoria.example"));
    expect(audit).not.toContain("@");
  });

  it("alan adı normalleştirme", () => {
    expect(normalizeDomain(" Cafe.Example. ")).toBe("cafe.example");
    expect(normalizeDomain("@cafe.example")).toBe("cafe.example");
    expect(normalizeDomain("münchen.example")).toBe("xn--mnchen-3ya.example");
    for (const bad of [
      "",
      "com",
      "cafe",
      "http://cafe.example",
      "cafe example",
      "-x.example",
      "a.b/c",
    ]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });
});

describe("ekleme ve kopya önleme", () => {
  it("aynı adres tekrar eklenince kopya oluşmaz; zayıf neden güçlüyü ezmez", async () => {
    const a = await suppressEmail(db, {
      email: "info@a.example",
      reason: "manual",
      source: "manual",
    });
    expect(a.outcome).toBe("added");
    expect(
      (await suppressEmail(db, { email: "INFO@a.example", reason: "manual", source: "csv" }))
        .outcome,
    ).toBe("existing");

    const b = await suppressEmail(db, {
      email: "info@a.example",
      reason: "unsubscribe",
      source: "link",
    });
    expect(b).toMatchObject({ outcome: "strengthened", id: a.id, reason: "unsubscribe" });
    const c = await suppressEmail(db, {
      email: "info@a.example",
      reason: "bounce_hard",
      source: "bounce",
    });
    expect(c).toMatchObject({ outcome: "existing", reason: "unsubscribe" });

    expect(await activeRows()).toHaveLength(1);
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(["suppression.added", "suppression.strengthened"]);
  });

  it("aynı alan adı tekrar eklenince kopya oluşmaz", async () => {
    await suppressDomain(db, { domain: "Chain.Example", reason: "manual", source: "manual" });
    expect(
      (await suppressDomain(db, { domain: "chain.example", reason: "manual", source: "csv" }))
        .outcome,
    ).toBe("existing");
    expect(
      (await suppressDomain(db, { domain: "chain.example", reason: "complaint", source: "inbox" }))
        .outcome,
    ).toBe("strengthened");
    expect(await activeRows()).toHaveLength(1);
  });

  it("geçersiz girdiler reddedilir", async () => {
    await expectError(
      suppressEmail(db, { email: "kötü", reason: "manual", source: "manual" }),
      "invalid_email",
    );
    await expectError(
      suppressEmail(db, { email: "a@b.example", reason: "spam" as never, source: "manual" }),
      "invalid_reason",
    );
    await expectError(
      suppressDomain(db, { domain: "com", reason: "manual", source: "manual" }),
      "invalid_domain",
    );
    await expectError(
      suppressDomain(db, { domain: "a.example", reason: "erasure" as never, source: "manual" }),
      "invalid_reason",
    );
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });
});

describe("merkezi kontrol", () => {
  it("adres özetiyle veya alan adıyla (alt alan adları dahil) eşleşir", async () => {
    await suppressEmail(db, { email: "info@a.example", reason: "bounce_hard", source: "bounce" });
    await suppressDomain(db, { domain: "chain.example", reason: "manual", source: "manual" });

    expect(await checkSuppression(db, "info@a.example")).toMatchObject({
      suppressed: true,
      matches: [{ scope: "email", reason: "bounce_hard" }],
    });
    expect((await checkSuppression(db, "sales@a.example")).suppressed).toBe(false);
    expect((await checkSuppression(db, "anyone@chain.example")).matches).toMatchObject([
      { scope: "domain", domain: "chain.example" },
    ]);
    expect((await checkSuppression(db, "x@london.chain.example")).suppressed).toBe(true);
    expect((await checkSuppression(db, "x@notchain.example")).suppressed).toBe(false);
    expect(await isDomainSuppressed(db, "shop.chain.example")).toBe(true);
    expect(await isDomainSuppressed(db, "other.example")).toBe(false);
  });

  it("çözümlenemeyen adres ve alan adı engelli sayılır (güvenli taraf)", async () => {
    for (const bad of ["", "abc", "a@b", "a@@b.example"]) {
      expect(await checkSuppression(db, bad), bad).toEqual({
        suppressed: true,
        invalidAddress: true,
        matches: [],
      });
    }
    expect(await isDomainSuppressed(db, "not a domain")).toBe(true);
  });
});

describe("kalıcılık", () => {
  it("lead silinse ve aynı adres yeniden taranıp eklense de engel sürer", async () => {
    const insertLead = async () => {
      const [l] = await db
        .insert(leads)
        .values({ source: "demo", status: "new", createdAt: NOW, updatedAt: NOW })
        .returning({ id: leads.id });
      await db.insert(leadEmails).values({
        leadId: l!.id,
        email: "info@kafe.example",
        domain: "kafe.example",
        kind: "generic",
        sourceType: "mailto",
        foundAt: NOW,
        updatedAt: NOW,
      });
      return l!.id;
    };
    const first = await insertLead();
    await suppressEmail(db, { email: "info@kafe.example", reason: "unsubscribe", source: "link" });
    await db.delete(leads).where(eq(leads.id, first)); // e-postaları da cascade ile gider
    expect(await db.select().from(leadEmails)).toHaveLength(0);
    expect((await checkSuppression(db, "info@kafe.example")).suppressed).toBe(true);

    await insertLead(); // yeniden tarama
    expect((await checkSuppression(db, "info@kafe.example")).suppressed).toBe(true);
    expect(await activeRows()).toHaveLength(1);
  });
});

describe("silme talebi (erasure)", () => {
  it("maskeli adres ve not tutulmaz; mevcut engel güçlendirilince de silinir", async () => {
    await suppressEmail(db, {
      email: "ali@kafe.example",
      reason: "manual",
      source: "manual",
      note: "Ali Bey aradı",
    });
    const r = await suppressEmail(db, {
      email: "ali@kafe.example",
      reason: "erasure",
      source: "system",
    });
    expect(r.outcome).toBe("strengthened");
    const [row] = await db.select().from(suppressions);
    expect(row).toMatchObject({ reason: "erasure", emailMasked: null, note: null });
    expect(row!.emailHash).toBe(hashEmail("ali@kafe.example"));
    expect((await checkSuppression(db, "ali@kafe.example")).suppressed).toBe(true);
    expect(await dumpAll()).not.toContain("Ali Bey");

    await suppressEmail(db, {
      email: "veli@kafe.example",
      reason: "erasure",
      source: "system",
      note: "x",
    });
    const [veli] = await db
      .select()
      .from(suppressions)
      .where(like(suppressions.domain, "kafe.example"));
    expect(veli).toBeDefined();
    const all = await db.select().from(suppressions);
    expect(all.find((s) => s.emailHash === hashEmail("veli@kafe.example"))).toMatchObject({
      emailMasked: null,
      note: null,
    });
  });
});

describe("kaldırma", () => {
  it("manuel/teknik engel açık onay ve gerekçeyle kaldırılır; kayıt silinmez, denetime yazılır", async () => {
    const { id } = await suppressEmail(db, {
      email: "info@a.example",
      reason: "bounce_hard",
      source: "bounce",
    });
    await expectError(
      liftSuppression(db, { id, justification: "adres düzeltildi, tekrar denenebilir" }),
      "unconfirmed",
    );
    await expectError(
      liftSuppression(db, { id, confirm: true, justification: "kısa" }),
      "invalid_input",
    );
    await expectError(
      liftSuppression(db, { id, confirm: "yes", justification: "adres düzeltildi tamam" }),
      "unconfirmed",
    );

    await liftSuppression(
      db,
      { id, confirm: true, justification: "posta kutusu yeniden açıldı" },
      NOW + 1,
    );
    const [row] = await db.select().from(suppressions);
    expect(row).toMatchObject({
      liftedAt: NOW + 1,
      liftedReason: "manual: posta kutusu yeniden açıldı",
    });
    expect((await checkSuppression(db, "info@a.example")).suppressed).toBe(false);
    await expectError(
      liftSuppression(db, { id, confirm: true, justification: "ikinci kez kaldırma denemesi" }),
      "already_lifted",
    );
    const lifted = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "suppression.lifted"));
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.detail).toMatchObject({
      scope: "email",
      reason: "bounce_hard",
      protected: false,
    });

    // Yeniden engellenebilir; eski kayıt geçmiş olarak kalır.
    expect(
      (await suppressEmail(db, { email: "info@a.example", reason: "manual", source: "manual" }))
        .outcome,
    ).toBe("added");
    expect(await db.select().from(suppressions)).toHaveLength(2);
    expect(await activeRows()).toHaveLength(1);
  });

  it.each(["unsubscribe", "complaint", "erasure"] as const)(
    "%s engeli sıradan işlemle kaldırılamaz",
    async (reason) => {
      const { id } = await suppressEmail(db, { email: "info@a.example", reason, source: "manual" });
      await expectError(
        liftSuppression(db, { id, confirm: true, justification: "kullanıcı kaldırmak istiyor" }),
        "protected",
      );
      expect((await checkSuppression(db, "info@a.example")).suppressed).toBe(true);
      expect(
        await db.select().from(auditLog).where(eq(auditLog.action, "suppression.lifted")),
      ).toHaveLength(0);
    },
  );

  it("korumalı engel yalnızca belgelenmiş talep ve özel onayla kaldırılır", async () => {
    const { id } = await suppressEmail(db, {
      email: "info@a.example",
      reason: "unsubscribe",
      source: "link",
    });
    const base = {
      id,
      basis: "recipient_request",
      evidenceRef: "TALEP-2026-001",
      justification: "Alıcı yazılı olarak yeniden iletişim istedi",
    };
    await expectError(liftProtectedSuppression(db, { ...base, confirm: true }), "unconfirmed");
    await expectError(
      liftProtectedSuppression(db, {
        ...base,
        confirm: "ALICI_TALEBI_DOGRULANDI",
        evidenceRef: "",
      }),
      "unconfirmed",
    );
    await expectError(
      liftProtectedSuppression(db, {
        ...base,
        confirm: "ALICI_TALEBI_DOGRULANDI",
        basis: "kullanici",
      }),
      "unconfirmed",
    );
    await liftProtectedSuppression(db, { ...base, confirm: "ALICI_TALEBI_DOGRULANDI" }, NOW + 5);
    expect((await checkSuppression(db, "info@a.example")).suppressed).toBe(false);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "suppression.lifted"));
    expect(audit!.detail).toMatchObject({
      reason: "unsubscribe",
      protected: true,
      basis: "recipient_request",
      evidenceRef: "TALEP-2026-001",
    });
  });

  it("olmayan kayıt", async () => {
    await expectError(
      liftSuppression(db, { id: 999, confirm: true, justification: "olmayan kayıt deneme" }),
      "not_found",
    );
  });

  it("alan adı engeli kaldırılınca alt alan adları da serbest kalır", async () => {
    const { id } = await suppressDomain(db, {
      domain: "chain.example",
      reason: "manual",
      source: "manual",
    });
    await liftSuppression(db, { id, confirm: true, justification: "zincir işletme ayrıldı" });
    expect((await checkSuppression(db, "x@shop.chain.example")).suppressed).toBe(false);
  });
});

describe("CSV içe aktarma", () => {
  it("geçerli satırları ekler, kopyaları sayar, geçersizleri satır numarasıyla raporlar", async () => {
    await suppressEmail(db, { email: "dup@a.example", reason: "manual", source: "manual" });
    const csv = [
      "Email,Domain,Reason,Note",
      "info@a.example,,unsubscribe,eski liste",
      "DUP@a.example,,,", // var olan → kopya
      ",chain.example,complaint,",
      "info@a.example,,manual,", // aynı dosyada tekrar → kopya
      "kotu-adres,,,",
      ",com,,",
      "x@b.example,,erasure,",
      "y@b.example,,spam,",
      ",,,",
      "z@b.example,b.example,,",
      '"quoted@c.example",,"bounce_hard","virgül, içeren not"',
    ].join("\r\n");
    const report = await importSuppressionsCsv(db, csv, NOW);
    expect(report).toEqual({
      added: 3,
      strengthened: 0,
      duplicates: 2,
      invalid: [
        { line: 6, error: "invalid_email" },
        { line: 7, error: "invalid_domain" },
        { line: 8, error: "erasure_not_allowed" },
        { line: 9, error: "invalid_reason" },
        { line: 11, error: "ambiguous_value" },
      ],
    });
    expect(await activeRows()).toHaveLength(4);
    expect((await checkSuppression(db, "quoted@c.example")).matches[0]?.reason).toBe("bounce_hard");
    expect(JSON.stringify(report)).not.toContain("kotu-adres"); // rapor içeriği tekrarlamaz

    const [summary] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "suppression.csv_import"));
    expect(summary!.detail).toEqual({ added: 3, strengthened: 0, duplicates: 2, invalid: 5 });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "suppression.added")),
    ).toHaveLength(4);
    const imported = (await db.select().from(suppressions)).filter((s) => s.source === "csv");
    expect(imported).toHaveLength(3);
  });

  it("Türkçe Excel biçimi (; ayırıcı, BOM) desteklenir", async () => {
    const report = await importSuppressionsCsv(db, "﻿email;reason\ninfo@tr.example;unsubscribe\n");
    expect(report.added).toBe(1);
    expect((await checkSuppression(db, "info@tr.example")).suppressed).toBe(true);
  });

  it("başlıksız, boş veya aşırı büyük dosya reddedilir ve hiçbir şey eklenmez", async () => {
    await expectError(importSuppressionsCsv(db, ""), "invalid_input");
    await expectError(
      importSuppressionsCsv(db, "adres,neden\ninfo@a.example,manual"),
      "invalid_input",
    );
    await expectError(
      importSuppressionsCsv(db, `email\n${"a@b.example\n".repeat(200_000)}`),
      "invalid_input",
    );
    await expectError(
      importSuppressionsCsv(db, `email\n${"a@b.example\n".repeat(20_001)}`),
      "invalid_input",
    );
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("CSV ayrıştırıcı tırnak, kaçışlı tırnak ve satır içi satır sonunu işler", () => {
    expect(parseCsv('a,"b ""c""",d\r\n"e\nf",g')).toEqual([
      ["a", 'b "c"', "d"],
      ["e\nf", "g"],
    ]);
    expect(parseCsv("a;b;c", ";")).toEqual([["a", "b", "c"]]);
    expect(parseCsv("a;b", ",")).toEqual([["a;b"]]);
  });
});

describe("genel kayıt uzantıları (Public Suffix List)", () => {
  const SUFFIXES = [
    "co.uk",
    "org.uk",
    "gov.uk",
    "com.tr",
    "gen.tr",
    "com.au",
    "github.io",
    "blogspot.com",
    "s3.amazonaws.com",
    "xn--55qx5d.cn", // 公司.cn (IDN, punycode)
  ];

  it("ICANN, özel ve IDN uzantıları genel uzantı; işletme alan adları değil", () => {
    for (const s of [...SUFFIXES, "com", "uk", "xn--fiqs8s"])
      expect(isPublicSuffix(s), s).toBe(true);
    for (const d of [
      "cafe.co.uk",
      "kafe.com.tr",
      "example.com",
      "user.github.io",
      "shop.cafe.co.uk",
      "chain.example",
      "xn--caf-dma.example",
    ]) {
      expect(isPublicSuffix(d), d).toBe(false);
    }
  });

  it.each(SUFFIXES)("%s alan adı engeli olarak eklenemez", async (suffix) => {
    await expectError(
      suppressDomain(db, { domain: suffix, reason: "manual", source: "manual" }),
      "public_suffix",
    );
    expect(await db.select().from(suppressions)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("büyük harf, sondaki nokta ve Unicode yazım da yakalanır", async () => {
    for (const s of ["CO.UK", "co.uk.", " Gov.UK ", "公司.cn"]) {
      await expectError(
        suppressDomain(db, { domain: s, reason: "manual", source: "manual" }),
        "public_suffix",
      );
    }
  });

  it("genel uzantının altındaki işletme alan adı engellenebilir ve yalnızca kendini kapsar", async () => {
    await suppressDomain(db, { domain: "cafe.co.uk", reason: "manual", source: "manual" });
    await suppressDomain(db, { domain: "user.github.io", reason: "manual", source: "manual" });
    expect((await checkSuppression(db, "info@cafe.co.uk")).suppressed).toBe(true);
    expect((await checkSuppression(db, "info@london.cafe.co.uk")).suppressed).toBe(true);
    expect((await checkSuppression(db, "info@pub.co.uk")).suppressed).toBe(false);
    expect((await checkSuppression(db, "info@other.github.io")).suppressed).toBe(false);
  });

  it("CSV'deki genel uzantı satırı reddedilir ve raporlanır; diğer satırlar eklenir", async () => {
    const report = await importSuppressionsCsv(
      db,
      [
        "domain,reason",
        "co.uk,manual",
        "cafe.co.uk,manual",
        "github.io,complaint",
        "com.tr,manual",
      ].join("\n"),
    );
    expect(report).toEqual({
      added: 1,
      strengthened: 0,
      duplicates: 0,
      invalid: [
        { line: 2, error: "public_suffix" },
        { line: 4, error: "public_suffix" },
        { line: 5, error: "public_suffix" },
      ],
    });
    expect((await activeRows()).map((r) => r.domain)).toEqual(["cafe.co.uk"]);
  });
});

describe("alt alan adları", () => {
  it("üst alan adı engeli tüm alt alan adlarını kapsar; kardeş ve benzer adlar etkilenmez", async () => {
    await suppressDomain(db, { domain: "chain.example", reason: "manual", source: "manual" });
    for (const d of ["chain.example", "shop.chain.example", "a.b.chain.example"]) {
      expect(await isDomainSuppressed(db, d), d).toBe(true);
      expect((await checkSuppression(db, `info@${d}`)).suppressed, d).toBe(true);
    }
    for (const d of ["mychain.example", "chain.example.org", "chain.other"]) {
      expect((await checkSuppression(db, `info@${d}`)).suppressed, d).toBe(false);
    }
  });

  it("alt alan adı engeli üst alan adını ve diğer alt alan adlarını engellemez", async () => {
    await suppressDomain(db, {
      domain: "london.chain.example",
      reason: "manual",
      source: "manual",
    });
    expect((await checkSuppression(db, "x@london.chain.example")).suppressed).toBe(true);
    expect((await checkSuppression(db, "x@shop.london.chain.example")).suppressed).toBe(true);
    expect((await checkSuppression(db, "x@chain.example")).suppressed).toBe(false);
    expect((await checkSuppression(db, "x@paris.chain.example")).suppressed).toBe(false);
  });

  it("adres engeli yalnızca o adresi kapsar, alan adını değil", async () => {
    await suppressEmail(db, { email: "info@chain.example", reason: "unsubscribe", source: "link" });
    expect((await checkSuppression(db, "sales@chain.example")).suppressed).toBe(false);
    expect((await checkSuppression(db, "info@shop.chain.example")).suppressed).toBe(false);
    expect(await isDomainSuppressed(db, "chain.example")).toBe(false);
  });
});

describe("korumalı kaldırmanın erişimi", () => {
  it("liftProtectedSuppression hiçbir API rotasından, arayüzden, işçiden veya Electron'dan çağrılmaz", () => {
    const repo = path.resolve(__dirname, "..");
    const roots = ["src/app", "src/features", "src/components", "src/worker", "electron"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.(ts|tsx|mjs|js)$/.test(e.name) &&
          fs.readFileSync(p, "utf8").includes("liftProtectedSuppression")
        )
          offenders.push(path.relative(repo, p));
      }
    };
    for (const r of roots) if (fs.existsSync(path.join(repo, r))) walk(path.join(repo, r));
    expect(offenders).toEqual([]);
  });

  it("onay ifadesi YETKİLENDİRME DEĞİLDİR: çağıranın kim olduğunu veya talebin gerçekliğini doğrulamaz", async () => {
    // Bu test bir sınırı belgeler: ifadeyi bilen her çağrı (uydurma bir referansla bile) engeli kaldırabilir.
    // Bu yüzden fonksiyon arayüze açılmamalıdır; açılmadan önce gerçek bir yetkilendirme tasarımı gerekir.
    const { id } = await suppressEmail(db, {
      email: "info@a.example",
      reason: "complaint",
      source: "inbox",
    });
    await liftProtectedSuppression(db, {
      id,
      confirm: "ALICI_TALEBI_DOGRULANDI",
      basis: "recipient_request",
      evidenceRef: "uydurma",
      justification: "hiçbir doğrulama yapılmadan çağrıldı",
    });
    expect((await checkSuppression(db, "info@a.example")).suppressed).toBe(false);
  });
});
