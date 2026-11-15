import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { categorySets } from "@/lib/db/schema";
import { MockPlacesProvider } from "@/lib/places/mock";
import { registryHttp } from "@/lib/registry/service";
import { registryWindow } from "@/lib/registry/types";
import { loadNoveltyConfig } from "@/lib/scan/novelty-sync";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import * as companiesRoute from "@/app/api/registry/companies/route";
import * as runsRoute from "@/app/api/registry/runs/route";
import { completeSetup, drainRegistryJobs, req, seedPlace } from "./fixtures/registry/helpers";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * KABUL (Faz 5 / R): son 30 günde kurulmuş Birleşik Krallık kafeleri listelenir ve en az %30'u Google (demo) yerleriyle
 * eşleşir. Tüm adlar YAPAYDIR; Companies House'a gidilmez (sahte fetch).
 */

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
let t: TestDb;
let db: Db;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  registryHttp.deps = {};
  vi.useRealTimers();
  await t.cleanup();
});

const ADJ = [
  "Alder",
  "Birchwood",
  "Cinder",
  "Dapple",
  "Ember",
  "Fernlight",
  "Gossamer",
  "Hazelnut",
  "Inkwell",
  "Jasper",
];
const NOUN = ["Bean", "Cup"];
/** 20 yapay kafe: `<Sıfat> <İsim>` (ör. "Alder Bean"). */
const NAMES = ADJ.flatMap((a) => NOUN.map((n) => `${a} ${n}`));

function chItems() {
  return NAMES.map((n, i) => ({
    company_number: `9${String(i).padStart(7, "0")}`,
    company_name: `${n.toUpperCase()} CAFE LTD`,
    company_status: "active",
    date_of_creation: `2026-${i < 10 ? "10" : "11"}-${String(i < 10 ? 17 + i : 1 + i - 10).padStart(2, "0")}`,
    sic_codes: ["56102"],
    registered_office_address: {
      address_line_1: `${100 + i} Registry Row`,
      locality: "London",
      postal_code: "EC1A 1ZZ",
    },
  }));
}

describe("kabul: Companies House (sahte) → 20 kafe, 8 eşleşme, sıfır yanlış pozitif", () => {
  it("listeler, pencereyi bugün−30..bugün sorar, %40 eşleşir, tuzaklar eşleşmez", async () => {
    await completeSetup(db, "google");
    await setSecret("google.placesKey", "test-places-key-0001");
    await setSecret("registry.companiesHouseKey", "test-ch-key-0001");
    await setSetting(db, "registry.companiesHouse", {
      enabled: true,
      sicCodes: ["56102"],
      windowDays: 30,
    });
    const urls: URL[] = [];
    registryHttp.deps = {
      sleep: async () => undefined,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        urls.push(u);
        return new Response(JSON.stringify({ hits: 20, items: chItems() }), { status: 200 });
      }) as typeof fetch,
    };

    // Haritadaki (demo) Londra yerleri: 8 kayıtla aynı işletme (Google biçiminde ad).
    const matchedPlaces = new Map<string, string>();
    for (const n of NAMES.slice(0, 8)) {
      const p = await seedPlace(db, { name: `${n} Café`, city: "London" }, NOW);
      matchedPlaces.set(n, p.placeId);
    }
    // Tuzaklar: aynı ad BAŞKA şehirde; benzer ama eşik altı ad Londra'da.
    const otherCity = await seedPlace(db, { name: `${NAMES[8]} Café`, city: "Leeds" }, NOW);
    const nearMiss = await seedPlace(db, { name: "Inkwell Cupboard Kitchen", city: "London" }, NOW);

    const res = await runsRoute.POST(
      req("POST", "/api/registry/runs", { source: "companies_house" }),
      undefined,
    );
    expect(res.status).toBe(202);
    expect(await drainRegistryJobs(db)).toEqual(["registry.fetch", "registry.match"]);

    // Pencere sorgusu: bugün − 30 … bugün (UTC).
    const w = registryWindow(30, NOW);
    expect(w).toEqual({ from: "2026-10-16", to: "2026-11-15" });
    expect(urls[0]!.searchParams.get("incorporated_from")).toBe(w.from);
    expect(urls[0]!.searchParams.get("incorporated_to")).toBe(w.to);

    const all = await (
      await companiesRoute.GET(req("GET", "/api/registry/companies?limit=100"), undefined)
    ).json();
    expect(all.items).toHaveLength(20);
    expect(all.stats).toMatchObject({ total: 20, matched: 8, unmatched: 12, pending: 0 });
    expect(all.stats.matchRate).toBeGreaterThanOrEqual(0.3);
    expect(all.stats.matchRate).toBe(0.4);
    // Kuruluş tarihleri pencerede.
    for (const c of all.items)
      expect(c.incorporatedOn >= w.from && c.incorporatedOn <= w.to).toBe(true);

    const matched = await (
      await companiesRoute.GET(
        req("GET", "/api/registry/companies?match=matched&limit=100"),
        undefined,
      )
    ).json();
    expect(matched.items).toHaveLength(8);
    for (const c of matched.items) {
      const base = NAMES.find((n) => c.name === `${n.toUpperCase()} CAFE LTD`)!;
      expect(c.matchedPlaceId).toBe(matchedPlaces.get(base)); // sıfır yanlış pozitif
      expect(c.matchReason).toBe("name_city");
      expect(c.matchedLeadId).not.toBeNull();
    }
    const usedPlaces = matched.items.map((c: { matchedPlaceId: string }) => c.matchedPlaceId);
    expect(usedPlaces).not.toContain(otherCity.placeId);
    expect(usedPlaces).not.toContain(nearMiss.placeId);

    const open = await (
      await companiesRoute.GET(
        req("GET", "/api/registry/companies?match=unmatched,pending&limit=100"),
        undefined,
      )
    ).json();
    expect(open.items).toHaveLength(12);
    for (const c of open.items) {
      expect(c.matchStatus).toBe("unmatched");
      expect(c.matchReason).toBe("below_threshold");
    }
    // Yanıtlarda Google adı yok (yalnızca sicil adı ve yer kimliği).
    expect(JSON.stringify(all)).not.toContain("Café");
    expect(JSON.stringify(all)).not.toContain("Cupboard");
  });
});

