import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as leadRoute from "@/app/api/leads/[id]/route";
import * as rdapRoute from "@/app/api/leads/rdap/route";
import * as rdapStatusRoute from "@/app/api/settings/novelty/rdap-status/route";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { categorySets, domainRegistrations, leadEnrichment, leads, scans } from "@/lib/db/schema";
import { FetchError, safeFetch, type FetchFn, type FetchResult } from "@/lib/email/safe-fetch";
import { computeNovelty } from "@/lib/novelty/score";
import {
  bootstrapFresh,
  lookupDomain,
  nextCheckAt,
  parseBootstrap,
  registrableDomain,
  registrationDate,
  type RdapBootstrap,
} from "@/lib/novelty/rdap";
import { demoRdap } from "@/lib/novelty/rdap-demo";
import {
  enqueueRdap,
  placeIdsForDomains,
  rdapStatus,
  runRdapBatch,
  syncDomainQueue,
} from "@/lib/novelty/rdap-job";
import { signalText } from "@/lib/novelty/signal-text";
import { createAndStartScan } from "@/lib/scan/service";
import { loadNoveltyConfig, recomputeNovelty } from "@/lib/scan/novelty-sync";
import { persistPlaces } from "@/lib/scan/store";
import { setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 8);
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

const BOOT: RdapBootstrap = {
  fetchedAt: T0,
  publication: "2026-10-01T00:00:00Z",
  map: { de: "https://rdap.denic.de/", com: "https://rdap.verisign.com/com/v1/" },
};

function fakeFetch(handler: (url: string) => Partial<FetchResult> | Error): FetchFn & {
  urls: string[];
} {
  const urls: string[] = [];
  const fn: FetchFn = async (url) => {
    urls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { url, status: 200, headers: {}, body: "", skippedBody: false, truncated: false, ...r };
  };
  return Object.assign(fn, { urls });
}

/** İki lead: biri genç (firma.de), biri eski (old.com) alan adlı. */
async function seedLeads() {
  const cat = (await db.select().from(categorySets)).find((c) => c.key === "cafe")!;
  const { scanId } = await createAndStartScan(
    db,
    {
      region: {
        kind: "city",
        name: "London",
        countryCode: "GB",
        bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
      },
      categoryIds: [cat.id],
    },
    T0,
  );
  await persistPlaces(
    db,
    scanId,
    ["p1", "p2", "p3"].map((placeId) => ({
      placeId,
      source: "demo" as const,
      name: "x",
      lat: 51.5,
      lng: -0.12,
      types: ["cafe"],
      businessStatus: "OPERATIONAL",
    })),
    T0,
  );
  await db.update(scans).set({ status: "completed" }).where(eq(scans.id, scanId));
  const ls = await db.select().from(leads);
  const byPlace = new Map(ls.map((l) => [l.placeId, l.id]));
  const enr = (leadId: number, siteDomain: string | null) => ({
    leadId,
    status: "done" as const,
    siteDomain,
    updatedAt: T0,
  });
  await db
    .insert(leadEnrichment)
    .values([
      enr(byPlace.get("p1")!, "firma.de"),
      enr(byPlace.get("p2")!, "old.com"),
      enr(byPlace.get("p3")!, null),
    ]);
  return byPlace;
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
  await setSetting(db, "places.provider", "google");
});
afterEach(async () => {
  await t.cleanup();
});

