import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as reevaluateRoute from "@/app/api/campaigns/[id]/leads/reevaluate/route";
import * as leadsRoute from "@/app/api/campaigns/[id]/leads/route";
import {
  addLeadsToCampaign,
  MAX_ADD_BATCH,
  reevaluateExcluded,
  removeCampaignLead,
} from "@/lib/campaigns/enrollment";
import { CampaignError } from "@/lib/campaigns/errors";
import { createCampaign } from "@/lib/campaigns/service";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  campaigns,
  leadEmails,
  leads,
  mailboxes,
  places,
} from "@/lib/db/schema";
import { tr } from "@/lib/i18n/tr";
import { countLeadIds, queryLeadIds } from "@/lib/leads/query";
import { setSetting } from "@/lib/settings";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * C9: hariç tutulan (`excluded`) dizilerin yeniden değerlendirilmesi ve süzgeçle sayfa sayfa ekleme.
 * Veritabanı BELLEKTE; gerçek gönderim yok. Canlı kapılar kapalı kalır: canlı kampanyadaki diziler yeniden
 * denetlemede de hariç kalmalıdır.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  // Süzgeç sorgusu ayrı önbellek tablosuna (`place_cache`) da bağlanır; bellek içi eşdeğeri (boş) kurulur.
  await client.execute(
    "CREATE TABLE IF NOT EXISTS place_cache (place_id TEXT PRIMARY KEY, name TEXT, formatted_address TEXT, primary_type TEXT, types TEXT, business_status TEXT, opening_date TEXT, website TEXT, phone TEXT, intl_phone TEXT, user_rating_count INTEGER, fetched_at INTEGER, enriched_at INTEGER)",
  );
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

let seq = 0;
/** Yer kaydıyla birlikte (süzgeç sorgusu `places` ile birleştirir) demo lead ve birincil e-posta. */
async function lead(
  o: { email?: string; verify?: "verified" | "unverified"; city?: string } = {},
): Promise<number> {
  const n = ++seq;
  const email = o.email ?? `info@c9shop${n}.example`;
  const placeId = `c9-place-${n}`;
  await db.insert(places).values({
    placeId,
    source: "demo",
    coordsFetchedAt: T0,
    firstSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
  });
  const [l] = await db
    .insert(leads)
    .values({
      placeId,
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: o.city ?? "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  await db.insert(leadEmails).values({
    leadId: l!.id,
    email,
    domain: email.split("@")[1]!,
    kind: "generic",
    sourceType: "mailto",
    verifyStatus: o.verify ?? "verified",
    isPrimary: true,
    foundAt: T0,
    updatedAt: T0,
  });
  return l!.id;
}

/** Çok sayıda lead'i tek seferde ekler (sayfalama testi için). */
async function bulkLeads(count: number, city: string): Promise<number[]> {
  const base = seq;
  seq += count;
  const idx = Array.from({ length: count }, (_, i) => base + i + 1);
  for (let i = 0; i < idx.length; i += 200) {
    const part = idx.slice(i, i + 200);
    await db.insert(places).values(
      part.map((n) => ({
        placeId: `c9-place-${n}`,
        source: "demo" as const,
        coordsFetchedAt: T0,
        firstSeenAt: T0,
        createdAt: T0,
        updatedAt: T0,
      })),
    );
    const rows = await db
      .insert(leads)
      .values(
        part.map((n) => ({
          placeId: `c9-place-${n}`,
          source: "demo" as const,
          status: "enriched" as const,
          countryCode: "GB",
          city,
          categoryKey: "cafe",
          createdAt: T0,
          updatedAt: T0,
        })),
      )
      .returning({ id: leads.id });
    await db.insert(leadEmails).values(
      rows.map((r, j) => ({
        leadId: r.id,
        email: `info@c9bulk${part[j]}.example`,
        domain: `c9bulk${part[j]}.example`,
        kind: "generic" as const,
        sourceType: "mailto" as const,
        verifyStatus: "verified" as const,
        isPrimary: true,
        foundAt: T0,
        updatedAt: T0,
      })),
    );
  }
  return (await db.select({ id: leads.id }).from(leads).where(eq(leads.city, city))).map(
    (r) => r.id,
  );
}

async function draft(mailboxId: number | null = DEMO_MAILBOX) {
  const c = await createCampaign(
    db,
    mailboxId === null ? { name: "C9" } : { name: "C9", mailboxId },
    { now: T0 },
  );
  return c.id;
}

async function rowOf(campaignId: number, leadId: number) {
  const [r] = await db
    .select()
    .from(campaignLeads)
    .where(and(eq(campaignLeads.campaignId, campaignId), eq(campaignLeads.leadId, leadId)));
  return r!;
}

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(CampaignError);
  await p.catch((e: CampaignError) => expect(e.code).toBe(code));
}

