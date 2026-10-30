import crypto from "node:crypto";
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
import { auditLog, leads, templates } from "@/lib/db/schema";
import { DEMO_UNSUBSCRIBE_BASE } from "@/lib/mail/footer";
import { buildRenderContext, CATEGORY_LABELS, categoryLabel } from "@/lib/mail/render-context";
import { seedBuiltinTemplates } from "@/lib/mail/seed";
import {
  archiveTemplate,
  composeEmail,
  CONTENT_HASH_VERSION,
  contentSha256,
  createTemplate,
  TemplateServiceError,
  updateTemplate,
} from "@/lib/mail/template-service";
import { BUILTIN_CATEGORIES, seedCategories } from "@/lib/scan/categories";
import { setSetting } from "@/lib/settings";

/**
 * Bağlam oluşturucu ve şablon servisi. Veritabanı BELLEKTE açılır; gerçek `.data`'ya dokunulmaz, ileti gönderilmez.
 */

let client: Client;
let db: Db;
const NOW = 1_790_000_000_000;
const PROFILE = {
  legalName: "Örnek Dış Ticaret A.Ş.",
  address: "Örnek Mah. 1, İstanbul",
  taxId: "1234567890",
  phone: "+90 212 000 00 00",
  contactName: "Ayşe Yılmaz",
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
  await seedCategories(db);
  await seedBuiltinTemplates(db, NOW);
  await setSetting(db, "company.profile", PROFILE);
});

afterEach(() => {
  client.close();
});

async function addLead(o: Partial<typeof leads.$inferInsert> = {}): Promise<number> {
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    })
    .returning({ id: leads.id });
  return l!.id;
}

async function builtinId(language: "tr" | "en"): Promise<number> {
  const [t] = await db.select().from(templates).where(eq(templates.language, language));
  return t!.id;
}

/** Şablon tablosu ve tüm sayaçların anlık görüntüsü (yan etki denetimi için). */
async function snapshot() {
  const rows = await db.select().from(templates).orderBy(templates.id);
  const counts = await client.execute(
    "SELECT (SELECT COUNT(*) FROM audit_log) a, (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM campaign_leads) c",
  );
  return JSON.stringify({ rows, counts: counts.rows });
}

/* ------------------------------------------------------------------------------------------------ */