describe("saf RDAP yardımcıları", () => {
  it("kayıtlı alan adı (Public Suffix List)", () => {
    expect(registrableDomain("www.shop.firma.co.uk")).toBe("firma.co.uk");
    expect(registrableDomain("WWW.Firma.DE.")).toBe("firma.de");
    expect(registrableDomain("cafe-12.example")).toBe("cafe-12.example");
    expect(registrableDomain("192.168.1.1")).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });

  it("önyükleme ayrıştırma: yalnızca https; boş/bozuk null", () => {
    const b = parseBootstrap(
      {
        publication: "2026-10-01",
        services: [
          [["de"], ["http://insecure.example/", "https://rdap.denic.de"]],
          [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
          [["xyz"], ["http://only-http.example/"]],
          "bozuk",
        ],
      },
      T0,
    );
    expect(b!.map).toEqual({
      de: "https://rdap.denic.de/",
      com: "https://rdap.verisign.com/com/v1/",
      net: "https://rdap.verisign.com/com/v1/",
    });
    expect(parseBootstrap({ services: [] }, T0)).toBeNull();
    expect(parseBootstrap(null, T0)).toBeNull();
    expect(bootstrapFresh(b, T0 + 29 * DAY)).toBe(true);
    expect(bootstrapFresh(b, T0 + 31 * DAY)).toBe(false);
    expect(bootstrapFresh(null, T0)).toBe(false);
  });

  it("kayıt tarihi olayı ve geri çekilme", () => {
    expect(
      registrationDate({
        events: [
          { eventAction: "last changed", eventDate: "2026-01-01T00:00:00Z" },
          { eventAction: "registration", eventDate: "2026-05-01T00:00:00Z" },
        ],
      }),
    ).toBe(Date.parse("2026-05-01T00:00:00Z"));
    expect(
      registrationDate({ events: [{ eventAction: "registration", eventDate: "x" }] }),
    ).toBeNull();
    expect(registrationDate({})).toBeNull();
    expect(nextCheckAt("ok", 0, T0)).toBe(T0 + 365 * DAY);
    expect(nextCheckAt("error", 1, T0)).toBe(T0 + DAY);
    expect(nextCheckAt("error", 3, T0)).toBe(T0 + 7 * DAY);
    expect(nextCheckAt("rate_limited", 9, T0)).toBe(T0 + 30 * DAY);
  });

  it("tek sorgu: 200/404/429/bozuk JSON/ağ hatası/desteklenmeyen uzantı", async () => {
    const f = fakeFetch((url) => {
      if (url.includes("firma.de"))
        return {
          body: JSON.stringify({
            events: [{ eventAction: "registration", eventDate: "2026-06-01T00:00:00Z" }],
          }),
        };
      if (url.includes("nodate.de")) return { body: JSON.stringify({ events: [] }) };
      if (url.includes("gone.de")) return { status: 404 };
      if (url.includes("busy.de")) return { status: 429 };
      if (url.includes("bad.de")) return { body: "<html>" };
      if (url.includes("down.de")) return new FetchError("timeout", "Zaman aşımı");
      return { status: 500 };
    });
    expect(await lookupDomain("firma.de", BOOT, f)).toEqual({
      status: "ok",
      registeredAt: Date.parse("2026-06-01T00:00:00Z"),
      rdapHost: "rdap.denic.de",
      error: null,
    });
    expect(f.urls[0]).toBe("https://rdap.denic.de/domain/firma.de");
    expect((await lookupDomain("nodate.de", BOOT, f)).status).toBe("no_date");
    expect((await lookupDomain("gone.de", BOOT, f)).status).toBe("not_found");
    expect(await lookupDomain("busy.de", BOOT, f)).toMatchObject({
      status: "rate_limited",
      error: "http_429",
    });
    expect(await lookupDomain("bad.de", BOOT, f)).toMatchObject({
      status: "error",
      error: "bad_json",
    });
    expect(await lookupDomain("down.de", BOOT, f)).toMatchObject({
      status: "error",
      error: "timeout",
    });
    expect(await lookupDomain("err.de", BOOT, f)).toMatchObject({ error: "http_500" });
    expect((await lookupDomain("firma.xyz", BOOT, f)).status).toBe("unsupported_tld");
  });

  it("demo RDAP belirlenimci ve ağsız", () => {
    const a = demoRdap("cafe-1.example", T0);
    expect(a).toEqual(demoRdap("cafe-1.example", T0 + 1000));
    expect(a.status).toBe("ok");
    expect(demoRdap("x.invalid", T0).status).toBe("not_found");
    const young = Array.from({ length: 40 }, (_, i) => demoRdap(`c${i}.example`, T0)).filter(
      (r) => T0 - r.registeredAt! < 183 * DAY,
    );
    expect(young.length).toBeGreaterThan(3);
  });
});

describe("safeFetch bodyTypes", () => {
  it("JSON gövdesi yalnızca istenirse indirilir", async () => {
    const server = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/rdap+json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const base = { userAgent: "t", allowPrivate: true, timeoutMs: 2000 };
      const plain = await safeFetch(url, base);
      expect(plain).toMatchObject({ skippedBody: true, body: "" });
      const rdap = await safeFetch(url, { ...base, bodyTypes: /^application\/(?:rdap\+)?json/i });
      expect(rdap).toMatchObject({ skippedBody: false, body: '{"ok":true}' });
    } finally {
      server.close();
    }
  });
});