function req(method: string, url: string, payload?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
type Json = Record<string, unknown>;
async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}

/* ------------------------------------------------------------------------------------------------ */

describe("yeniden ekleme: excluded satır yeniden değerlendirilir", () => {
  it("gerekçe giderilince yeniden eklenen lead pending olur; giderilmediyse gerekçe yenilenir", async () => {
    const id = await draft();
    const a = await lead({ verify: "unverified" });
    const b = await lead({ verify: "unverified" });
    const first = await addLeadsToCampaign(db, id, [a, b], { now: T0 });
    expect(first).toMatchObject({ added: 0, reevaluated: 0 });
    expect((await rowOf(id, a)).exclusionReasons).toContain("email_not_verified");

    await db.update(leadEmails).set({ verifyStatus: "verified" }).where(eq(leadEmails.leadId, a));
    const again = await addLeadsToCampaign(db, id, [a, b], { now: T0 + 1000 });
    expect(again).toMatchObject({ added: 1, duplicates: [], reevaluated: 2 });
    expect(again.excluded).toEqual([{ leadId: b, reasons: ["email_not_verified"] }]);

    const ra = await rowOf(id, a);
    expect(ra).toMatchObject({
      status: "pending",
      recipientEmail: expect.stringMatching(/@c9shop\d+\.example$/),
      exclusionReasons: [],
      language: "en",
      updatedAt: T0 + 1000,
    });
    expect(ra.recipientHash).toBe(hashEmail(ra.recipientEmail!));
    const rb = await rowOf(id, b);
    expect(rb).toMatchObject({ status: "excluded", recipientEmail: null, updatedAt: T0 + 1000 });
    // Benzersiz dizin: yeni satır açılmadı.
    expect(
      await db.select().from(campaignLeads).where(eq(campaignLeads.campaignId, id)),
    ).toHaveLength(2);
    const logs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "campaign.leads_added"))
      .orderBy(auditLog.id);
    expect(logs[1]!.detail).toMatchObject({ added: 1, excluded: 1, duplicates: 0, reevaluated: 2 });
  });

  it("pending ve çıkarılmış (removed) satırlar yine tekrar sayılır; silme talebiyle boşaltılmış satır dokunulmaz", async () => {
    const id = await draft();
    const ok = await lead();
    const gone = await lead();
    const erased = await lead({ verify: "unverified" });
    await addLeadsToCampaign(db, id, [ok, gone, erased], { now: T0 });
    await removeCampaignLead(db, id, (await rowOf(id, gone)).id, { now: T0 });
    await db
      .update(campaignLeads)
      .set({ redactedAt: T0 })
      .where(eq(campaignLeads.id, (await rowOf(id, erased)).id));
    await db
      .update(leadEmails)
      .set({ verifyStatus: "verified" })
      .where(eq(leadEmails.leadId, erased));

    const r = await addLeadsToCampaign(db, id, [ok, gone, erased], { now: T0 + 1 });
    expect(r).toMatchObject({ added: 0, duplicates: [ok, gone, erased], reevaluated: 0 });
    expect((await rowOf(id, gone)).status).toBe("removed");
    expect((await rowOf(id, erased)).status).toBe("excluded");
  });
});

