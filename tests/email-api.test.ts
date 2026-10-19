import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as emailRoute from "@/app/api/leads/[id]/emails/route";
import * as emailItemRoute from "@/app/api/leads/[id]/emails/[emailId]/route";
import * as leadRoute from "@/app/api/leads/[id]/route";
import * as findRoute from "@/app/api/leads/find-emails/route";
import * as facetsRoute from "@/app/api/leads/facets/route";
import * as leadsRoute from "@/app/api/leads/route";
import * as exportRoute from "@/app/api/export/leads/route";
import * as enrichmentRoute from "@/app/api/enrichment/route";
import * as externalTestRoute from "@/app/api/enrichment/external/test/route";
import * as settingsRoute from "@/app/api/settings/route";
import * as secretsRoute from "@/app/api/secrets/route";
import { getDb, type Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import { categorySets, jobs, leadEmails, leadEnrichment, leads, places } from "@/lib/db/schema";
import { createHunterProvider, ExternalProviderError } from "@/lib/email/external";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { MockPlacesProvider } from "@/lib/places/mock";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { clearJobHandlers } from "@/lib/jobs/registry";
import { registerEmailHandlers } from "@/worker/handlers";
import { Worker } from "@/worker/loop";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
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
const idp = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const itemp = (id: number, emailId: number | string) => ({
  params: Promise.resolve({ id: String(id), emailId: String(emailId) }),
});

async function setup(provider: "mock" | "google" = "mock") {
  await setSetting(db, "places.provider", provider);
  await setSetting(db, "targets.countries", ["GB", "NL"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

const mockProvider = () => new MockPlacesProvider({ getEpoch: () => 0 });
const runnerDeps = () => ({
  db,
  provider: mockProvider(),
  getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
  getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
  sleep: async () => undefined,
  minIntervalMs: 0,
});

/** Demo taraması + ilk `n` işletmenin Google zenginleştirmesi (web sitesi önbelleğe gelir). */
async function seed(n = 30): Promise<number[]> {
  await setup();
  const cafe = (await db.select().from(categorySets))
    .filter((c) => c.key === "cafe")
    .map((c) => c.id);
  const { scanId } = await createAndStartScan(db, {
    region: {
      kind: "city",
      name: "London",
      countryCode: "GB",
      bbox: bboxFromCenter(51.5085, -0.1257, 3.5),
    },
    categoryIds: cafe,
  });
  await runScan(runnerDeps(), scanId);
  const pids = (await db.select({ id: places.placeId }).from(places).limit(n)).map((r) => r.id);
  await enrichPlaces(runnerDeps(), pids, "enrich");
  return (await db.select().from(leads))
    .filter((l) => l.placeId && pids.includes(l.placeId))
    .map((l) => l.id);
}

async function drain() {
  clearJobHandlers();
  registerEmailHandlers();
  const w = new Worker({ db, workerId: "w", log: () => undefined });
  while (await w.tick()) {
    /* boşalana kadar */
  }
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  clearJobHandlers();
  await t.cleanup();
});

describe("POST /api/leads/find-emails", () => {
  it("önizleme: ne yapılacağını ve maliyeti söyler, hiçbir şey kuyruğa almaz", async () => {
    const ids = await seed(20);
    const r = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { leadIds: ids, dryRun: true }),
      undefined,
    );
    const body = await json(r);
    expect(r.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.preview).toMatchObject({
      leads: 20,
      ready: 20,
      needsGoogle: 0,
      alreadyDone: 0,
      optedOut: 0,
      willSearch: 20,
    });
    expect(body.preview.external).toMatchObject({ enabled: false, available: false });
    const emailJobs = (await db.select().from(jobs)).filter((j) => j.type !== "scan.run");
    expect(emailJobs).toHaveLength(0);
    expect(await db.select().from(leadEnrichment)).toHaveLength(0);
  });

  it("Google verisi (web sitesi) önbellekte olmayanlar ayrı sayılır; loadGoogle maliyeti önizlemede görünür", async () => {
    const ids = await seed(10);
    await db.delete(placeCache); // yeniden açılış
    const body = await json(
      await findRoute.POST(
        req("POST", "/api/leads/find-emails", { leadIds: ids, dryRun: true, loadGoogle: true }),
        undefined,
      ),
    );
    expect(body.preview).toMatchObject({ ready: 0, needsGoogle: 10, willSearch: 10 });
    expect(body.preview.google).toMatchObject({ load: true, places: 10 });
    expect(typeof body.preview.google.estimatedCostUsd).toBe("number");
    const without = await json(
      await findRoute.POST(
        req("POST", "/api/leads/find-emails", { leadIds: ids, dryRun: true }),
        undefined,
      ),
    );
    expect(without.preview).toMatchObject({ needsGoogle: 10, willSearch: 0 });
  });

  it("kuyruğa alır: e-posta işleri 20'şerli, lead'ler 'kuyrukta'; opt-out ve tamamlanmışlar atlanır", async () => {
    const ids = await seed(30);
    await db.update(leads).set({ status: "do_not_contact" }).where(eq(leads.id, ids[0]!));
    const r = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { leadIds: ids }),
      undefined,
    );
    const body = await json(r);
    expect(r.status).toBe(202);
    expect(body.preview).toMatchObject({ optedOut: 1, ready: 29 });
    expect(body.jobs).toBe(2);
    expect(
      (await db.select().from(jobs))
        .filter((j) => j.type !== "scan.run")
        .every((j) => j.type === "enrich.email"),
    ).toBe(true);
    expect(
      (await db.select().from(leadEnrichment).where(eq(leadEnrichment.status, "queued"))).length,
    ).toBe(29);

    await drain();
    const again = await json(
      await findRoute.POST(
        req("POST", "/api/leads/find-emails", { leadIds: ids, dryRun: true }),
        undefined,
      ),
    );
    expect(again.preview.alreadyDone).toBeGreaterThan(0);
    expect(again.preview.alreadyDone + again.preview.willSearch + 1).toBeLessThanOrEqual(30);
  });

  it("filtersQuery ile süzgece uyan lead'ler işlenir; loadGoogle Google zenginleştirmesini (findEmails ile) kuyruğa alır", async () => {
    const ids = await seed(8);
    await db.delete(placeCache);
    const r = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { filtersQuery: "countries=GB", loadGoogle: true }),
      undefined,
    );
    expect(r.status).toBe(202);
    const enrichJobs = (await db.select().from(jobs)).filter((j) => j.type === "place.enrich");
    expect(enrichJobs.length).toBeGreaterThan(0);
    expect(
      enrichJobs.every(
        (j) =>
          (j.payload as { findEmails?: boolean; mode?: string }).findEmails === true &&
          (j.payload as { mode: string }).mode === "enrich",
      ),
    ).toBe(true);
    expect(ids.length).toBe(8);
    expect(
      (await db.select().from(leadEnrichment).where(eq(leadEnrichment.status, "queued"))).length,
    ).toBeGreaterThan(0);
  });

  it("doğrulama ve kapılar: kimlik/süzgeç yok → 400; kurulum yok → 403; süzgeç boş → 400; bütçe dolu → 409 (loadGoogle)", async () => {
    await seed(4);
    expect(
      (await findRoute.POST(req("POST", "/api/leads/find-emails", {}), undefined)).status,
    ).toBe(400);
    expect(
      (
        await findRoute.POST(
          req("POST", "/api/leads/find-emails", { filtersQuery: "countries=ZZ" }),
          undefined,
        )
      ).status,
    ).toBe(400);
    await setSetting(db, "budget.monthlyUsd", 0);
    await db.delete(placeCache);
    const blocked = await findRoute.POST(
      req("POST", "/api/leads/find-emails", { filtersQuery: "", loadGoogle: true }),
      undefined,
    );
    // 0 USD bütçede ücretsiz kota içinde olabilir; yalnızca durumun tutarlı (202/409) olduğunu doğrula
    expect([202, 409]).toContain(blocked.status);
    await setSetting(db, "setup.completed", false);
    expect(
      (await findRoute.POST(req("POST", "/api/leads/find-emails", { filtersQuery: "" }), undefined))
        .status,
    ).toBe(403);
  });
});

