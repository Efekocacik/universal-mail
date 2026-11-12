import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as bulkRoute from "@/app/api/leads/bulk/route";
import * as exportRoute from "@/app/api/export/leads/route";
import * as leadRoute from "@/app/api/leads/[id]/route";
import * as leadsRoute from "@/app/api/leads/route";
import * as pointsRoute from "@/app/api/leads/points/route";
import * as facetsRoute from "@/app/api/leads/facets/route";
import * as findRoute from "@/app/api/leads/find-emails/route";
import { setSetting } from "@/lib/settings";
import { addLeadsSchema } from "@/app/api/campaigns/schema";
import { FILTER_QUERY_MAX, parseLeadFilters, selectionSchema } from "@/lib/api/filters";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, campaignLeads, leads, places } from "@/lib/db/schema";
import { resolveSelection, runBulk } from "@/lib/leads/bulk";
import { patchLead } from "@/lib/leads/mutations";
import { auditFilterSummary, countLeadIds, queryLeadIds, queryLeads } from "@/lib/leads/query";
import { createCampaign } from "./helpers/campaign-fixture";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
const T = Date.UTC(2026, 10, 12, 9, 0, 0);
const DAY = 86_400_000;
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

interface Seed {
  status?: "new" | "do_not_contact" | "customer";
  country?: string;
  wasFuture?: boolean;
  isClosed?: boolean;
  newDetectedAt?: number | null;
  openedDetectedAt?: number | null;
  firstSeenAt?: number;
  archivedAt?: number | null;
}

let n = 0;
/** Yer + lead çifti (demo kaynaklı, gerçek veri değil). */
async function seedLead(s: Seed = {}): Promise<number> {
  const placeId = `demo:bulk-${++n}`;
  await db.insert(places).values({
    placeId,
    source: "demo",
    lat: 51.5 + n * 0.001,
    lng: -0.12,
    coordsFetchedAt: T,
    wasFuture: s.wasFuture ?? false,
    isClosed: s.isClosed ?? false,
    firstSeenAt: s.firstSeenAt ?? T - 30 * DAY,
    newDetectedAt: s.newDetectedAt ?? null,
    openedDetectedAt: s.openedDetectedAt ?? null,
    createdAt: T,
    updatedAt: T,
  });
  const [l] = await db
    .insert(leads)
    .values({
      placeId,
      source: "demo",
      countryCode: s.country ?? "GB",
      city: "London",
      categoryKey: "cafe",
      status: s.status ?? "new",
      createdAt: T,
      updatedAt: T,
      archivedAt: s.archivedAt ?? null,
    })
    .returning({ id: leads.id });
  return l!.id;
}

async function seedMany(k: number, s: Seed = {}): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(await seedLead(s));
  return out;
}

const archivedOf = async (id: number) =>
  (await db.select({ a: leads.archivedAt }).from(leads).where(eq(leads.id, id)))[0]!.a;
const statusOf = async (id: number) =>
  (await db.select({ s: leads.status }).from(leads).where(eq(leads.id, id)))[0]!.s;

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  n = 0;
});
afterEach(async () => {
  await t.cleanup();
});

