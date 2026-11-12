import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as archiveRoute from "@/app/api/templates/[id]/archive/route";
import * as duplicateRoute from "@/app/api/templates/[id]/duplicate/route";
import * as detailRoute from "@/app/api/templates/[id]/route";
import * as previewRoute from "@/app/api/templates/preview/route";
import * as listRoute from "@/app/api/templates/route";
import type { Db } from "@/lib/db/client";
import { auditLog, campaigns, campaignSteps, leads, templates } from "@/lib/db/schema";
import { BUILTIN_TEMPLATES } from "@/lib/mail/builtin-templates";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Şablon API'si ve servis korumaları (Aşama 12): sürüm kilidi, yerleşik şablonun salt okunurluğu, kampanyada
 * kullanılan şablonun kilidi, çoğaltma ve yazma yapmayan canlı önizleme. Bellek içi veritabanı; gerçek `.data` açılmaz.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
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
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}

const DRAFT = {
  name: "Takip testi",
  language: "en",
  kind: "followup",
  subject: "Checking in on our note",
  bodyHtml: "<p>Hello {{isletme_adi|there}}, a quick follow-up from {{firma}}.</p>",
};

const create = (payload: Json = DRAFT) =>
  call(listRoute.POST(req("POST", "/api/templates", payload), undefined));
const patch = (id: number, payload: Json) =>
  call(detailRoute.PATCH(req("PATCH", `/api/templates/${id}`, payload), ctx(id)));
const archive = (id: number, payload: Json) =>
  call(archiveRoute.POST(req("POST", `/api/templates/${id}/archive`, payload), ctx(id)));
const duplicate = (id: number) =>
  call(duplicateRoute.POST(req("POST", `/api/templates/${id}/duplicate`, {}), ctx(id)));
const detail = (id: number) => call(detailRoute.GET(req("GET", `/api/templates/${id}`), ctx(id)));

async function builtInId(language = "en"): Promise<number> {
  const rows = await db.select().from(templates);
  return rows.find((t) => t.builtIn && t.language === language && t.kind === "initial")!.id;
}

/** Şablonu adımında kullanan bir kampanya (verilen durumda) ekler. */
async function campaignUsing(templateId: number, status: string, name = `K-${status}`) {
  const needsStart = ["running", "paused", "completed", "stopped"].includes(status);
  const [c] = await db
    .insert(campaigns)
    .values({
      name,
      status: status as never,
      mailboxId: status === "draft" ? null : DEMO_MAILBOX,
      selection: {},
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      startConfirmedAt: needsStart ? T0 : null,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id });
  await db.insert(campaignSteps).values({
    campaignId: c!.id,
    stepIndex: 0,
    language: "en",
    templateId,
    delayDays: 0,
  });
  return c!.id;
}

async function counts() {
  const r = await client.execute(
    "SELECT (SELECT COUNT(*) FROM templates) t, (SELECT COUNT(*) FROM audit_log) a, (SELECT COUNT(*) FROM messages) m",
  );
  return JSON.stringify(r.rows);
}

