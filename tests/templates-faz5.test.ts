import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as duplicateRoute from "@/app/api/templates/[id]/duplicate/route";
import * as detailRoute from "@/app/api/templates/[id]/route";
import * as previewRoute from "@/app/api/templates/preview/route";
import * as listRoute from "@/app/api/templates/route";
import type { Db } from "@/lib/db/client";
import { leads, settings, templates } from "@/lib/db/schema";
import { BUILTIN_TEMPLATES, textToHtml } from "@/lib/mail/builtin-templates";
import { checkContent } from "@/lib/mail/content-check";
import { isInfoOnlyLanguage } from "@/lib/mail/info-only";
import { SUPPORTED_LANGUAGES } from "@/lib/mail/language";
import { seedBuiltinTemplates, TEMPLATE_SEED_VERSION } from "@/lib/mail/seed";
import { renderTemplate, validateTemplate } from "@/lib/mail/template-engine";
import { composeEmail } from "@/lib/mail/template-service";
import { seedCategories } from "@/lib/scan/categories";
import { getSetting } from "@/lib/settings";
import { openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Faz 5 (paket T): hazır şablon seed v3 (DE/FR/ES/IT/NL/PT/PL + TR/EN kafe/pub varyantları), DE'nin yalnızca bilgi
 * amaçlı olması, B konusu (kaydetme, doğrulama, çoğaltma, önizleme) ve `infoOnly`'nin istemciden yazılamaması.
 * Bellek içi veritabanı; gerçek `.data` açılmaz, ağ yok.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  await seedCategories(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

type Json = Record<string, unknown>;
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}
const create = (payload: Json) =>
  call(listRoute.POST(req("POST", "/api/templates", payload), undefined));
const detail = (id: number) => call(detailRoute.GET(req("GET", `/api/templates/${id}`), ctx(id)));
const preview = (payload: Json) =>
  call(previewRoute.POST(req("POST", "/api/templates/preview", payload), undefined));

const DRAFT = {
  name: "A/B deneme",
  language: "en",
  kind: "initial",
  subject: "Supplies for your venue",
  bodyHtml: "<p>Hello from {{firma}} in {{sehir}}.</p>",
};

async function leadId(): Promise<number> {
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  return l!.id;
}

describe("seed v3", () => {
  it("temiz kurulum: 9 dilin genel ilk e-postası ve takibi; yalnızca DE bilgi amaçlı; kafe/pub varyantlarında B konusu", async () => {
    expect(TEMPLATE_SEED_VERSION).toBe(3);
    const rows = await db.select().from(templates);
    expect(rows).toHaveLength(BUILTIN_TEMPLATES.length);
    for (const kind of ["initial", "followup"] as const) {
      const langs = rows
        .filter((r) => r.kind === kind && r.categoryKey === null)
        .map((r) => r.language);
      expect(new Set(langs)).toEqual(new Set(SUPPORTED_LANGUAGES));
    }
    for (const r of rows) {
      expect(r.infoOnly, r.name).toBe(r.language === "de");
      expect(r.bodyHtml).toBe(textToHtml(r.bodyText));
    }
    const variants = rows.filter((r) => r.categoryKey !== null);
    expect(variants.map((r) => `${r.language}:${r.categoryKey}`).sort()).toEqual([
      "en:cafe",
      "en:pub",
      "tr:cafe",
      "tr:pub",
    ]);
    expect(variants.every((r) => r.kind === "initial" && !!r.subjectB)).toBe(true);
    expect(rows.filter((r) => r.categoryKey === null).every((r) => r.subjectB === null)).toBe(true);
  });

  it("v2 kurulum: yalnızca eksik Faz 5 şablonları eklenir; düzenlenmiş şablona dokunulmaz; ikinci çalıştırma 0", async () => {
    const faz5 = BUILTIN_TEMPLATES.filter((t) => t.since === 3);
    for (const t of faz5) await db.delete(templates).where(eq(templates.name, t.name));
    await db.update(templates).set({ subject: "Kendi konum" }).where(eq(templates.builtIn, true));
    await db
      .update(settings)
      .set({ value: { templates: 2, demoMailbox: 1 } })
      .where(eq(settings.key, "seed.faz3"));
    expect(await seedBuiltinTemplates(db, T0 + 1)).toBe(faz5.length);
    expect(await seedBuiltinTemplates(db, T0 + 2)).toBe(0);
    const rows = await db.select().from(templates);
    const old = rows.filter((r) => !faz5.some((t) => t.name === r.name));
    expect(old.every((r) => r.subject === "Kendi konum")).toBe(true);
    expect((await getSetting(db, "seed.faz3")).templates).toBe(3);
  });

  it("her hazır şablon geçerli, içerik denetiminden geçer ve eksiksiz doldurulur (A ve B konusu)", () => {
    const values = { sehir: "London", firma: "Örnek A.Ş.", gonderen_ad: "Ayşe Yılmaz" };
    for (const t of BUILTIN_TEMPLATES) {
      for (const subject of [t.subject, ...(t.subjectB ? [t.subjectB] : [])]) {
        const v = validateTemplate({ ...t, subject, bodyHtml: textToHtml(t.bodyText) });
        expect(v.errors, `${t.name}: ${subject}`).toEqual([]);
        const r = renderTemplate({ subject, bodyHtml: textToHtml(t.bodyText) }, values);
        expect(r.missing, t.name).toEqual([]);
        const c = checkContent({ subject: r.subject, body: r.text });
        expect(c.errors, t.name).toEqual([]);
        expect(
          c.warnings.filter((w) => w.code === "risky_phrase"),
          t.name,
        ).toEqual([]);
      }
      // Google içeriği ve yapay zekâ girişi kullanılmaz (Faz 3 kuralı).
      expect(t.bodyText).not.toMatch(/\{\{(isletme_adi|kisisel_giris)/);
      expect(t.since === 3 || !isInfoOnlyLanguage(t.language)).toBe(true);
    }
  });
});

describe("şablon API'si: B konusu ve bilgi amaçlı dil", () => {
  it("B konusu kaydedilir ve döner; boş metin A/B'yi kapatır; takip şablonunda saklanmaz", async () => {
    const c = await create({ ...DRAFT, subjectB: "  A second subject line  " });
    expect(c.status).toBe(201);
    const id = c.body.id as number;
    const d = await detail(id);
    expect(d.body).toMatchObject({ subjectB: "A second subject line", infoOnly: false });

    const p = await call(
      detailRoute.PATCH(
        req("PATCH", `/api/templates/${id}`, { expectedVersion: 1, subjectB: "" }),
        ctx(id),
      ),
    );
    expect(p.status).toBe(200);
    expect((await detail(id)).body.subjectB).toBeNull();

    const f = await create({ ...DRAFT, kind: "followup", subjectB: "Ignored for follow-ups" });
    expect((await detail(f.body.id as number)).body.subjectB).toBeNull();
  });

  it("geçersiz B konusu (yanıltıcı 'Re:', bilinmeyen değişken) 400 INVALID_TEMPLATE ve alan subjectB", async () => {
    for (const bad of ["Re: our offer", "Hi {{bilinmeyen}}"]) {
      const r = await create({ ...DRAFT, subjectB: bad });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("INVALID_TEMPLATE");
      expect((r.body.issues as { field: string }[]).some((i) => i.field === "subjectB")).toBe(true);
    }
  });

  it("infoOnly istemciden yazılamaz (400 VALIDATION); DE şablonu her zaman bilgi amaçlı", async () => {
    const forced = await create({ ...DRAFT, infoOnly: false });
    expect(forced.status).toBe(400);
    expect(forced.body.code).toBe("VALIDATION");

    const de = await create({ ...DRAFT, language: "de", subject: "Angebot", name: "DE eigen" });
    expect(de.status).toBe(201);
    expect((await detail(de.body.id as number)).body.infoOnly).toBe(true);
    const list = await call(listRoute.GET(req("GET", "/api/templates"), undefined));
    const items = list.body.items as { language: string; infoOnly: boolean }[];
    expect(items.filter((i) => i.language === "de").every((i) => i.infoOnly)).toBe(true);
    expect(items.filter((i) => i.language !== "de").some((i) => i.infoOnly)).toBe(false);
  });

  it("çoğaltma B konusunu ve kategoriyi korur; DE kopyası bilgi amaçlı kalır", async () => {
    const rows = await db.select().from(templates);
    const cafe = rows.find((r) => r.language === "tr" && r.categoryKey === "cafe")!;
    const de = rows.find((r) => r.language === "de" && r.kind === "initial")!;
    const c1 = await call(
      duplicateRoute.POST(req("POST", `/api/templates/${cafe.id}/duplicate`, {}), ctx(cafe.id)),
    );
    expect(c1.status).toBe(201);
    expect((await detail(c1.body.id as number)).body).toMatchObject({
      subjectB: cafe.subjectB,
      categoryKey: "cafe",
      infoOnly: false,
      builtIn: false,
    });
    const c2 = await call(
      duplicateRoute.POST(req("POST", `/api/templates/${de.id}/duplicate`, {}), ctx(de.id)),
    );
    expect((await detail(c2.body.id as number)).body.infoOnly).toBe(true);
  });
});

describe("önizleme: A/B", () => {
  it("variant b B konusunu, varsayılan A konusunu gösterir; B konusu yoksa 400 TEMPLATE_NO_VARIANT_B", async () => {
    const id = await leadId();
    const draft = { ...DRAFT, subjectB: "Consumables for cafés in {{sehir}}" };
    const a = await preview({ draft, leadId: id });
    expect(a.body).toMatchObject({ ok: true, subject: "Supplies for your venue", variant: "a" });
    const b = await preview({ draft, leadId: id, variant: "b" });
    expect(b.body).toMatchObject({
      ok: true,
      subject: "Consumables for cafés in London",
      variant: "b",
    });

    const none = await preview({ draft: DRAFT, leadId: id, variant: "b" });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe("TEMPLATE_NO_VARIANT_B");
    const followup = await preview({
      draft: { ...draft, kind: "followup" },
      leadId: id,
      variant: "b",
    });
    expect(followup.body.code).toBe("TEMPLATE_NO_VARIANT_B");

    const invalidB = await preview({
      draft: { ...draft, subjectB: "{{bozuk" },
      leadId: id,
      variant: "b",
    });
    expect(invalidB.body.ok).toBe(false);
  });

  it("gönderim çıktısı: bilgi amaçlı şablon önizlenir ama gönderilemez", async () => {
    const id = await leadId();
    const de = (await db.select().from(templates)).find(
      (r) => r.language === "de" && r.kind === "initial",
    )!;
    const pv = await composeEmail(db, {
      templateId: de.id,
      leadId: id,
      mode: "demo",
      purpose: "preview",
    });
    expect(pv.errors.map((e) => e.code)).not.toContain("template_info_only");
    const send = await composeEmail(db, {
      templateId: de.id,
      leadId: id,
      mode: "demo",
      purpose: "send",
    });
    expect(send.sendable).toBe(false);
    expect(send.errors.map((e) => e.code)).toContain("template_info_only");
  });
});