describe("süzgeç ayrıştırma (lifecycle, detectedSince, archived, ortak sınır)", () => {
  it("lifecycle ve detectedSince çözümlenir; geçersiz değerler 400 FILTER_INVALID", () => {
    const f = parseLeadFilters(
      new URLSearchParams("lifecycle=opened,new&detectedSince=1700000000000&archived=1"),
    );
    expect(f.lifecycle).toEqual(["opened", "new"]);
    expect(f.detectedSince).toBe(1_700_000_000_000);
    expect(f.archived).toBe(true);
    expect(parseLeadFilters(new URLSearchParams("archived=0")).archived).toBeUndefined();
    for (const bad of [
      "lifecycle=closed",
      "detectedSince=abc",
      "detectedSince=-5",
      "detectedSince=1.5",
    ]) {
      try {
        parseLeadFilters(new URLSearchParams(bad));
        expect.unreachable(bad);
      } catch (e) {
        expect((e as { status: number }).status).toBe(400);
        expect((e as { extra: { code: string } }).extra.code).toBe("FILTER_INVALID");
      }
    }
  });

  it("filterQuery sınırı her yerde 8000: kampanya ekleme ve toplu seçim aynı uzunluğu kabul eder", () => {
    const long = `q=${"a".repeat(FILTER_QUERY_MAX - 2)}`;
    expect(long.length).toBe(FILTER_QUERY_MAX);
    expect(addLeadsSchema.safeParse({ filterQuery: long }).success).toBe(true);
    expect(selectionSchema.safeParse({ filterQuery: long }).success).toBe(true);
    expect(addLeadsSchema.safeParse({ filterQuery: long + "a" }).success).toBe(false);
    expect(selectionSchema.safeParse({ filterQuery: long + "a" }).success).toBe(false);
    expect(selectionSchema.safeParse({ leadIds: [] }).success).toBe(false);
    expect(
      selectionSchema.safeParse({ leadIds: Array.from({ length: 2001 }, (_, i) => i + 1) }).success,
    ).toBe(false);
    expect(selectionSchema.safeParse({ leadIds: [1], filterQuery: "" }).success).toBe(false);
  });
});

describe("lifecycle ve detectedSince sorguları", () => {
  it("opened/new/future ve tarih alt sınırı doğru kayıtları döndürür", async () => {
    const opened = await seedLead({ openedDetectedAt: T - 2 * DAY });
    const openedOld = await seedLead({ openedDetectedAt: T - 40 * DAY });
    const fresh = await seedLead({ newDetectedAt: T - DAY });
    const future = await seedLead({ wasFuture: true, firstSeenAt: T - 3 * DAY });
    const futureClosed = await seedLead({ wasFuture: true, isClosed: true });
    const plain = await seedLead();
    const ids = async (qs: string) =>
      (await queryLeadIds(db, parseLeadFilters(new URLSearchParams(qs)), 100)).sort(
        (a, b) => a - b,
      );

    expect(await ids("lifecycle=opened")).toEqual([opened, openedOld]);
    expect(await ids(`lifecycle=opened&detectedSince=${T - 7 * DAY}`)).toEqual([opened]);
    expect(await ids("lifecycle=new")).toEqual([fresh]);
    expect(await ids("lifecycle=future")).toEqual([future]);
    expect(await ids(`lifecycle=future&detectedSince=${T - 7 * DAY}`)).toEqual([future]);
    expect(await ids(`lifecycle=future&detectedSince=${T - DAY}`)).toEqual([]);
    expect(await ids("lifecycle=opened,new")).toEqual([opened, openedOld, fresh]);
    // Tek başına detectedSince: bu tarihten beri "yeni" veya "açıldı" olarak tespit edilenler.
    expect(await ids(`detectedSince=${T - 7 * DAY}`)).toEqual([opened, fresh]);
    expect(await ids("")).toEqual(
      [opened, openedOld, fresh, future, futureClosed, plain].sort((a, b) => a - b),
    );
  });

  it("deep link: GET /api/leads lifecycle süzgecini uygular", async () => {
    await seedLead({ openedDetectedAt: T - DAY });
    await seedMany(3);
    const r = await json(
      await leadsRoute.GET(req("GET", "/api/leads?lifecycle=opened"), undefined),
    );
    expect(r.total).toBe(1);
  });

  it("ids süzgeci json_each ile 2000 kimlikte de çalışır (SQLite değişken sınırına takılmaz)", async () => {
    const ids = await seedMany(5);
    const many = [...ids, ...Array.from({ length: 1995 }, (_, i) => 1_000_000 + i)];
    expect(await countLeadIds(db, { ids: many })).toBe(5);
    expect(await countLeadIds(db, { ids: [] })).toBe(0);
  });

  it("denetim özeti kimlik listesini ve arama metnini yazmaz", () => {
    expect(auditFilterSummary({ ids: [1, 2, 3], q: "ali@firma.com", countries: ["GB"] })).toEqual({
      ids: 3,
      q: true,
      countries: ["GB"],
    });
  });
});