describe("reevaluateExcluded", () => {
  it("geçici gerekçe (posta kutusu yok) giderilince hariç tutulanlar pending olur; kayıt ve kilit güncellenir", async () => {
    const id = await draft(null);
    const a = await lead();
    const b = await lead({ verify: "unverified" });
    await addLeadsToCampaign(db, id, [a, b], { now: T0 });
    expect((await rowOf(id, a)).exclusionReasons).toContain("mailbox_missing");

    // Posta kutusu yokken yeniden denetleme bir şey değiştirmez ama gerekçeleri tazeler.
    const still = await reevaluateExcluded(db, id, { now: T0 + 10 });
    expect(still).toMatchObject({ reevaluated: 2, nowPending: 0, stillExcluded: 2 });

    await db.update(campaigns).set({ mailboxId: DEMO_MAILBOX }).where(eq(campaigns.id, id));
    const [before] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    const r = await reevaluateExcluded(db, id, { now: T0 + 20 });
    expect(r).toMatchObject({ reevaluated: 2, nowPending: 1, stillExcluded: 1 });
    expect(r.updatedAt).toBeGreaterThan(before!.updatedAt);
    expect((await rowOf(id, a)).status).toBe("pending");
    expect((await rowOf(id, b)).exclusionReasons).toEqual(["email_not_verified"]);

    const logs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "campaign.leads_reevaluated"));
    expect(logs).toHaveLength(2);
    expect(logs[1]!.detail).toMatchObject({ reevaluated: 2, nowPending: 1, stillExcluded: 1 });
  });

  it("aynı alan adındaki iki dizi: kimlik sırasıyla ilki pending, ikincisi domain_already_in_campaign", async () => {
    const id = await draft(null);
    const a = await lead({ email: "info@ortak.example" });
    const b = await lead({ email: "sales@ortak.example" });
    await addLeadsToCampaign(db, id, [a, b], { now: T0 });
    await db.update(campaigns).set({ mailboxId: DEMO_MAILBOX }).where(eq(campaigns.id, id));
    expect(await reevaluateExcluded(db, id, { now: T0 + 1 })).toMatchObject({
      nowPending: 1,
      stillExcluded: 1,
    });
    expect((await rowOf(id, a)).status).toBe("pending");
    expect((await rowOf(id, b)).exclusionReasons).toContain("domain_already_in_campaign");
  });

  it("canlı (Gmail) kampanyada canlı ülke kilitliyken hiçbir dizi pending olmaz (kapılar açık olsa bile)", async () => {
    const [live] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    // Gönderim izni verilmiş bağlı Gmail kutusu: tek engel, sahip tarafından açılmamış canlı ülke kilididir.
    await setSetting(db, "mail.gmailGrants", {
      [String(live!.id)]: { send: true, read: false, at: T0 },
    });
    const id = await draft();
    await db.update(campaigns).set({ mailboxId: live!.id }).where(eq(campaigns.id, id));
    const a = await lead();
    await addLeadsToCampaign(db, id, [a], { now: T0 });
    expect((await rowOf(id, a)).exclusionReasons).toEqual(["country_blocked"]);

    const r = await reevaluateExcluded(db, id, { now: T0 + 1 });
    expect(r).toMatchObject({ reevaluated: 1, nowPending: 0, stillExcluded: 1 });
    expect(await rowOf(id, a)).toMatchObject({ status: "excluded", recipientEmail: null });
    expect((await rowOf(id, a)).exclusionReasons).toEqual(["country_blocked"]);
    expect((await addLeadsToCampaign(db, id, [a], { now: T0 + 2 })).added).toBe(0);
  });

  it("yalnızca taslak/hazır kampanya; hariç tutulan yoksa değişiklik ve kayıt yok", async () => {
    await expectError(reevaluateExcluded(db, 9999), "not_found");
    const id = await draft();
    await addLeadsToCampaign(db, id, [await lead()], { now: T0 });
    const [before] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    expect(await reevaluateExcluded(db, id, { now: T0 + 5 })).toEqual({
      reevaluated: 0,
      nowPending: 0,
      stillExcluded: 0,
      updatedAt: before!.updatedAt,
    });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "campaign.leads_reevaluated")),
    ).toHaveLength(0);
    for (const status of ["running", "paused", "completed", "cancelled"] as const) {
      await db.update(campaigns).set({ status, startConfirmedAt: T0 }).where(eq(campaigns.id, id));
      await expectError(reevaluateExcluded(db, id), "not_editable");
    }
  });
});

describe("API: yeniden denetleme ucu", () => {
  it("POST /leads/reevaluate sonucu döndürür; kapalı kampanyada 409, onaysız 403", async () => {
    const id = await draft(null);
    const a = await lead();
    await addLeadsToCampaign(db, id, [a], { now: T0 });
    await db.update(campaigns).set({ mailboxId: DEMO_MAILBOX }).where(eq(campaigns.id, id));
    const ok = await call(
      reevaluateRoute.POST(req("POST", `/api/campaigns/${id}/leads/reevaluate`), ctx(id)),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ reevaluated: 1, nowPending: 1, stillExcluded: 0 });
    expect((await rowOf(id, a)).status).toBe("pending");

    await db
      .update(campaigns)
      .set({ status: "running", startConfirmedAt: T0 })
      .where(eq(campaigns.id, id));
    const closed = await call(
      reevaluateRoute.POST(req("POST", `/api/campaigns/${id}/leads/reevaluate`), ctx(id)),
    );
    expect(closed).toMatchObject({ status: 409, body: { code: "NOT_EDITABLE" } });

    const { settings } = await import("@/lib/db/schema");
    await db.delete(settings).where(eq(settings.key, "consent"));
    const noConsent = await call(
      reevaluateRoute.POST(req("POST", `/api/campaigns/${id}/leads/reevaluate`), ctx(id)),
    );
    expect(noConsent.status).toBe(403);
  });
});