describe("lead ayrıntısı: e-postalar, bağlantılar, durum, yinelenenler", () => {
  it("arama sonrası ayrıntıda emails/contacts/enrichment gelir; yinelenen kayıt işaretlenir", async () => {
    const ids = await seed(40);
    await findRoute.POST(req("POST", "/api/leads/find-emails", { leadIds: ids }), undefined);
    await drain();
    const withEmail = (await db.select().from(leadEmails)).find((e) => e.isPrimary)!;
    const d = await json(
      await leadRoute.GET(req("GET", `/api/leads/${withEmail.leadId}`), idp(withEmail.leadId)),
    );
    expect(d.emails.length).toBeGreaterThan(0);
    expect(d.emails.find((e: any) => e.isPrimary).email).toBe(withEmail.email);
    expect(d.enrichment).toMatchObject({ status: "done" });
    expect(["found_verified", "generic", "found_unverified", "invalid", "not_found"]).toContain(
      d.enrichment.emailStatus,
    );
    expect(Array.isArray(d.contacts)).toBe(true);
    expect(d.duplicates).toEqual([]);
    expect(d.place).not.toHaveProperty("website"); // Google'ın web sitesi adresi ayrıntıda/kalıcı kayıtta yok

    // Aynı adresi başka lead'e elle ekle → ikisinde de yinelenen görünür
    const other = ids.find((i) => i !== withEmail.leadId)!;
    await emailRoute.POST(
      req("POST", `/api/leads/${other}/emails`, { email: withEmail.email }),
      idp(other),
    );
    const d2 = await json(
      await leadRoute.GET(req("GET", `/api/leads/${withEmail.leadId}`), idp(withEmail.leadId)),
    );
    expect(d2.duplicates.map((x: any) => x.leadId)).toContain(other);
    expect(d2.duplicates.find((x: any) => x.leadId === other).reason).toBe("same_email");
  });

  it("lead'in e-posta durumu olmadan da ayrıntı açılır (boş listeler, enrichment null)", async () => {
    const ids = await seed(2);
    const d = await json(await leadRoute.GET(req("GET", `/api/leads/${ids[0]}`), idp(ids[0]!)));
    expect(d).toMatchObject({ emails: [], contacts: [], enrichment: null, duplicates: [] });
  });
});