describe("yenilik skoru: genç alan adı (+20)", () => {
  const cfg = { highAt: 60, likelyAt: 30, newWindowDays: 60, domainYoungDays: 183 };
  it("pencere içinde +20; dışında veya RDAP kapalıyken yok", () => {
    const young = computeNovelty({ domainRegisteredAt: T0 - 90 * DAY, now: T0 }, cfg);
    expect(young.score).toBe(20);
    expect(young.signals[0]).toMatchObject({ id: "domain_young", group: "domain", points: 20 });
    expect(young.signals[0]!.params).toMatchObject({ months: 3 });
    expect(computeNovelty({ domainRegisteredAt: T0 - 400 * DAY, now: T0 }, cfg).score).toBe(0);
    const { domainYoungDays: _d, ...off } = cfg;
    void _d;
    expect(computeNovelty({ domainRegisteredAt: T0 - 10 * DAY, now: T0 }, off).score).toBe(0);
    // Yaşam döngüsü sinyaliyle toplanır (farklı grup).
    expect(
      computeNovelty({ newDetectedAt: T0, domainRegisteredAt: T0 - 10 * DAY, now: T0 }, cfg).score,
    ).toBe(90);
  });

  it("sinyal metni: parametreliyse arayüz dilinde, eski satırda saklı metin", () => {
    const s = computeNovelty({ domainRegisteredAt: T0 - 60 * DAY, now: T0 }, cfg).signals[0]!;
    expect(signalText(s, "en")).toMatch(/about 2 months ago/);
    expect(signalText(s, "tr")).toMatch(/yaklaşık 2 ay önce/);
    expect(signalText({ ...s, params: undefined, reason: "eski" }, "en")).toBe("eski");
    expect(signalText({ id: "unknown", group: "x", points: 1, reason: "r" }, "en")).toBe("r");
    expect(
      signalText({ id: "reviews_few", group: "reviews", points: 10, reason: "r" }, "en"),
    ).toMatch(/small number of reviews/);
  });
});

describe("RDAP işi", () => {
  it("kuyruk: alan adı başına bir satır; ayar kapalıyken ağ isteği yok", async () => {
    await seedLeads();
    expect(await syncDomainQueue(db, T0)).toBe(2);
    expect(await syncDomainQueue(db, T0)).toBe(0);
    await setSetting(db, "novelty.rdap", { enabled: false });
    const f = fakeFetch(() => ({ status: 500 }));
    expect(await runRdapBatch({ db, fetch: f, now: () => T0 })).toMatchObject({
      skippedReason: "disabled",
      checked: 0,
    });
    expect(f.urls).toHaveLength(0);
  });

  it("gerçek yol: önyükleme alınır ve önbelleğe yazılır; sonuçlar ve sonraki denetim; skor yenilenir", async () => {
    const byPlace = await seedLeads();
    const f = fakeFetch((url) => {
      if (url.includes("iana.org"))
        return {
          body: JSON.stringify({
            publication: "p",
            services: [
              [["de"], ["https://rdap.denic.de/"]],
              [["com"], ["https://rdap.verisign.com/com/v1/"]],
            ],
          }),
        };
      if (url.includes("firma.de"))
        return {
          body: JSON.stringify({
            events: [
              { eventAction: "registration", eventDate: new Date(T0 - 30 * DAY).toISOString() },
            ],
          }),
        };
      return { status: 429 };
    });
    const res = await runRdapBatch({ db, fetch: f, now: () => T0, sleep: async () => undefined });
    expect(res).toMatchObject({ checked: 2, ok: 1, failed: 1, domains: ["firma.de"] });
    const rows = new Map((await db.select().from(domainRegistrations)).map((r) => [r.domain, r]));
    expect(rows.get("firma.de")).toMatchObject({ status: "ok", nextCheckAt: T0 + 365 * DAY });
    expect(rows.get("old.com")).toMatchObject({
      status: "rate_limited",
      attempts: 1,
      nextCheckAt: T0 + DAY,
    });
    // Önyükleme önbellekte: ikinci tur IANA'ya gitmez.
    const before = f.urls.filter((u) => u.includes("iana.org")).length;
    await runRdapBatch({ db, fetch: f, now: () => T0 + 2 * DAY, sleep: async () => undefined });
    expect(f.urls.filter((u) => u.includes("iana.org")).length).toBe(before);

    const ids = await placeIdsForDomains(db, res.domains);
    expect(ids).toEqual(["p1"]);
    await recomputeNovelty(db, await loadNoveltyConfig(db), { placeIds: ids, now: T0 });
    const [l1] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, byPlace.get("p1")!));
    expect(l1!.noveltySignals.some((s) => s.id === "domain_young")).toBe(true);
    // RDAP kapatılınca sinyal düşer.
    await setSetting(db, "novelty.rdap", { enabled: false });
    await recomputeNovelty(db, await loadNoveltyConfig(db), { placeIds: ids, now: T0 });
    const [l1b] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, byPlace.get("p1")!));
    expect(l1b!.noveltySignals.some((s) => s.id === "domain_young")).toBe(false);
  });

  it("önyükleme alınamazsa tur atlanır; demo sağlayıcıda ağ isteği hiç yok", async () => {
    await seedLeads();
    const down = fakeFetch(() => new FetchError("network", "kapalı"));
    expect(
      await runRdapBatch({ db, fetch: down, now: () => T0, log: () => undefined }),
    ).toMatchObject({ skippedReason: "bootstrap_unavailable" });

    await setSetting(db, "places.provider", "mock");
    const never = fakeFetch(() => new Error("ağ olmamalı"));
    const r = await runRdapBatch({ db, fetch: never, now: () => T0 });
    expect(r.checked).toBe(2);
    expect(never.urls).toHaveLength(0);
  });

  it("tekil iş; durum özeti", async () => {
    expect(await enqueueRdap(db, { runAt: T0, now: T0 })).not.toBeNull();
    expect(await enqueueRdap(db, { runAt: T0, now: T0 })).toBeNull();
    await seedLeads();
    await syncDomainQueue(db, T0);
    const s = await rdapStatus(db, T0);
    expect(s).toMatchObject({ enabled: true, demo: false, bootstrap: null, due: 2 });
    expect(s.counts).toEqual({ pending: 2 });
  });
});