describe("kabul: demo sicil + demo tarama (gerçek tarama yolu) → oran ≥ %30", () => {
  it("Londra kafe taraması önbelleği doldurur; demo sicil çalışması en az %30 eşleşir", async () => {
    await completeSetup(db, "mock");
    const cafe = (await db.select().from(categorySets))
      .filter((c) => c.key === "cafe")
      .map((c) => c.id);
    const { scanId } = await createAndStartScan(
      db,
      {
        region: {
          kind: "city",
          name: "London",
          countryCode: "GB",
          bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
        },
        categoryIds: cafe,
      },
      NOW,
    );
    const outcome = await runScan(
      {
        db,
        provider: new MockPlacesProvider({ getEpoch: () => getSetting(db, "mock.epoch") }),
        getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
        getNoveltyConfig: () => loadNoveltyConfig(db),
        now: () => NOW,
        sleep: async () => undefined,
        minIntervalMs: 0,
        log: () => undefined,
      },
      scanId,
    );
    expect(outcome).toBe("completed");

    const res = await runsRoute.POST(
      req("POST", "/api/registry/runs", {
        source: "companies_house",
        locality: "London",
        codes: ["56102"],
      }),
      undefined,
    );
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run.isDemo).toBe(true);
    await drainRegistryJobs(db);

    const body = await (
      await companiesRoute.GET(req("GET", "/api/registry/companies?limit=100"), undefined)
    ).json();
    expect(body.stats.total).toBeGreaterThanOrEqual(20);
    expect(body.items.every((c: { isDemo: boolean }) => c.isDemo)).toBe(true);
    expect(body.stats.matchRate).toBeGreaterThanOrEqual(0.3);
    const runs = await (await runsRoute.GET(req("GET", "/api/registry/runs"), undefined)).json();
    expect(runs.runs[0]).toMatchObject({ status: "done", isDemo: true });
    expect(runs.runs[0].matchedCount / runs.runs[0].fetchedCount).toBeGreaterThanOrEqual(0.3);
    // Ölçülen oranı rapora yazdırmak için (kabul kanıtı).
    console.info(
      `[kabul] demo eşleşme oranı: ${body.stats.matched}/${body.stats.total} = ${(body.stats.matchRate * 100).toFixed(1)}%`,
    );
  });
});