describe("bağlam oluşturucu", () => {
  it("yalnızca bizim verimizi kullanır: görünen ad, şehir, kategori etiketi, firma profili", async () => {
    const leadId = await addLead({ displayName: "Kafe Bir" });
    const ctx = await buildRenderContext(db, leadId, "en");
    expect(ctx.values).toEqual({
      isletme_adi: "Kafe Bir",
      sehir: "London",
      kategori: "café",
      gonderen_ad: "Ayşe Yılmaz",
      firma: "Örnek Dış Ticaret A.Ş.",
      firma_adres: "Örnek Mah. 1, İstanbul",
      telefon: "+90 212 000 00 00",
    });
    expect(ctx.countryCode).toBe("GB");
    expect((await buildRenderContext(db, leadId, "tr")).values.kategori).toBe("kafe");
  });

  it("görünen ad yoksa işletme adı boş kalır (Google adı kullanılmaz); profil yoksa uydurulmaz", async () => {
    await client.execute("DELETE FROM settings WHERE key = 'company.profile'");
    const leadId = await addLead({ displayName: null, categoryKey: "ozel-kategori" });
    const ctx = await buildRenderContext(db, leadId, "tr");
    expect(ctx.values.isletme_adi).toBeNull();
    expect(ctx.values.kategori).toBeNull();
    expect(ctx.profile).toBeNull();
    expect(ctx.values.firma).toBeUndefined();
    expect(ctx.values.gonderen_ad).toBeUndefined();
  });

  it("bağlam oluşturucu Google oturum önbelleğini hiç okumaz", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/mail/render-context.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/cache-schema|placeCache|place_cache|getCacheMap|places\/cache/);
  });

  it("her yerleşik kategorinin TR ve EN etiketi vardır; diğer diller İngilizceye düşer", () => {
    for (const c of BUILTIN_CATEGORIES) {
      expect(CATEGORY_LABELS[c.key], c.key).toBeDefined();
      expect(categoryLabel(c.key, "de")).toBe(CATEGORY_LABELS[c.key]!.en);
    }
    expect(categoryLabel(null, "tr")).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("şablon kaydetme", () => {
  it("HTML temizlenip saklanır, düz metin temiz HTML'den üretilir, sürüm 1, denetim kaydı yazılır", async () => {
    const r = await createTemplate(
      db,
      {
        name: "Pub tanıtım",
        language: "en",
        kind: "initial",
        categoryKey: "pub",
        subject: "Supplies for pubs in {{sehir|your area}}",
        bodyHtml:
          '<p onclick="x()">Hello,<br>we supply {{kategori}} businesses.</p><img src="https://t.example/p.gif">',
      },
      NOW,
    );
    expect(r.version).toBe(1);
    expect(r.warnings).toEqual([
      { field: "body", code: "html_sanitized", detail: "img,p[onclick]" },
    ]);
    const [row] = await db.select().from(templates).where(eq(templates.id, r.id));
    expect(row).toMatchObject({
      builtIn: false,
      version: 1,
      categoryKey: "pub",
      bodyHtml: "<p>Hello,<br>we supply {{kategori}} businesses.</p>",
      bodyText: "Hello,\nwe supply {{kategori}} businesses.",
    });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "template.created"));
    expect(audit).toMatchObject({
      entityId: String(r.id),
      detail: { version: 1, language: "en", kind: "initial" },
    });
  });

  it("geçersiz şablon, bilinmeyen kategori ve yanıltıcı konu kaydedilmez", async () => {
    const base = {
      name: "X",
      language: "tr",
      kind: "initial",
      subject: "Teklif",
      bodyHtml: "<p>Merhaba</p>",
    };
    const attempts: [object, string][] = [
      [{ ...base, bodyHtml: "<p>{{acilis_tarihi}}</p>" }, "invalid_template"],
      [{ ...base, bodyHtml: "<p>{{kisisel_giris}}</p>" }, "invalid_template"],
      [{ ...base, subject: "Re: Teklif" }, "invalid_template"],
      [{ ...base, language: "xx" }, "invalid_template"],
      [{ ...base, categoryKey: "yok-boyle-kategori" }, "unknown_category"],
    ];
    const before = await snapshot();
    for (const [d, kind] of attempts) {
      const err = await createTemplate(db, d as never, NOW).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, JSON.stringify(d)).toBeInstanceOf(TemplateServiceError);
      expect((err as TemplateServiceError).kind).toBe(kind);
    }
    expect(await snapshot()).toBe(before);
  });

  it("güncelleme sürümü artırır ve denetime yazar; arşivlenen şablon güncellenemez", async () => {
    const id = await builtinId("tr");
    const r = await updateTemplate(db, id, { subject: "Yeni konu satırı" }, NOW + 1);
    expect(r.version).toBe(2);
    const [row] = await db.select().from(templates).where(eq(templates.id, id));
    expect(row).toMatchObject({ subject: "Yeni konu satırı", version: 2, builtIn: true });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "template.updated")),
    ).toHaveLength(1);

    await archiveTemplate(db, id, NOW + 2);
    await expect(updateTemplate(db, id, { subject: "Başka" })).rejects.toMatchObject({
      kind: "archived",
    });
    await expect(archiveTemplate(db, id)).rejects.toMatchObject({ kind: "archived" });
    await expect(updateTemplate(db, 999, { subject: "x" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "template.archived")),
    ).toHaveLength(1);
  });

  it("geçersiz güncelleme kaydedilmez", async () => {
    const id = await builtinId("en");
    const before = await snapshot();
    await expect(
      updateTemplate(db, id, { bodyHtml: "<p>{{bilinmeyen}}</p>" }),
    ).rejects.toMatchObject({
      kind: "invalid_template",
    });
    expect(await snapshot()).toBe(before);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("ön izleme ve gönderim çıktısı", () => {
  it("demo ön izleme: alt bilgi DEMO işaretli, örnek çıkış bağlantısı; veritabanında hiçbir şey değişmez", async () => {
    const leadId = await addLead();
    const templateId = await builtinId("tr");
    const before = await snapshot();
    const r = await composeEmail(db, { templateId, leadId, mode: "demo", purpose: "preview" });
    expect(await snapshot()).toBe(before); // body_text dahil hiçbir alan değişmedi

    expect(r.errors).toEqual([]);
    expect(r.sendable).toBe(false); // ön izleme hiçbir zaman gönderilebilir değildir
    expect(r.language).toBe("tr");
    expect(r.subject).toBe("Kafe ve restoranlar için sarf malzemesi tedarik teklifi");
    expect(r.subjectLogged).toBe(r.subject);
    expect(r.text).toContain("London bölgesindeki işletmenizle");
    expect(r.text).toContain("Ayşe Yılmaz\nÖrnek Dış Ticaret A.Ş.");
    expect(r.html).toContain("[DEMO]");
    expect(r.text).toContain("[DEMO]");
    expect(r.html).toContain(DEMO_UNSUBSCRIBE_BASE);
    expect(r.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gönderim amacında (demo) eksiksiz çıktı gönderilebilir sayılır; aynı girdi aynı özeti verir", async () => {
    const leadId = await addLead();
    const templateId = await builtinId("en");
    const a = await composeEmail(db, { templateId, leadId, mode: "demo", purpose: "send" });
    expect(a.errors).toEqual([]);
    expect(a.sendable).toBe(true);
    const b = await composeEmail(db, { templateId, leadId, mode: "demo", purpose: "send" });
    expect(b.bodySha256).toBe(a.bodySha256);
  });

  it("içerik özeti (sürüm 1) konu, düz metin ve HTML'i kapsar; konu değişince özet değişir", async () => {
    expect(CONTENT_HASH_VERSION).toBe(1);
    const leadId = await addLead();
    const templateId = await builtinId("en");
    const a = await composeEmail(db, { templateId, leadId, mode: "demo", purpose: "send" });
    expect(a.bodySha256).toBe(
      crypto
        .createHash("sha256")
        .update(JSON.stringify([a.subject, a.text, a.html]), "utf8")
        .digest("hex"),
    );
    expect(a.bodySha256).toBe(contentSha256(a.subject, a.text, a.html));

    await updateTemplate(db, templateId, { subject: "A different subject line" });
    const b = await composeEmail(db, { templateId, leadId, mode: "demo", purpose: "send" });
    expect(b.html).toBe(a.html); // gövde aynı
    expect(b.bodySha256).not.toBe(a.bodySha256); // yalnızca konu farklı

    // Alan sınırları korunur: içerik kaydırıldığında özet farklıdır.
    expect(contentSha256("ab", "c", "")).not.toBe(contentSha256("a", "bc", ""));
  });

  it("eksik değişken gönderimi engeller; ön izlemede işaretlenir; yedek metin varsa geçer", async () => {
    const leadId = await addLead({ city: null });
    const strict = await createTemplate(db, {
      name: "Şehirli",
      language: "en",
      kind: "initial",
      subject: "Hello",
      bodyHtml: "<p>Businesses in {{sehir}}</p>",
    });
    const send = await composeEmail(db, {
      templateId: strict.id,
      leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(send.sendable).toBe(false);
    expect(send.errors).toEqual([{ code: "missing_variables", detail: "sehir" }]);
    expect(send.html).not.toContain("[eksik");
    const preview = await composeEmail(db, {
      templateId: strict.id,
      leadId,
      mode: "demo",
      purpose: "preview",
    });
    expect(preview.html).toContain("[eksik: sehir]");

    const soft = await createTemplate(db, {
      name: "Yedekli",
      language: "en",
      kind: "initial",
      subject: "Hello",
      bodyHtml: "<p>Businesses in {{sehir|your area}}</p>",
    });
    const ok = await composeEmail(db, {
      templateId: soft.id,
      leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(ok.sendable).toBe(true);
    expect(ok.text).toContain("Businesses in your area");
  });

  it("işletme adı yalnızca görünen addan gelir; yoksa eksiktir (Google adı kullanılmaz)", async () => {
    const t = await createTemplate(db, {
      name: "Adlı",
      language: "en",
      kind: "initial",
      subject: "For {{isletme_adi}}",
      bodyHtml: "<p>Hello {{isletme_adi}}</p>",
    });
    const noName = await addLead({ displayName: null });
    expect(
      (await composeEmail(db, { templateId: t.id, leadId: noName, mode: "demo", purpose: "send" }))
        .errors,
    ).toEqual([{ code: "missing_variables", detail: "isletme_adi" }]);
    const named = await addLead({ displayName: "The Corner Café" });
    const r = await composeEmail(db, {
      templateId: t.id,
      leadId: named,
      mode: "demo",
      purpose: "send",
    });
    expect(r.subject).toBe("For The Corner Café");
  });

  it("live: bu sürümde her zaman gönderilemez; güvenli çıkış bağlantısı da zorunludur", async () => {
    const leadId = await addLead();
    const templateId = await builtinId("en");
    const noLink = await composeEmail(db, { templateId, leadId, mode: "live", purpose: "send" });
    expect(noLink.sendable).toBe(false);
    expect(noLink.errors.map((e) => e.code).sort()).toEqual([
      "live_sending_disabled",
      "unsubscribe_link_required",
    ]);
    expect(noLink.html).not.toContain("[DEMO]");
    const withLink = await composeEmail(db, {
      templateId,
      leadId,
      mode: "live",
      purpose: "send",
      unsubscribeUrl: "https://optout.firma-iletisim.com/u/abc",
    });
    expect(withLink.sendable).toBe(false);
    expect(withLink.errors).toEqual([{ code: "live_sending_disabled" }]);
  });

  it("firma profili yoksa alt bilgi ve gönderim yok; çıktıda uydurma bilgi yok", async () => {
    await client.execute("DELETE FROM settings WHERE key = 'company.profile'");
    const leadId = await addLead();
    const r = await composeEmail(db, {
      templateId: await builtinId("tr"),
      leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(r.sendable).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["sender_profile_incomplete", "missing_variables"]);
    expect(r.html).not.toMatch(/undefined|null|Adres:|Vergi/);
  });

  it("veritabanına doğrudan yazılmış geçersiz şablon doldurulmaz", async () => {
    await client.execute(
      `INSERT INTO templates (name, language, kind, subject, body_html, body_text, created_at, updated_at)
       VALUES ('Eski', 'tr', 'initial', 'Konu', '<p>{{acilis_tarihi}}</p>', '', ${NOW}, ${NOW})`,
    );
    const [t] = await db.select().from(templates).where(eq(templates.name, "Eski"));
    const r = await composeEmail(db, {
      templateId: t!.id,
      leadId: await addLead(),
      mode: "demo",
      purpose: "preview",
    });
    expect(r.errors).toEqual([{ code: "template_invalid" }]);
    expect(r.html).toBe("");
  });

  it("arşivlenmiş şablon gönderilemez; olmayan şablon ve lead raporlanır", async () => {
    const leadId = await addLead();
    const id = await builtinId("en");
    await archiveTemplate(db, id);
    const r = await composeEmail(db, { templateId: id, leadId, mode: "demo", purpose: "send" });
    expect(r.sendable).toBe(false);
    expect(r.errors).toEqual([{ code: "template_archived" }]);
    expect(
      (await composeEmail(db, { templateId: 999, leadId, mode: "demo", purpose: "send" })).errors,
    ).toEqual([{ code: "template_not_found" }]);
    expect(
      (
        await composeEmail(db, {
          templateId: await builtinId("tr"),
          leadId: 999,
          mode: "demo",
          purpose: "send",
        })
      ).errors,
    ).toEqual([{ code: "lead_not_found" }]);
  });

  it("şablon servisi gönderim yapacak hiçbir modülü içe aktarmaz", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/mail/template-service.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/nodemailer|googleapis|smtp|gmail|fetch\(/i);
  });
});