describe("HTTP: RDAP uç noktaları ve lead ayrıntısı", () => {
  async function setup() {
    await setSetting(db, "places.provider", "mock");
    await setSetting(db, "targets.countries", ["GB"]);
    await setSetting(db, "company.profile", {
      legalName: "Örnek A.Ş.",
      address: "Ankara",
      taxId: "1234567890",
      phone: "+90 312 000 00 00",
      contactName: "Ayşe Demir",
    });
    await setSetting(db, "consent", { version: "x", acceptedAt: T0, name: "Ayşe Demir" });
    await setSetting(db, "setup.completed", true);
  }

  it("POST /api/leads/rdap: 202; kapalıyken 409; bilinmeyen alan 400", async () => {
    await setup();
    const byPlace = await seedLeads();
    const r = await rdapRoute.POST(
      req("POST", "/api/leads/rdap", { leadIds: [byPlace.get("p1")] }),
      undefined,
    );
    expect(r.status).toBe(202);
    expect(await json(r)).toEqual({ added: 1, queued: true });
    const all = await json(await rdapRoute.POST(req("POST", "/api/leads/rdap"), undefined));
    expect(all).toEqual({ added: 1, queued: false });
    expect((await rdapRoute.POST(req("POST", "/api/leads/rdap", { x: 1 }), undefined)).status).toBe(
      400,
    );
    await setSetting(db, "novelty.rdap", { enabled: false });
    const off = await rdapRoute.POST(req("POST", "/api/leads/rdap"), undefined);
    expect(off.status).toBe(409);
    expect((await json(off)).code).toBe("RDAP_DISABLED");
    const st = await json(
      await rdapStatusRoute.GET(req("GET", "/api/settings/novelty/rdap-status"), undefined),
    );
    expect(st).toMatchObject({ enabled: false, demo: true });
  });

  it("lead ayrıntısı: alan adı yaşı ve kaybolma", async () => {
    await setup();
    const byPlace = await seedLeads();
    await runRdapBatch({ db, now: () => T0 });
    const id = byPlace.get("p1")!;
    const d = await json(
      await leadRoute.GET(req("GET", `/api/leads/${id}`), {
        params: Promise.resolve({ id: String(id) }),
      }),
    );
    expect(d.domainAge).toMatchObject({ domain: "firma.de", status: "ok" });
    expect(d.place.goneAt).toBeNull();
    const id3 = byPlace.get("p3")!;
    const d3 = await json(
      await leadRoute.GET(req("GET", `/api/leads/${id3}`), {
        params: Promise.resolve({ id: String(id3) }),
      }),
    );
    expect(d3.domainAge).toBeNull();
  });
});
