import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { middleware } from "@/middleware";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, jobs, leads, scans } from "@/lib/db/schema";
import { recordUsage } from "@/lib/budget";
import { runScan } from "@/lib/scan/runner";
import { MockPlacesProvider } from "@/lib/places/mock";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";
import * as settingsRoute from "@/app/api/settings/route";
import * as secretsRoute from "@/app/api/secrets/route";
import * as consentRoute from "@/app/api/setup/consent/route";
import * as completeRoute from "@/app/api/setup/complete/route";
import * as scansRoute from "@/app/api/scans/route";
import * as estimateRoute from "@/app/api/scans/estimate/route";
import * as controlRoute from "@/app/api/scans/[id]/control/route";
import * as rerunRoute from "@/app/api/scans/[id]/rerun/route";
import * as leadsRoute from "@/app/api/leads/route";
import * as leadRoute from "@/app/api/leads/[id]/route";
import * as enrichRoute from "@/app/api/leads/enrich/route";
import * as exportRoute from "@/app/api/export/leads/route";
import * as devMockRoute from "@/app/api/dev/mock/route";
import * as statusRoute from "@/app/api/status/route";
import * as citiesRoute from "@/app/api/cities/route";
import * as categoriesRoute from "@/app/api/categories/[id]/route";

let t: TestDb;
let db: Db;
const ORIGIN = "http://127.0.0.1:3000";

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

const company = {
  legalName: "Örnek Ambalaj A.Ş.",
  address: "OSB 1. Cad. No:5 Ankara",
  taxId: "1234567890",
  phone: "+90 312 000 00 00",
  contactName: "Ayşe Demir",
};
const londonRegion = {
  kind: "city",
  name: "London",
  countryCode: "GB",
  bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
};

async function completeSetup(provider: "mock" | "google" = "mock") {
  await setSetting(db, "places.provider", provider);
  await setSetting(db, "targets.countries", ["GB", "NL"]);
  await setSetting(db, "company.profile", company);
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

async function cafeIds() {
  return (await db.select().from(categorySets)).filter((c) => c.key === "cafe").map((c) => c.id);
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
});