describe("oluşturma ve giriş doğrulama", () => {
  it("kullanıcı şablonu oluşturur (201); sürüm 1, yerleşik değil, denetim kaydı var", async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: 1 });
    const [row] = await db
      .select()
      .from(templates)
      .where(eq(templates.id, r.body.id as number));
    expect(row).toMatchObject({
      builtIn: false,
      kind: "followup",
      language: "en",
      archivedAt: null,
    });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "template.created")),
    ).toHaveLength(1);
  });

  it("bilinmeyen alanlar (builtIn, version…) reddedilir; geçersiz şablon sorunlarla 400 döner", async () => {
    for (const extra of [{ builtIn: true }, { version: 9 }, { archivedAt: 1 }, { id: 3 }]) {
      const r = await create({ ...DRAFT, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const bad = await create({ ...DRAFT, bodyHtml: "<p>{{bilinmeyen_degisken}}</p>" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_TEMPLATE");
    expect((bad.body.issues as Json[]).map((i) => i.code)).toContain("unknown_variable");
    expect(JSON.stringify(bad.body)).not.toMatch(/\n\s+at |node_modules|SQLITE/);

    const unsupported = await create({ ...DRAFT, bodyHtml: "<p>{{acilis_tarihi}}</p>" });
    expect(unsupported.status).toBe(400);
    const misleading = await create({ ...DRAFT, subject: "Re: your order" });
    expect(misleading.status).toBe(400);
    // Yalnızca yerleşik şablonlar (TR/EN ilk e-posta + Faz 4 takip şablonları).
    expect(await db.select().from(templates)).toHaveLength(BUILTIN_TEMPLATES.length);
  });

  it("kullanım onayı yoksa değişiklik yapılamaz (403); okuma ve önizleme etkilenmez", async () => {
    const id = (await create()).body.id as number;
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    expect((await create()).status).toBe(403);
    expect((await patch(id, { expectedVersion: 1, subject: "Başka bir konu" })).status).toBe(403);
    expect((await archive(id, { expectedVersion: 1 })).status).toBe(403);
    expect((await duplicate(id)).status).toBe(403);
    expect((await detail(id)).status).toBe(200);
    expect((await call(listRoute.GET(req("GET", "/api/templates"), undefined))).status).toBe(200);
  });
});

describe("sürüm kilidi (iyimser)", () => {
  it("expectedVersion zorunlu; eski sürümle güncelleme 409 CONFLICT döner ve içerik ezilmez", async () => {
    const id = (await create()).body.id as number;
    expect((await patch(id, { subject: "Sürümsüz değişiklik" })).status).toBe(400);
    expect((await patch(id, { expectedVersion: 1 })).status).toBe(400); // alan yok

    const ok = await patch(id, { expectedVersion: 1, subject: "İlk değişiklik" });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);

    const stale = await patch(id, { expectedVersion: 1, subject: "Eski ekrandan gelen" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "CONFLICT", currentVersion: 2 });
    expect((await detail(id)).body).toMatchObject({ subject: "İlk değişiklik", version: 2 });
  });

  it("aynı sürümle iki düzenlemeden yalnızca biri uygulanır", async () => {
    const id = (await create()).body.id as number;
    const results = [
      await patch(id, { expectedVersion: 1, subject: "Birinci düzenleme" }),
      await patch(id, { expectedVersion: 1, subject: "İkinci düzenleme" }),
    ];
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    expect((await detail(id)).body.subject).toBe("Birinci düzenleme");
  });

  it("arşivleme de sürüm ister; arşivlenen şablon değiştirilemez ve listede yalnızca istenince görünür", async () => {
    const id = (await create()).body.id as number;
    expect((await archive(id, {})).status).toBe(400);
    expect((await archive(id, { expectedVersion: 7 })).status).toBe(409);
    expect((await archive(id, { expectedVersion: 1 })).status).toBe(200);
    expect((await patch(id, { expectedVersion: 1, name: "Yeni ad" })).body.code).toBe("ARCHIVED");
    const listed = async (q = "") =>
      (
        (await call(listRoute.GET(req("GET", `/api/templates${q}`), undefined))).body
          .items as Json[]
      ).map((t) => t.id);
    expect(await listed()).not.toContain(id);
    expect(await listed("?archived=1")).toContain(id);
  });
});

describe("yerleşik şablonlar salt okunur", () => {
  it("güncelleme ve arşivleme 409 BUILT_IN; çoğaltma düzenlenebilir kopya verir", async () => {
    const builtIn = await builtInId("en");
    const before = JSON.stringify(
      await db.select().from(templates).where(eq(templates.id, builtIn)),
    );
    const u = await patch(builtIn, { expectedVersion: 1, subject: "Değiştirilmiş konu" });
    expect(u.status).toBe(409);
    expect(u.body.code).toBe("BUILT_IN");
    expect((await archive(builtIn, { expectedVersion: 1 })).body.code).toBe("BUILT_IN");
    expect(JSON.stringify(await db.select().from(templates).where(eq(templates.id, builtIn)))).toBe(
      before,
    );

    const copy = await duplicate(builtIn);
    expect(copy.status).toBe(201);
    const copyId = copy.body.id as number;
    const d = await detail(copyId);
    expect(d.body).toMatchObject({ builtIn: false, version: 1, locked: false });
    expect(d.body.name).toMatch(/\(kopya\)$/);
    expect((await patch(copyId, { expectedVersion: 1, subject: "Kendi konum" })).status).toBe(200);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "template.duplicated")),
    ).toHaveLength(1);
  });

  it("çok uzun adlı şablonun kopya adı sınırı aşmaz", async () => {
    const id = (await create({ ...DRAFT, name: "x".repeat(120) })).body.id as number;
    const copy = await duplicate(id);
    expect(copy.status).toBe(201);
    expect(((await detail(copy.body.id as number)).body.name as string).length).toBeLessThanOrEqual(
      120,
    );
  });
});