describe("toplu işlemler (runBulk)", () => {
  it("arşivle: listeden, noktalardan, sayılardan ve dışa aktarmadan düşer; geri al geri getirir; idempotent", async () => {
    const ids = await seedMany(5);
    const pick = ids.slice(0, 3);
    const dry = await runBulk(
      db,
      { action: "archive", selection: { leadIds: pick }, dryRun: true },
      { now: T },
    );
    expect(dry).toMatchObject({ matched: 3, changed: 3, dryRun: true, changedIds: [] });
    expect(await archivedOf(pick[0]!)).toBeNull(); // dryRun hiçbir şey yazmaz
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "lead.bulk"))).toHaveLength(
      0,
    );

    const r = await runBulk(db, { action: "archive", selection: { leadIds: pick } }, { now: T });
    expect(r).toMatchObject({ matched: 3, changed: 3, skipped: { unchanged: 0 }, capped: false });
    // "Geri al" yalnızca gerçekten değişen kimlikleri kullanır.
    expect([...r.changedIds].sort((a, b) => a - b)).toEqual([...pick].sort((a, b) => a - b));
    expect(await archivedOf(pick[0]!)).toBe(T);

    expect((await queryLeads(db, {})).total).toBe(2);
    const list = await json(await leadsRoute.GET(req("GET", "/api/leads"), undefined));
    expect(list.total).toBe(2);
    const pts = await json(await pointsRoute.GET(req("GET", "/api/leads/points"), undefined));
    expect(pts.points).toHaveLength(2);
    const facets = await json(await facetsRoute.GET(req("GET", "/api/leads/facets"), undefined));
    expect(facets.total).toBe(2);
    const archivedView = await json(
      await leadsRoute.GET(req("GET", "/api/leads?archived=1"), undefined),
    );
    expect(archivedView.total).toBe(3);
    const csv = await (await exportRoute.GET(req("GET", "/api/export/leads"), undefined)).text();
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1 + 2);

    // Yeniden çalıştırma: değişiklik yok.
    const again = await runBulk(
      db,
      { action: "archive", selection: { leadIds: pick } },
      { now: T + 1 },
    );
    expect(again).toMatchObject({
      matched: 3,
      changed: 0,
      skipped: { unchanged: 3 },
      changedIds: [],
    });
    expect(await archivedOf(pick[0]!)).toBe(T);

    const undo = await runBulk(
      db,
      { action: "unarchive", selection: { leadIds: pick } },
      { now: T + 2 },
    );
    expect(undo.changed).toBe(3);
    expect((await queryLeads(db, {})).total).toBe(5);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "lead.bulk"));
    expect(audits).toHaveLength(3);
    expect(audits[0]!.detail).toMatchObject({
      action: "archive",
      changed: 3,
      selection: { kind: "ids", count: 3 },
    });
  });

  it("etkin kampanya dizisindeki lead arşivlenmez; bitmiş dizideki arşivlenir", async () => {
    const [a, b, c] = await seedMany(3);
    const campaignId = await createCampaign(db);
    const base = { campaignId, addedAt: T, updatedAt: T };
    await db.insert(campaignLeads).values([
      { ...base, leadId: a!, status: "scheduled", recipientEmail: "info@a.example" },
      { ...base, leadId: b!, status: "completed", recipientEmail: "info@b.example" },
    ]);
    const r = await runBulk(
      db,
      { action: "archive", selection: { leadIds: [a!, b!, c!] } },
      { now: T },
    );
    expect(r).toMatchObject({
      matched: 3,
      changed: 2,
      skipped: { activeCampaign: 1, unchanged: 0 },
    });
    expect(await archivedOf(a!)).toBeNull();
    expect(await archivedOf(b!)).toBe(T);
  });

  it("İletişime geçme: işaretler, zaten işaretli olanları 'değişmedi' sayar, bulunamayanı raporlar", async () => {
    const [a, b] = await seedMany(2);
    const locked = await seedLead({ status: "do_not_contact" });
    const r = await runBulk(
      db,
      { action: "do_not_contact", selection: { leadIds: [a!, b!, locked, 999_999] } },
      { now: T },
    );
    expect(r).toMatchObject({ matched: 3, changed: 2, skipped: { unchanged: 1, notFound: 1 } });
    expect(await statusOf(a!)).toBe("do_not_contact");
  });

  it("süzgeçle seçim: 2000'den fazlası eşleşirse capped ve matchedTotal döner", async () => {
    await seedMany(4, { country: "NL" });
    await seedMany(2, { country: "GB" });
    const sel = await resolveSelection(db, { filterQuery: "countries=NL" }, 3);
    expect(sel).toMatchObject({ matchedTotal: 4, capped: true });
    expect(sel.ids).toHaveLength(3);
    const r = await runBulk(
      db,
      { action: "archive", selection: { filterQuery: "countries=NL" } },
      { now: T },
    );
    expect(r).toMatchObject({ matched: 4, changed: 4, capped: false, matchedTotal: 4 });
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, "lead.bulk")))[0]!;
    expect(audit.detail).toMatchObject({
      selection: { kind: "filter", filters: { countries: ["NL"] } },
    });
    // Arşiv görünümünden süzgeçle geri alma
    const undo = await runBulk(
      db,
      { action: "unarchive", selection: { filterQuery: "countries=NL&archived=1" } },
      { now: T },
    );
    expect(undo.changed).toBe(4);
  });
});