describe("yerel erişim koruması (middleware)", () => {
  const mk = (method: string, headers: Record<string, string>) =>
    new NextRequest(`${ORIGIN}/api/settings`, { method, headers });

  it("yabancı Host başlığını reddeder (DNS rebinding)", () => {
    expect(middleware(mk("GET", { host: "evil.example.com" })).status).toBe(403);
    expect(middleware(mk("GET", { host: "127.0.0.1:3000" })).status).toBe(200);
    expect(middleware(mk("GET", { host: "localhost:3000" })).status).toBe(200);
    expect(middleware(mk("GET", { host: "[::1]:3000" })).status).toBe(200);
  });

  it("durum değiştiren isteklerde Origin zorunludur ve Host ile aynı olmalıdır (CSRF)", () => {
    const host = "127.0.0.1:3000";
    expect(middleware(mk("POST", { host })).status).toBe(403);
    expect(middleware(mk("POST", { host, origin: "http://evil.example.com" })).status).toBe(403);
    expect(
      middleware(mk("POST", { host, origin: ORIGIN, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(middleware(mk("POST", { host, origin: ORIGIN })).status).toBe(200);
    expect(middleware(mk("DELETE", { host })).status).toBe(403);
    expect(middleware(mk("PUT", { host, origin: ORIGIN })).status).toBe(200);
  });
});

describe("kurulum ve onay", () => {
  it("onay verilmeden kurulum tamamlanamaz ve eksikler listelenir", async () => {
    const res = await completeRoute.POST(req("POST", "/api/setup/complete"), undefined);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.missing).toEqual(
      expect.arrayContaining(["Kullanım onayı", "Gönderen firma bilgileri", "Hedef ülkeler"]),
    );
  });

  it("onay: accept=true zorunlu; sürüm, tarih ve ad denetim kaydına yazılır", async () => {
    const bad = await consentRoute.POST(
      req("POST", "/api/setup/consent", { name: "Ayşe Demir", accept: false }),
      undefined,
    );
    expect(bad.status).toBe(400);
    const ok = await consentRoute.POST(
      req("POST", "/api/setup/consent", { name: "Ayşe Demir", title: "İhracat", accept: true }),
      undefined,
    );
    expect(ok.status).toBe(200);
    const log = (
      await db.select().from(auditLog).where(eq(auditLog.action, "consent.accepted"))
    )[0]!;
    expect(log.detail).toMatchObject({ name: "Ayşe Demir", title: "İhracat" });
    expect((await getSetting(db, "consent"))?.name).toBe("Ayşe Demir");
  });

  it("tüm adımlar tamamlanınca kurulum biter (demo modunda anahtar gerekmez)", async () => {
    await consentRoute.POST(
      req("POST", "/api/setup/consent", { name: "Ayşe Demir", accept: true }),
      undefined,
    );
    await settingsRoute.PUT(
      req("PUT", "/api/settings", {
        "company.profile": company,
        "targets.countries": ["gb"],
        "places.provider": "mock",
      }),
      undefined,
    );
    const res = await completeRoute.POST(req("POST", "/api/setup/complete"), undefined);
    expect(res.status).toBe(200);
    expect(await getSetting(db, "setup.completed")).toBe(true);
    expect(await getSetting(db, "targets.countries")).toEqual(["GB"]);
  });

  it("Google modunda Places anahtarı yoksa kurulum tamamlanamaz", async () => {
    await consentRoute.POST(
      req("POST", "/api/setup/consent", { name: "Ayşe Demir", accept: true }),
      undefined,
    );
    await settingsRoute.PUT(
      req("PUT", "/api/settings", {
        "company.profile": company,
        "targets.countries": ["GB"],
        "places.provider": "google",
      }),
      undefined,
    );
    const res = await completeRoute.POST(req("POST", "/api/setup/complete"), undefined);
    expect(res.status).toBe(400);
    expect((await json(res)).missing).toContain("Google Places API anahtarı");
  });
});

describe("ayarlar", () => {
  it("geçersiz değerleri reddeder", async () => {
    expect(
      (
        await settingsRoute.PUT(
          req("PUT", "/api/settings", { "targets.countries": ["ZZ"] }),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await settingsRoute.PUT(
          req("PUT", "/api/settings", { "targets.countries": ["RU"] }),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await settingsRoute.PUT(
          req("PUT", "/api/settings", {
            "novelty.thresholds": { highAt: 30, likelyAt: 60, newWindowDays: 60 },
          }),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (await settingsRoute.PUT(req("PUT", "/api/settings", { "budget.monthlyUsd": -5 }), undefined))
        .status,
    ).toBe(400);
    expect(
      (
        await settingsRoute.PUT(
          req("PUT", "/api/settings", {
            consent: { name: "kendime onay", version: "x", acceptedAt: 1 },
          }),
          undefined,
        )
      ).status,
    ).toBe(400); // yalnızca onay ucundan
    expect(
      (await settingsRoute.PUT(req("PUT", "/api/settings", { "setup.completed": true }), undefined))
        .status,
    ).toBe(400);
  });

  it("geçerli değerleri kaydeder ve denetim kaydı yazar", async () => {
    const res = await settingsRoute.PUT(
      req("PUT", "/api/settings", {
        "budget.monthlyUsd": 50,
        "novelty.thresholds": { highAt: 70, likelyAt: 40, newWindowDays: 30 },
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(await getSetting(db, "budget.monthlyUsd")).toBe(50);
    expect((await getSetting(db, "novelty.thresholds")).newWindowDays).toBe(30);
    expect((await db.select().from(auditLog)).some((a) => a.action === "settings.updated")).toBe(
      true,
    );
  });

  it("API anahtarı şifreli saklanır, yanıtlarda ve günlüklerde asla düz görünmez", async () => {
    const secret = "AIzaSyDUMMY-KEY-1234567890abcdef";
    const res = await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "google.placesKey", value: secret }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await json(res))).not.toContain(secret);

    const settings = await json(await settingsRoute.GET(req("GET", "/api/settings"), undefined));
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect(settings.secrets.placesKey).toMatchObject({
      set: true,
      source: "store",
      masked: "AIza••••cdef",
    });

    expect(fs.readFileSync(path.join(t.dir, "secrets.json"), "utf8")).not.toContain(secret);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(secret);
    expect(fs.readFileSync(t.path)).not.toContain(Buffer.from(secret));

    expect(
      (
        await secretsRoute.POST(
          req("POST", "/api/secrets", {
            name: "google.placesKey",
            value: "içinde boşluk var 12345",
          }),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await secretsRoute.POST(
          req("POST", "/api/secrets", { name: "bilinmeyen", value: "x".repeat(20) }),
          undefined,
        )
      ).status,
    ).toBe(400);
    const del = await secretsRoute.DELETE(
      req("DELETE", "/api/secrets?name=google.placesKey"),
      undefined,
    );
    expect((await json(del)).status.set).toBe(false);
  });
});

describe("tarama uç noktaları: kapılar", () => {
  const body = async () => ({ region: londonRegion, categoryIds: await cafeIds() });

  it("kurulum/onay olmadan tarama başlatılamaz", async () => {
    const res = await scansRoute.POST(req("POST", "/api/scans", await body()), undefined);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("SETUP_REQUIRED");
    expect(await db.select().from(scans)).toHaveLength(0);
  });

  it("Google modunda Places anahtarı yoksa kurulum tamam sayılmaz ve tarama başlamaz", async () => {
    await completeSetup("google");
    const res = await scansRoute.POST(req("POST", "/api/scans", await body()), undefined);
    expect(res.status).toBe(403);
    expect((await json(res)).error).toContain("Google Places API anahtarı");
    expect(await db.select().from(scans)).toHaveLength(0);
  });

  it("hedef pazarlar dışındaki ülke taranamaz (çizilen alan en yakın şehirden tahmin edilir)", async () => {
    await completeSetup();
    const berlin = {
      kind: "bbox",
      name: "Çizilen alan",
      bbox: { south: 52.49, west: 13.35, north: 52.54, east: 13.45 },
    };
    const res = await scansRoute.POST(
      req("POST", "/api/scans", { region: berlin, categoryIds: await cafeIds() }),
      undefined,
    );
    expect(res.status).toBe(400);
    const b = await json(res);
    expect(b.code).toBe("COUNTRY_NOT_TARGETED");
    expect(b.error).toContain("Almanya");

    const est = await json(
      await estimateRoute.POST(
        req("POST", "/api/scans/estimate", { region: berlin, categoryIds: await cafeIds() }),
        undefined,
      ),
    );
    expect(est.country).toMatchObject({ countryCode: "DE", blocked: true });
  });

  it("başarılı tarama oluşturur, kuyruğa iş ekler ve ülkeyi çıkarır", async () => {
    await completeSetup();
    const res = await scansRoute.POST(req("POST", "/api/scans", await body()), undefined);
    expect(res.status).toBe(201);
    const { scanId, estimate } = await json(res);
    expect(estimate.calls.expected).toBeGreaterThan(0);
    const job = (await db.select().from(jobs))[0]!;
    expect(job).toMatchObject({ type: "scan.run", status: "queued" });
    expect(JSON.stringify(job.payload)).toContain(String(scanId));
    const list = await json(await scansRoute.GET(req("GET", "/api/scans"), undefined));
    expect(list.scans[0]).toMatchObject({ id: scanId, regionName: "London", status: "queued" });
  });

  it("yüksek tahmin kalan bütçeyi aşabiliyorsa onay ister; onayla başlar", async () => {
    await completeSetup();
    await setSetting(db, "budget.monthlyUsd", 0.5);
    await recordUsage(db, "mock", "text_search_pro", 5000); // ücretsiz kota bitti
    const big = {
      region: { ...londonRegion, bbox: { south: 51.4, west: -0.3, north: 51.6, east: 0.05 } },
      categoryIds: await cafeIds(),
    };
    const res = await scansRoute.POST(req("POST", "/api/scans", big), undefined);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("NEEDS_ACK");
    expect(
      (
        await scansRoute.POST(
          req("POST", "/api/scans", { ...big, acknowledgeRisk: true }),
          undefined,
        )
      ).status,
    ).toBe(201);
  });

  it("bütçe tamamen dolmuşsa yeni tarama başlatılamaz", async () => {
    await completeSetup();
    await setSetting(db, "budget.monthlyUsd", 0.05);
    await recordUsage(db, "mock", "text_search_pro", 5003); // 3 ücretli çağrı = 0,096 USD
    const res = await scansRoute.POST(req("POST", "/api/scans", await body()), undefined);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("BUDGET_BLOCKED");
  });

  it("geçersiz gövdeler 400 döner ve iç hata sızdırmaz", async () => {
    await completeSetup();
    for (const bad of [
      {},
      { region: londonRegion },
      {
        region: { ...londonRegion, bbox: { south: 99, west: 0, north: 100, east: 1 } },
        categoryIds: [1],
      },
    ]) {
      const res = await scansRoute.POST(req("POST", "/api/scans", bad), undefined);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await json(res))).not.toMatch(/stack|node_modules|at \w+/i);
    }
    const noRegion = await scansRoute.POST(
      new Request(`${ORIGIN}/api/scans`, {
        method: "POST",
        headers: { Origin: ORIGIN },
        body: "{bozuk",
      }),
      undefined,
    );
    expect(noRegion.status).toBe(400);
  });

  it("duraklat / sürdür / iptal ve yeniden tara", async () => {
    await completeSetup();
    const { scanId } = await json(
      await scansRoute.POST(req("POST", "/api/scans", await body()), undefined),
    );
    const post = (action: string) =>
      controlRoute.POST(req("POST", `/api/scans/${scanId}/control`, { action }), params(scanId));
    expect((await post("pause")).status).toBe(200);
    expect((await db.select().from(scans))[0]!.status).toBe("paused");
    expect((await post("pause")).status).toBe(409); // zaten duraklatılmış
    expect((await post("resume")).status).toBe(200);
    expect((await post("cancel")).status).toBe(200);
    expect((await post("resume")).status).toBe(409);
    expect(
      (
        await controlRoute.POST(
          req("POST", "/api/scans/9999/control", { action: "pause" }),
          params(9999),
        )
      ).status,
    ).toBe(409);
    expect(
      (await controlRoute.POST(req("POST", "/api/scans/1/control", { action: "sil" }), params(1)))
        .status,
    ).toBe(400);

    const again = await rerunRoute.POST(req("POST", `/api/scans/${scanId}/rerun`), params(scanId));
    expect(again.status).toBe(201);
    const [a, b] = await db.select().from(scans);
    expect(b!.scanKey).toBe(a!.scanKey); // aynı anahtar: karşılaştırılabilir
    expect((await rerunRoute.POST(req("POST", "/api/scans/9999/rerun"), params(9999))).status).toBe(
      404,
    );
  });
});

describe("lead uç noktaları ve dışa aktarma", () => {
  async function seed() {
    await completeSetup();
    const { scanId } = await json(
      await scansRoute.POST(
        req("POST", "/api/scans", { region: londonRegion, categoryIds: await cafeIds() }),
        undefined,
      ),
    );
    await runScan(
      {
        db,
        provider: new MockPlacesProvider({ getEpoch: () => 0 }),
        getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
        minIntervalMs: 0,
      },
      scanId,
    );
    return scanId;
  }

  it("listeleme süzgeçleri doğrulanır", async () => {
    await seed();
    const ok = await json(
      await leadsRoute.GET(
        req("GET", "/api/leads?novelty=future_opening&limit=5&sort=name"),
        undefined,
      ),
    );
    expect(ok.rows.length).toBeLessThanOrEqual(5);
    expect(ok.rows.every((r: any) => r.noveltyLabel === "future_opening")).toBe(true);
    expect((await leadsRoute.GET(req("GET", "/api/leads?novelty=sacma"), undefined)).status).toBe(
      400,
    );
    expect((await leadsRoute.GET(req("GET", "/api/leads?bbox=1,2,x,4"), undefined)).status).toBe(
      400,
    );
    expect((await leadsRoute.GET(req("GET", "/api/leads?limit=99999"), undefined)).status).toBe(
      200,
    );
  });

  it("lead ayrıntısı, düzenleme ve hatalı kimlikler", async () => {
    await seed();
    const row = (await json(await leadsRoute.GET(req("GET", "/api/leads?limit=1"), undefined)))
      .rows[0];
    const detail = await json(
      await leadRoute.GET(req("GET", `/api/leads/${row.leadId}`), params(row.leadId)),
    );
    expect(detail.place.placeId).toBe(row.placeId);
    expect(detail.googleDataStale).toBe(false);
    const patched = await json(
      await leadRoute.PATCH(
        req("PATCH", `/api/leads/${row.leadId}`, { status: "replied", tags: ["sıcak"] }),
        params(row.leadId),
      ),
    );
    expect(patched.lead).toMatchObject({ status: "replied", tags: ["sıcak"] });
    expect(
      (
        await leadRoute.PATCH(
          req("PATCH", `/api/leads/${row.leadId}`, { status: "uçtu" }),
          params(row.leadId),
        )
      ).status,
    ).toBe(400);
    expect((await leadRoute.GET(req("GET", "/api/leads/abc"), params("abc"))).status).toBe(400);
    expect((await leadRoute.GET(req("GET", "/api/leads/999999"), params(999999))).status).toBe(404);
  });

  it("Google kaynaklı veriler eskiyse 'bayat' işaretlenir", async () => {
    await seed();
    const row = (await json(await leadsRoute.GET(req("GET", "/api/leads?limit=1"), undefined)))
      .rows[0];
    await setSetting(db, "google.cacheDays", 1);
    const fetchedLongAgo = Date.now() - 3 * 86_400_000;
    const { places } = await import("@/lib/db/schema");
    await db
      .update(places)
      .set({ googleFetchedAt: fetchedLongAgo })
      .where(eq(places.placeId, row.placeId));
    const detail = await json(
      await leadRoute.GET(req("GET", `/api/leads/${row.leadId}`), params(row.leadId)),
    );
    expect(detail.googleDataStale).toBe(true);
  });

  it("CSV: varsayılan Google alanları içermez; google=1 ile içerir; indirme başlıkları doğru", async () => {
    await seed();
    const plain = await exportRoute.GET(
      req("GET", "/api/export/leads?novelty=future_opening"),
      undefined,
    );
    expect(plain.headers.get("content-type")).toContain("text/csv");
    expect(plain.headers.get("content-disposition")).toMatch(
      /attachment; filename="universal-mail-leadler-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const bytes = new Uint8Array(await plain.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM (Excel uyumu); Response.text() BOM'u siler
    const plainText = await plain.text();
    expect(plainText.split("\r\n")[0]!.split(",")).not.toContain("ad");

    const full = await (
      await exportRoute.GET(
        req("GET", "/api/export/leads?novelty=future_opening&google=1"),
        undefined,
      )
    ).text();
    expect(full.split("\r\n")[0]!.split(",")).toContain("ad");
    expect(full.split("\r\n").length).toBe(plainText.split("\r\n").length);
  });

  it("zenginleştirme: önizleme maliyet verir, gerçek istek kuyruğa iş ekler", async () => {
    await seed();
    const ids = (await db.select().from(leads).limit(3)).map((l) => l.id);
    const preview = await json(
      await enrichRoute.POST(
        req("POST", "/api/leads/enrich", { leadIds: ids, dryRun: true }),
        undefined,
      ),
    );
    expect(preview.preview).toMatchObject({
      places: 3,
      estimatedCostUsd: 0,
      sku: "place_details_enterprise",
    });
    expect(await db.select().from(jobs).where(eq(jobs.type, "place.enrich"))).toHaveLength(0);

    const run = await enrichRoute.POST(
      req("POST", "/api/leads/enrich", { leadIds: ids }),
      undefined,
    );
    expect(run.status).toBe(202);
    expect(await db.select().from(jobs).where(eq(jobs.type, "place.enrich"))).toHaveLength(1);
    expect(
      (await enrichRoute.POST(req("POST", "/api/leads/enrich", { leadIds: [] }), undefined)).status,
    ).toBe(400);
    expect(
      (await enrichRoute.POST(req("POST", "/api/leads/enrich", { leadIds: [999999] }), undefined))
        .status,
    ).toBe(400);
  });

  it("zenginleştirme kurulum olmadan çalışmaz", async () => {
    const res = await enrichRoute.POST(
      req("POST", "/api/leads/enrich", { leadIds: [1] }),
      undefined,
    );
    expect(res.status).toBe(403);
  });
});

describe("diğer uç noktalar", () => {
  it("demo araçları yalnızca demo modunda 'zamanı ilerletir'", async () => {
    await setSetting(db, "places.provider", "google");
    expect(
      (await devMockRoute.POST(req("POST", "/api/dev/mock", { action: "advance" }), undefined))
        .status,
    ).toBe(409);
    await setSetting(db, "places.provider", "mock");
    const r = await json(
      await devMockRoute.POST(req("POST", "/api/dev/mock", { action: "advance" }), undefined),
    );
    expect(r.epoch).toBe(1);
    expect(
      (
        await json(
          await devMockRoute.POST(req("POST", "/api/dev/mock", { action: "reset" }), undefined),
        )
      ).epoch,
    ).toBe(0);
  });

  it("durum ucu bütçe ve etkin taramaları özetler", async () => {
    await completeSetup();
    await scansRoute.POST(
      req("POST", "/api/scans", { region: londonRegion, categoryIds: await cafeIds() }),
      undefined,
    );
    const s = await json(await statusRoute.GET(req("GET", "/api/status"), undefined));
    expect(s).toMatchObject({ provider: "mock", setupCompleted: true, pendingJobs: 1 });
    expect(s.budget).toMatchObject({ monthlyUsd: 30, level: "ok" });
    expect(s.scans[0].status).toBe("queued");
  });

  it("şehir araması Türkçe takma adı ve ülke süzgecini destekler", async () => {
    const r = await json(
      await citiesRoute.GET(req("GET", "/api/cities?q=londra&cc=GB&limit=3"), undefined),
    );
    expect(r.cities[0]).toMatchObject({ name: "London", cc: "GB", radiusKm: 25 });
    expect(r.cities[0].bbox.north).toBeGreaterThan(r.cities[0].bbox.south);
    expect(
      (await json(await citiesRoute.GET(req("GET", "/api/cities?q=londra&cc=DE"), undefined)))
        .cities,
    ).toHaveLength(0);
  });

  it("kategori düzenleme: geçersiz tür adı reddedilir", async () => {
    const id = (await cafeIds())[0]!;
    const ok = await categoriesRoute.PATCH(
      req("PATCH", `/api/categories/${id}`, { keywords: ["specialty coffee"], enabled: false }),
      params(id),
    );
    expect(ok.status).toBe(200);
    expect((await json(ok)).category).toMatchObject({
      enabled: false,
      keywords: ["specialty coffee"],
    });
    expect(
      (
        await categoriesRoute.PATCH(
          req("PATCH", `/api/categories/${id}`, { placeTypes: ["Geçersiz Tür!"] }),
          params(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await categoriesRoute.PATCH(
          req("PATCH", `/api/categories/${id}`, { bilinmeyen: 1 }),
          params(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await categoriesRoute.PATCH(
          req("PATCH", "/api/categories/9999", { enabled: true }),
          params(9999),
        )
      ).status,
    ).toBe(404);
  });
});