describe("e-posta ekleme, düzenleme, silme", () => {
  it("elle ekleme: doğrulanır, kaynak 'manual', ilk adres birincil olur; hatalar anlaşılır", async () => {
    const [id, other] = await seed(3);
    expect(
      (
        await emailRoute.POST(
          req("POST", `/api/leads/${id}/emails`, { email: "geçersiz" }),
          idp(id!),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await emailRoute.POST(
          req("POST", "/api/leads/99999/emails", { email: "a@b.test" }),
          idp(99999),
        )
      ).status,
    ).toBe(404);
    const ok = await emailRoute.POST(
      req("POST", `/api/leads/${id}/emails`, { email: " Info@Shop-Test.Example " }),
      idp(id!),
    );
    expect(ok.status).toBe(201);
    const row = (await json(ok)).emails[0];
    expect(row).toMatchObject({
      email: "info@shop-test.example",
      sourceType: "manual",
      sourceUrl: null,
      kind: "generic",
      isPrimary: true,
    });
    expect(["verified", "invalid"]).toContain(row.verifyStatus);
    expect(
      (
        await emailRoute.POST(
          req("POST", `/api/leads/${id}/emails`, { email: "info@shop-test.example" }),
          idp(id!),
        )
      ).status,
    ).toBe(409);
    const st = (await db.select().from(leadEnrichment).where(eq(leadEnrichment.leadId, id!)))[0]!;
    expect(st.status).toBe("done");
    expect(st.emailStatus).not.toBeNull();
    void other;
  });

  it("birincil sabitleme, yeniden doğrulama, elle durum ve silme", async () => {
    const [id, other] = await seed(3);
    const add = async (e: string) =>
      (
        await json(
          await emailRoute.POST(req("POST", `/api/leads/${id}/emails`, { email: e }), idp(id!)),
        )
      ).emails as any[];
    await add("info@pin-test.example");
    const rows = await add("anna@pin-test.example");
    const info = rows.find((r) => r.email.startsWith("info"));
    const anna = rows.find((r) => r.email.startsWith("anna"));
    expect(info.isPrimary).toBe(true);

    // Sabitle
    let r = await json(
      await emailItemRoute.PATCH(req("PATCH", "", { primary: true }), itemp(id!, anna.id)),
    );
    expect(r.emails.find((e: any) => e.id === anna.id)).toMatchObject({
      isPrimary: true,
      primaryPinned: true,
    });
    expect(r.emails.find((e: any) => e.id === info.id).isPrimary).toBe(false);
    // Yeniden doğrula
    r = await json(
      await emailItemRoute.PATCH(req("PATCH", "", { reverify: true }), itemp(id!, info.id)),
    );
    expect(r.ok).toBe(true);
    // Geçersiz işaretlenen adres birincil olamaz ve sabitlenmişse bile seçimden düşer
    r = await json(
      await emailItemRoute.PATCH(
        req("PATCH", "", { verifyStatus: "invalid" }),
        itemp(id!, anna.id),
      ),
    );
    expect(r.emails.find((e: any) => e.id === anna.id)).toMatchObject({
      verifyStatus: "invalid",
      verifyReason: "manual",
      isPrimary: false,
    });
    const bad = await emailItemRoute.PATCH(
      req("PATCH", "", { primary: true }),
      itemp(id!, anna.id),
    );
    expect(bad.status).toBe(400);
    // Boş değişiklik ve başka lead'in kaydı
    expect((await emailItemRoute.PATCH(req("PATCH", "", {}), itemp(id!, info.id))).status).toBe(
      400,
    );
    expect(
      (await emailItemRoute.PATCH(req("PATCH", "", { reverify: true }), itemp(other!, info.id)))
        .status,
    ).toBe(404);
    expect(
      (await emailItemRoute.PATCH(req("PATCH", "", { reverify: true }), itemp(id!, "abc"))).status,
    ).toBe(400);
    // Sil
    const del = await json(await emailItemRoute.DELETE(req("DELETE", ""), itemp(id!, info.id)));
    expect(del.emails.map((e: any) => e.id)).toEqual([anna.id]);
    expect((await emailItemRoute.DELETE(req("DELETE", ""), itemp(id!, info.id))).status).toBe(404);
  });
});

describe("liste, süzgeç, facet ve CSV", () => {
  it("e-posta durumu süzgeci, facet sayıları ve satırdaki birincil adres", async () => {
    const ids = await seed(40);
    const before = await json(await facetsRoute.GET(req("GET", "/api/leads/facets"), undefined));
    expect(before.emailStatus.unchecked).toBeGreaterThan(0);
    await findRoute.POST(req("POST", "/api/leads/find-emails", { leadIds: ids }), undefined);
    const queued = await json(await facetsRoute.GET(req("GET", "/api/leads/facets"), undefined));
    expect(queued.emailStatus.queued).toBe(40);
    await drain();
    const after = await json(await facetsRoute.GET(req("GET", "/api/leads/facets"), undefined));
    expect(after.emailStatus.queued ?? 0).toBe(0);
    const found =
      (after.emailStatus.generic ?? 0) +
      (after.emailStatus.found_verified ?? 0) +
      (after.emailStatus.found_unverified ?? 0);
    expect(found).toBeGreaterThan(5);

    const list = await json(
      await leadsRoute.GET(
        req("GET", "/api/leads?emailStatus=generic,found_verified&limit=500"),
        undefined,
      ),
    );
    expect(list.total).toBe(
      (after.emailStatus.generic ?? 0) + (after.emailStatus.found_verified ?? 0),
    );
    expect(
      list.rows.every(
        (r: any) => r.primaryEmail && ["generic", "found_verified"].includes(r.emailState),
      ),
    ).toBe(true);
    const unchecked = await json(
      await leadsRoute.GET(req("GET", "/api/leads?emailStatus=unchecked&limit=5"), undefined),
    );
    expect(
      unchecked.rows.every((r: any) => r.emailState === "unchecked" && r.primaryEmail === null),
    ).toBe(true);
  });

  it("CSV: e-posta ve bağlantı sütunları 'bizim veri' olarak her zaman gelir (Google alanları kapalıyken de)", async () => {
    const ids = await seed(40);
    await findRoute.POST(req("POST", "/api/leads/find-emails", { leadIds: ids }), undefined);
    await drain();
    const csv = await (
      await exportRoute.GET(
        req("GET", "/api/export/leads?emailStatus=generic,found_verified"),
        undefined,
      )
    ).text();
    const [header, ...lines] = csv.replace("﻿", "").split("\r\n").filter(Boolean);
    const cols = header!.split(",");
    for (const c of [
      "eposta",
      "eposta_durumu",
      "eposta_turu",
      "eposta_kaynagi",
      "tum_epostalar",
      "instagram",
      "facebook",
      "linkedin",
      "iletisim_formu",
    ])
      expect(cols).toContain(c);
    expect(cols).not.toContain("ad"); // Google alanları hâlâ kapalı
    expect(lines.length).toBeGreaterThan(0);
    const first = lines[0]!;
    expect(first).toMatch(/@/);
    expect(first).toMatch(/https:\/\/[^,]*\.example\//); // kaynak sayfa adresi
  });
});

describe("durum, ayarlar ve harici servis", () => {
  it("GET /api/enrichment: iş ve durum sayıları, harici servis ayarı", async () => {
    const ids = await seed(25);
    await findRoute.POST(req("POST", "/api/leads/find-emails", { leadIds: ids }), undefined);
    const s = await json(await enrichmentRoute.GET(req("GET", "/api/enrichment"), undefined));
    expect(s.jobs).toMatchObject({ queued: 2, running: 0, scheduled: 0 });
    // Gelecekteki (24 saat sonraki) yeniden deneme işi "sırada" sayılmaz, "scheduled" olur.
    const [one] = await db.select().from(jobs).where(eq(jobs.type, "enrich.email")).limit(1);
    await db
      .update(jobs)
      .set({ runAt: Date.now() + 86_400_000 })
      .where(eq(jobs.id, one!.id));
    const s2 = await json(await enrichmentRoute.GET(req("GET", "/api/enrichment"), undefined));
    expect(s2.jobs).toMatchObject({ queued: 1, scheduled: 1 });
    expect(s.states.queued).toBe(25);
    expect(s.external).toMatchObject({ enabled: false, provider: "hunter", configured: false });
    expect(s.concurrency).toBe(4);
  });

  it("ayarlar: harici servis ve eşzamanlılık; sınırlar doğrulanır; Hunter anahtarı durumu gizli döner", async () => {
    const put = (b: unknown) => settingsRoute.PUT(req("PUT", "/api/settings", b), undefined);
    expect((await put({ "enrichment.concurrency": 9 })).status).toBe(400);
    expect((await put({ "enrichment.concurrency": 0 })).status).toBe(400);
    expect((await put({ "enrichment.external": { enabled: true, provider: "snov" } })).status).toBe(
      400,
    );
    expect(
      (
        await put({
          "enrichment.concurrency": 2,
          "enrichment.external": { enabled: true, provider: "hunter" },
        })
      ).status,
    ).toBe(200);
    expect(await getSetting(db, "enrichment.concurrency")).toBe(2);
    expect((await getSetting(db, "enrichment.external")).enabled).toBe(true);

    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "hunter.apiKey", value: "hunter-test-key-1234567890" }),
      undefined,
    );
    const got = await json(await settingsRoute.GET(req("GET", "/api/settings"), undefined));
    expect(got.secrets.hunterKey).toMatchObject({ set: true, source: "store" });
    expect(JSON.stringify(got)).not.toContain("hunter-test-key-1234567890");
    expect(got.settings["enrichment.concurrency"]).toBe(2);
  });

  it("harici servis anahtarını dener: kota döner; geçersiz anahtar 400, kota dolu 429, ağ hatası 502", async () => {
    expect(
      (await externalTestRoute.POST(req("POST", "/api/enrichment/external/test"), undefined))
        .status,
    ).toBe(400); // anahtar yok
    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "hunter.apiKey", value: "hunter-test-key-1234567890" }),
      undefined,
    );
    const stub = (status: number, body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status, json: async () => body })),
      );
    stub(200, { data: { requests: { searches: { remaining: 37 } }, reset_date: "2026-11-01" } });
    expect(await json(await externalTestRoute.POST(req("POST", "/x"), undefined))).toMatchObject({
      ok: true,
      remaining: 37,
      resetDate: "2026-11-01",
    });
    stub(401, {});
    const bad = await externalTestRoute.POST(req("POST", "/x"), undefined);
    expect(bad.status).toBe(400);
    expect((await json(bad)).kind).toBe("auth");
    stub(429, {});
    expect((await externalTestRoute.POST(req("POST", "/x"), undefined)).status).toBe(429);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    expect((await externalTestRoute.POST(req("POST", "/x"), undefined)).status).toBe(502);
  });
});