describe("POST /api/leads/bulk", () => {
  it("doğrulama: bilinmeyen alan ve eylem 400; boş eşleşme 409 NOTHING_MATCHED", async () => {
    const ids = await seedMany(2);
    const bad = await bulkRoute.POST(
      req("POST", "/api/leads/bulk", { action: "delete", selection: { leadIds: ids } }),
      undefined,
    );
    expect(bad.status).toBe(400);
    const extra = await bulkRoute.POST(
      req("POST", "/api/leads/bulk", { action: "archive", selection: { leadIds: ids }, x: 1 }),
      undefined,
    );
    expect(extra.status).toBe(400);
    const none = await bulkRoute.POST(
      req("POST", "/api/leads/bulk", {
        action: "archive",
        selection: { filterQuery: "countries=ZZ" },
      }),
      undefined,
    );
    expect(none.status).toBe(409);
    expect((await json(none)).code).toBe("NOTHING_MATCHED");
  });

  it("başarılı istek sonucu ve sayıları döndürür", async () => {
    const ids = await seedMany(2);
    const res = await bulkRoute.POST(
      req("POST", "/api/leads/bulk", { action: "archive", selection: { leadIds: ids } }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ action: "archive", matched: 2, changed: 2 });
  });
});

describe("POST /api/export/leads (seçimle dışa aktarma)", () => {
  it("yalnızca seçilen kimlikler gelir; arşivdekiler de seçilmişse dahildir; Google alanları yalnızca google:true ile", async () => {
    const ids = await seedMany(4);
    await runBulk(db, { action: "archive", selection: { leadIds: [ids[0]!] } }, { now: T });
    const res = await exportRoute.POST(
      req("POST", "/api/export/leads", { selection: { leadIds: [ids[0]!, ids[2]!] } }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain("adres");
    const got = lines.slice(1).map((l) => Number(l.split(",")[0]));
    expect(got.sort((a, b) => a - b)).toEqual([ids[0], ids[2]]);

    const google = await exportRoute.POST(
      req("POST", "/api/export/leads", { selection: { filterQuery: "" }, google: true }),
      undefined,
    );
    const gl = (await google.text()).split("\r\n").filter(Boolean);
    expect(gl[0]).toContain("adres");
    expect(gl).toHaveLength(1 + 3); // süzgeçle: arşivlenmiş olan hariç
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, "export.leads")))[0]!;
    expect(audit.detail).toMatchObject({ rows: 2, selection: "ids", filters: { ids: 2 } });
  });

  it("geçersiz gövde 400", async () => {
    const res = await exportRoute.POST(
      req("POST", "/api/export/leads", { selection: { leadIds: [] } }),
      undefined,
    );
    expect(res.status).toBe(400);
  });
});