describe("kampanyada kullanılan şablon kilitlenir", () => {
  it.each(["ready", "running", "paused"])(
    "%s kampanyası: düzenleme ve arşivleme 409 IN_USE",
    async (status) => {
      const id = (await create()).body.id as number;
      const campaignId = await campaignUsing(id, status);
      const u = await patch(id, { expectedVersion: 1, subject: "Onaydan sonra değişiklik" });
      expect(u.status).toBe(409);
      expect(u.body.code).toBe("IN_USE");
      expect(u.body.campaigns).toEqual([{ id: campaignId, name: `K-${status}`, status }]);
      expect((await archive(id, { expectedVersion: 1 })).body.code).toBe("IN_USE");
      const d = await detail(id);
      expect(d.body).toMatchObject({ locked: true, version: 1, subject: DRAFT.subject });
      const list = (await call(listRoute.GET(req("GET", "/api/templates"), undefined))).body
        .items as Json[];
      expect(list.find((t) => t.id === id)).toMatchObject({ lockedBy: 1 });
    },
  );

  it.each(["draft", "completed", "cancelled"])(
    "%s kampanyası şablonu kilitlemez",
    async (status) => {
      const id = (await create()).body.id as number;
      await campaignUsing(id, status);
      expect((await detail(id)).body.locked).toBe(false);
      expect((await patch(id, { expectedVersion: 1, subject: "Serbest düzenleme" })).status).toBe(
        200,
      );
    },
  );

  it("kampanya iptal edilince kilit kalkar", async () => {
    const id = (await create()).body.id as number;
    const campaignId = await campaignUsing(id, "running");
    expect((await patch(id, { expectedVersion: 1, name: "Kilitli deneme" })).status).toBe(409);
    await db.update(campaigns).set({ status: "cancelled" }).where(eq(campaigns.id, campaignId));
    expect((await patch(id, { expectedVersion: 1, name: "Kilit kalktı" })).status).toBe(200);
  });
});

describe("canlı önizleme: yazmaz, gönderilmez, demo alt bilgisiyle", () => {
  async function lead(displayName: string | null) {
    const [l] = await db
      .insert(leads)
      .values({
        source: "demo",
        status: "enriched",
        countryCode: "GB",
        city: "London",
        categoryKey: "cafe",
        displayName,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: leads.id });
    return l!.id;
  }
  const preview = (draft: Json, leadId: number) =>
    call(previewRoute.POST(req("POST", "/api/templates/preview", { draft, leadId }), undefined));

  it("kaydedilmemiş taslağı doldurur; veritabanında hiçbir şey değişmez", async () => {
    const leadId = await lead("Kafe Bir");
    const before = await counts();
    const r = await preview(DRAFT, leadId);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.subject).toBe(DRAFT.subject);
    expect(r.body.html).toContain("Kafe Bir");
    expect(r.body.html).toContain("[DEMO]"); // zorunlu alt bilgi, demo işaretli
    expect(r.body.missing).toEqual([]);
    expect(await counts()).toBe(before);
  });

  it("eksik bilgi uydurulmaz: işaretlenir ve raporlanır; yedek metin varsa kullanılır", async () => {
    const leadId = await lead(null);
    const strict = await preview(
      { ...DRAFT, bodyHtml: "<p>Merhaba {{isletme_adi}}, {{firma}}.</p>" },
      leadId,
    );
    expect(strict.body.ok).toBe(true);
    expect(strict.body.missing).toEqual(["isletme_adi"]);
    expect((strict.body.errors as Json[]).map((e) => e.code)).toContain("missing_variables");
    const fallback = await preview(DRAFT, leadId);
    expect(fallback.body.missing).toEqual([]);
    expect(fallback.body.html).toContain("Hello there");
  });

  it("geçersiz taslak doğrulama hatalarıyla döner (kaydetme gibi: ok=false)", async () => {
    const leadId = await lead("Kafe İki");
    const r = await preview({ ...DRAFT, bodyHtml: "<p>{{acilis_tarihi}}</p>" }, leadId);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect((r.body.errors as Json[]).map((e) => e.code)).toContain("unsupported_variable");
  });

  it("olmayan işletme ve gönderen profili eksikliği hata kodu olarak bildirilir", async () => {
    const missing = await preview(DRAFT, 99999);
    expect((missing.body.errors as Json[]).map((e) => e.code)).toContain("lead_not_found");
    await client.execute("DELETE FROM settings WHERE key = 'company.profile'");
    const noProfile = await preview(DRAFT, await lead("Kafe Üç"));
    expect((noProfile.body.errors as Json[]).map((e) => e.code)).toContain(
      "sender_profile_incomplete",
    );
  });

  it("katı şema: canlı kip veya ek alan istenemez", async () => {
    const leadId = await lead("Kafe Dört");
    const r = await call(
      previewRoute.POST(
        req("POST", "/api/templates/preview", { draft: DRAFT, leadId, mode: "live" }),
        undefined,
      ),
    );
    expect(r.status).toBe(400);
  });
});

describe("olmayan şablon ve hata biçimi", () => {
  it("404 güvenli gövde döner; geçersiz kimlik 400", async () => {
    const r = await detail(9999);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
    expect(JSON.stringify(r.body)).not.toMatch(/\n\s+at |SQLITE|node_modules/);
    expect((await patch(9999, { expectedVersion: 1, name: "x" })).status).toBe(404);
    expect((await duplicate(9999)).status).toBe(404);
    const bad = await call(detailRoute.GET(req("GET", "/api/templates/abc"), ctx("abc")));
    expect(bad.status).toBe(400);
  });
});