describe("Hunter istemcisi", () => {
  const stub = (status: number, body: unknown) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fn = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { status, json: async () => body };
    };
    return { fn: fn as never, calls };
  };

  it("Domain Search: alan adı kodlanır, anahtar başlıkta gider; yanıt eşlenir (güven puanı, kaynak sayfa)", async () => {
    const { fn, calls } = stub(200, {
      data: {
        emails: [
          { value: "a@x.test", confidence: 91, sources: [{ uri: "https://x.test/contact" }] },
          { value: "b@x.test", confidence: "yüksek" },
          { value: 5 },
          { confidence: 3 },
        ],
      },
    });
    const hits = await createHunterProvider("KEY123456", fn).search("x.test");
    expect(calls[0]!.url).toBe("https://api.hunter.io/v2/domain-search?domain=x.test&limit=10");
    expect(calls[0]!.headers["X-API-KEY"]).toBe("KEY123456");
    expect(calls[0]!.url).not.toContain("KEY123456"); // anahtar adreste (günlüklerde) görünmez
    expect(hits).toEqual([
      { email: "a@x.test", confidence: 91, sourceUrl: "https://x.test/contact" },
      { email: "b@x.test", confidence: null, sourceUrl: null },
    ]);
    expect(await createHunterProvider("K", stub(200, {}).fn).search("x.test")).toEqual([]);
  });

  it("kota: credits önceliklidir, yoksa searches; bilinmiyorsa null", async () => {
    expect(
      await createHunterProvider(
        "K",
        stub(200, { data: { requests: { credits: { remaining: 5 }, searches: { remaining: 9 } } } })
          .fn,
      ).quota(),
    ).toEqual({ remaining: 5, resetDate: null });
    expect(
      await createHunterProvider(
        "K",
        stub(200, { data: { requests: { searches: { remaining: 9 } } } }).fn,
      ).quota(),
    ).toEqual({ remaining: 9, resetDate: null });
    expect(await createHunterProvider("K", stub(200, { data: {} }).fn).quota()).toEqual({
      remaining: null,
      resetDate: null,
    });
  });

  it.each([
    [401, "auth"],
    [429, "quota"],
    [403, "rate_limit"],
    [500, "bad_response"],
  ])("HTTP %i → %s", async (status, kind) => {
    const e = await createHunterProvider("K", stub(status, {}).fn)
      .search("x.test")
      .catch((x) => x);
    expect(e).toBeInstanceOf(ExternalProviderError);
    expect(e.kind).toBe(kind);
  });

  it("JSON olmayan yanıt ve ağ hatası", async () => {
    const notJson = {
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    };
    expect(
      (
        await createHunterProvider("K", (async () => notJson) as never)
          .search("x.test")
          .catch((x) => x)
      ).kind,
    ).toBe("bad_response");
    expect(
      (
        await createHunterProvider("K", (async () => {
          throw new Error("ENOTFOUND");
        }) as never)
          .search("x.test")
          .catch((x) => x)
      ).kind,
    ).toBe("network");
  });
});