describe("İletişime geçme kilidi (tekil düzenleme)", () => {
  it("onaysız kilit kaldırma 409 LEAD_UNBLOCK_CONFIRM; onayla kaldırılır ve ayrı denetim kaydı yazılır", async () => {
    const id = await seedLead({ status: "do_not_contact" });
    const ctx = { params: Promise.resolve({ id: String(id) }) };
    const res = await leadRoute.PATCH(req("PATCH", `/api/leads/${id}`, { status: "new" }), ctx);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("LEAD_UNBLOCK_CONFIRM");
    expect(await statusOf(id)).toBe("do_not_contact");

    // Kilitliyken not gibi başka alanlar değiştirilebilir.
    await patchLead(db, id, { notes: "aradı" });
    const ok = await leadRoute.PATCH(
      req("PATCH", `/api/leads/${id}`, { status: "new", confirmUnblock: true }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(ok.status).toBe(200);
    expect(await statusOf(id)).toBe("new");
    const logs = await db.select().from(auditLog).where(eq(auditLog.action, "lead.unblocked"));
    expect(logs).toHaveLength(1);
  });

  it("kilitli olmayan lead için onay gerekmez; aynı duruma (do_not_contact) yazmak serbesttir", async () => {
    const id = await seedLead();
    expect(await patchLead(db, id, { status: "customer" })).toBe(true);
    expect(await statusOf(id)).toBe("customer");
    expect(await patchLead(db, id, { status: "do_not_contact" })).toBe(true);
    expect(await patchLead(db, id, { status: "do_not_contact", notes: "x" })).toBe(true);
    expect(await statusOf(id)).toBe("do_not_contact");
    expect(await patchLead(db, 987_654, { status: "new" })).toBe(false);
  });
});

describe("POST /api/leads/find-emails: eşleşen sayı ve sınır bilgisi", () => {
  async function ready() {
    await setSetting(db, "places.provider", "mock");
    await setSetting(db, "targets.countries", ["GB", "NL"]);
    await setSetting(db, "company.profile", {
      legalName: "Örnek Ambalaj A.Ş.",
      address: "OSB 1. Cad. No:5 Ankara",
      taxId: "1234567890",
      phone: "+90 312 000 00 00",
      contactName: "Ayşe Demir",
    });
    await setSetting(db, "consent", { version: "x", acceptedAt: T, name: "Ayşe Demir" });
    await setSetting(db, "setup.completed", true);
  }

  it("süzgece 2000'den fazlası uyarsa önizleme matched ve capped:true taşır; 8000 karakterlik sorgu kabul edilir", async () => {
    await ready();
    const rows = Array.from({ length: 2003 }, (_, i) => i);
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      await db.insert(places).values(
        part.map((k) => ({
          placeId: `demo:fe-${k}`,
          source: "demo" as const,
          coordsFetchedAt: T,
          firstSeenAt: T,
          createdAt: T,
          updatedAt: T,
        })),
      );
      await db.insert(leads).values(
        part.map((k) => ({
          placeId: `demo:fe-${k}`,
          source: "demo" as const,
          countryCode: "GB",
          createdAt: T,
          updatedAt: T,
        })),
      );
    }
    const res = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { filtersQuery: "countries=GB", dryRun: true }),
      undefined,
    );
    expect(res.status).toBe(200);
    const { preview } = await json(res);
    expect(preview).toMatchObject({ leads: 2000, matched: 2003, capped: true, max: 2000 });

    const ids = await json(
      await findRoute.POST(
        req("POST", "/api/leads/find-emails", { leadIds: [1, 2], dryRun: true }),
        undefined,
      ),
    );
    expect(ids.preview).toMatchObject({ matched: 2, capped: false });

    // Eski 2000 karakter sınırını aşan (boş parametrelerle uzatılmış) geçerli bir sorgu.
    const long = "countries=GB".padEnd(7000, "&");
    const ok = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { filtersQuery: long, dryRun: true }),
      undefined,
    );
    expect(ok.status).toBe(200);
    const tooLong = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { filtersQuery: "a".repeat(8001), dryRun: true }),
      undefined,
    );
    expect(tooLong.status).toBe(400);
  });
});