describe("süzgeçle sayfa sayfa ekleme", () => {
  it("queryLeadIds/countLeadIds: kampanyadakiler atlanır, excluded olanlar en sona kalır", async () => {
    const id = await draft();
    const a = await lead({ city: "Leeds" });
    const b = await lead({ city: "Leeds", verify: "unverified" });
    const c = await lead({ city: "Leeds" });
    const filters = { city: "Leeds" };
    // Varsayılan davranış (ör. e-posta bulma) değişmez.
    expect(await queryLeadIds(db, filters)).toEqual([a, b, c]);

    await addLeadsToCampaign(db, id, [a, b], { now: T0 }); // a pending, b excluded
    const page = { notInCampaignId: id };
    expect(await queryLeadIds(db, filters, 2000, page)).toEqual([c, b]);
    expect(await countLeadIds(db, filters, page)).toBe(2);
    expect(await countLeadIds(db, filters, { ...page, includeExcluded: false })).toBe(1);
    expect(await queryLeadIds(db, filters, 1, page)).toEqual([c]);
    // Başka kampanya etkilenmez.
    expect(await queryLeadIds(db, filters, 2000, { notInCampaignId: id + 1 })).toEqual([a, b, c]);
    expect(await queryLeadIds(db, filters)).toEqual([a, b, c]);
  });

  it("aynı süzgeçle art arda ekleme ilerler: matched/taken/remaining döner, bitince açık hata", async () => {
    const id = await draft();
    const all = await bulkLeads(MAX_ADD_BATCH + 3, "Bristol");
    const body = { filterQuery: "city=Bristol" };
    const url = `/api/campaigns/${id}/leads`;

    const first = await call(leadsRoute.POST(req("POST", url, body), ctx(id)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      added: MAX_ADD_BATCH,
      matched: MAX_ADD_BATCH + 3,
      taken: MAX_ADD_BATCH,
      remaining: 3,
      reevaluated: 0,
    });

    const second = await call(leadsRoute.POST(req("POST", url, body), ctx(id)));
    expect(second.body).toMatchObject({ added: 3, matched: 3, taken: 3, remaining: 0 });
    const rows = await db.select().from(campaignLeads).where(eq(campaignLeads.campaignId, id));
    expect(new Set(rows.map((r) => r.leadId))).toEqual(new Set(all));

    const done = await call(leadsRoute.POST(req("POST", url, body), ctx(id)));
    expect(done).toMatchObject({
      status: 400,
      body: { code: "INVALID_INPUT", matched: 0, remaining: 0 },
    });
  }, 60_000);

  it("hariç tutulanlar süzgeçle yeniden eklenince yeniden denetlenir ve remaining'e sayılmaz", async () => {
    const id = await draft();
    const a = await lead({ city: "York", verify: "unverified" });
    const b = await lead({ city: "York" });
    const url = `/api/campaigns/${id}/leads`;
    const first = await call(
      leadsRoute.POST(req("POST", url, { filterQuery: "city=York" }), ctx(id)),
    );
    expect(first.body).toMatchObject({ added: 1, matched: 2, taken: 2, remaining: 0 });
    expect((await rowOf(id, a)).status).toBe("excluded");

    await db.update(leadEmails).set({ verifyStatus: "verified" }).where(eq(leadEmails.leadId, a));
    const again = await call(
      leadsRoute.POST(req("POST", url, { filterQuery: "city=York" }), ctx(id)),
    );
    expect(again.body).toMatchObject({
      added: 1,
      duplicates: [],
      reevaluated: 1,
      matched: 1,
      taken: 1,
      remaining: 0,
    });
    expect((await rowOf(id, a)).status).toBe("pending");
    expect((await rowOf(id, b)).status).toBe("pending");
  });
});

describe("arayüz bağlantısı (DOM'suz kaynak denetimi)", () => {
  const read = (f: string) =>
    fs.readFileSync(path.resolve(__dirname, "..", "src", "features", "campaigns", f), "utf8");

  it("ekleme penceresi sunucunun kalan sayısını gösterir ve sıradakileri aynı süzgeçle ekler", () => {
    const src = read("add-to-campaign-button.tsx");
    expect(src).toMatch(/campaignLeadsApi\.addByFilter\(/);
    expect(src).toMatch(/t\("addToCampaign\.remaining", \{ n: fmtNumber\(result\.remaining\) \}\)/);
    expect(src).toMatch(/result\.remaining > 0 && \(/);
    expect(tr["addToCampaign.remaining"]).toContain("{n}");
    expect(tr["addToCampaign.next"]).toContain("{n}");
  });

  it("kuyruk: yeniden denetleme yalnızca taslak/hazır kampanyada ve hariç tutulan varken görünür", () => {
    const src = read("queue-table.tsx");
    expect(src).toMatch(/campaignLeadsApi\.reevaluate\(campaignId\)/);
    expect(src).toMatch(/editable && excludedCount > 0 && \(/);
    expect(src).toMatch(/campaignStatus === "draft" \|\| campaignStatus === "ready"/);
    // Kırmızı değil: zararsız, geri alınabilir bir işlem (çerçeveli düğme).
    expect(src).toMatch(/variant="outline"\s+onClick=\{\(\) => reevaluate\.mutate/);
  });
});
