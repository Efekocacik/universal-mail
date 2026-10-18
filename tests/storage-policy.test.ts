import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheDbPathFor } from "@/lib/config/paths";
import { wipeSessionCacheFiles } from "@/lib/config/session-cache";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import { categorySets, leads, places } from "@/lib/db/schema";
import { exportLeadsCsv } from "@/lib/export/csv";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { patchLead } from "@/lib/leads/mutations";
import { queryFacets, queryLeads, queryPoints, queryUncachedPlaceIds } from "@/lib/leads/query";
import {
  clearGoogleData,
  getCacheMap,
  MAX_GOOGLE_RETENTION_DAYS,
  purgeExpiredGoogleData,
} from "@/lib/places/cache";
import { MockPlacesProvider } from "@/lib/places/mock";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { budgetStatus } from "@/lib/budget";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Google Maps Platform şartları Places içeriğinin (ad, adres, telefon, web sitesi...) saklanmasını yasaklar; yalnızca
 * yer kimliği süresiz, enlem/boylam en çok 30 gün tutulabilir. Bu testler saklama kuralının İHLAL EDİLMEDİĞİNİ, ham
 * dosya baytları düzeyinde kanıtlar.
 */
let t: TestDb;
let db: Db;
const londonBox = bboxFromCenter(51.5085, -0.1257, 3.5);
const DAY = 86_400_000;

function deps() {
  return {
    db,
    provider: new MockPlacesProvider({ getEpoch: () => 0 }),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    sleep: async () => undefined,
    minIntervalMs: 0,
  };
}

async function scan(keys = ["cafe", "pub"]) {
  const ids = (await db.select().from(categorySets)).filter((r) => keys.includes(r.key));
  const { scanId } = await createAndStartScan(db, {
    region: { kind: "city", name: "London", countryCode: "GB", bbox: londonBox },
    categoryIds: ids.map((r) => r.id),
  });
  await runScan(deps(), scanId);
  return scanId;
}

/** Ham dosya baytlarını (WAL dahil) okur; arama dizgesi ana dosyada görünüyor mu? */
async function rawBytes(file: string, schemaName: "main" | "gcache"): Promise<Buffer> {
  await db.run(sql.raw(`PRAGMA ${schemaName}.wal_checkpoint(TRUNCATE)`));
  const parts = [file, `${file}-wal`].filter((f) => fs.existsSync(f));
  return Buffer.concat(parts.map((f) => fs.readFileSync(f)));
}

/** Tırnaklı hücreleri (virgül içerenler) doğru ayıran küçük CSV satır çözücü. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
});
afterEach(async () => {
  await t.cleanup();
});

describe("Google verisi saklama kuralı", () => {
  it("ana veritabanı dosyasında Google içeriği (ad, adres, web sitesi, telefon) bulunmaz; yalnızca önbellek dosyasında vardır", async () => {
    await scan();
    const ids = (await db.select({ id: places.placeId }).from(places).limit(5)).map((r) => r.id);
    await enrichPlaces(deps(), ids, "enrich");

    const cached = [...(await getCacheMap(db, ids)).values()];
    expect(cached).toHaveLength(5);
    const secrets = cached.flatMap((c) =>
      [c.name, c.formattedAddress, c.website, c.phone, c.intlPhone].filter(
        (v): v is string => typeof v === "string" && v.length > 6,
      ),
    );
    expect(secrets.length).toBeGreaterThan(10);

    const main = await rawBytes(t.path, "main");
    const cacheFile = cacheDbPathFor(t.path);
    const cache = await rawBytes(cacheFile, "gcache");
    expect(path.dirname(cacheFile)).toBe(path.dirname(t.path));
    expect(cacheFile).not.toBe(t.path);
    for (const value of secrets) {
      expect(main.includes(Buffer.from(value)), `ana veritabanında bulunmamalı: ${value}`).toBe(
        false,
      );
      expect(cache.includes(Buffer.from(value)), `önbellekte olmalı: ${value}`).toBe(true);
    }
  });

  it("kalıcı tablolarda Google içeriği sütunu yoktur", async () => {
    const forbidden = [
      "name",
      "formatted_address",
      "website",
      "phone",
      "intl_phone",
      "user_rating_count",
      "google_maps_uri",
      "opening_date",
      "business_status",
      "primary_type",
      "types",
    ];
    for (const table of ["places", "leads", "place_snapshots", "scan_units"]) {
      const cols = (await db.all(sql.raw(`PRAGMA main.table_info(${table})`))) as {
        name: string;
      }[];
      expect(cols.length).toBeGreaterThan(0);
      for (const f of forbidden)
        expect(
          cols.map((c) => c.name),
          `${table}.${f}`,
        ).not.toContain(f);
    }
    // Önbellek tablosu yalnızca ekli (geçici) dosyadadır.
    const main = (await db.all(sql`SELECT name FROM main.sqlite_master WHERE type='table'`)) as {
      name: string;
    }[];
    expect(main.map((r) => r.name)).not.toContain("place_cache");
  });

  it("yenilik gerekçeleri ve denetim kayıtları Google içeriği taşımaz", async () => {
    await scan();
    const ids = (await db.select({ id: places.placeId }).from(places).limit(30)).map((r) => r.id);
    await enrichPlaces(deps(), ids, "enrich");
    const names = [...(await getCacheMap(db, ids)).values()].map((c) => c.name);
    const reasons = (await db.select().from(leads))
      .flatMap((l) => l.noveltySignals.map((s) => s.reason))
      .join("\n");
    for (const n of names) expect(reasons).not.toContain(n);
    expect(reasons).not.toMatch(/\b20\d\d-\d\d-\d\d\b/); // Google'ın açılış tarihi yazılmaz
  });

  it("konum 30 günü aşınca silinir; ayar 30'un üstüne çıkarılsa bile sınır korunur; yer kimliği ve kendi alanlarımız kalır", async () => {
    await scan(["cafe"]);
    const all = await db.select().from(places);
    const old = all.slice(0, 5).map((p) => p.placeId);
    const now = Date.now();
    for (const id of old)
      await db
        .update(places)
        .set({ coordsFetchedAt: now - 31 * DAY })
        .where(eq(places.placeId, id));
    await db.update(leads).set({ notes: "önemli not" }).where(eq(leads.placeId, old[0]!));

    // Retention 365 verilse bile 30 günle sınırlanır.
    const res = await purgeExpiredGoogleData(db, 365, now);
    expect(res.coordinates).toBe(5);
    expect(MAX_GOOGLE_RETENTION_DAYS).toBe(30);
    const after = await db.select().from(places);
    expect(after).toHaveLength(all.length);
    expect(
      after
        .filter((p) => p.lat === null)
        .map((p) => p.placeId)
        .sort(),
    ).toEqual([...old].sort());
    expect(after.filter((p) => p.lat !== null).every((p) => p.lng !== null)).toBe(true);
    const note = (await db.select().from(leads).where(eq(leads.placeId, old[0]!)))[0]!;
    expect(note.notes).toBe("önemli not");
  });

  it("süresi dolan önbellek satırları silinir; 'Google verilerini sil' her şeyi temizler ama lead'leri korur", async () => {
    await scan(["cafe"]);
    const before = await db.select().from(placeCache);
    expect(before.length).toBeGreaterThan(10);
    const stale = before.slice(0, 4).map((c) => c.placeId);
    for (const id of stale)
      await db
        .update(placeCache)
        .set({ fetchedAt: Date.now() - 40 * DAY })
        .where(eq(placeCache.placeId, id));
    expect((await purgeExpiredGoogleData(db, 30)).cacheRows).toBe(4);
    expect(await db.select().from(placeCache)).toHaveLength(before.length - 4);

    const leadCount = (await db.select().from(leads)).length;
    const cleared = await clearGoogleData(db);
    expect(cleared.cacheRows).toBe(before.length - 4);
    expect(await db.select().from(placeCache)).toHaveLength(0);
    expect((await db.select().from(places)).every((p) => p.lat === null && p.lng === null)).toBe(
      true,
    );
    expect(await db.select().from(leads)).toHaveLength(leadCount);
  });

  it("oturum önbelleği dosyaları açılışta/kapanışta silinir", () => {
    const file = cacheDbPathFor(t.path);
    for (const s of ["", "-wal", "-shm"]) fs.writeFileSync(file + s, "x");
    expect(wipeSessionCacheFiles(file)).toBe(3);
    expect(fs.existsSync(file)).toBe(false);
    expect(wipeSessionCacheFiles(file)).toBe(0); // zaten yoksa sorun çıkmaz
  });
});

describe("önbellek boşken (uygulama yeniden açıldı) çalışma", () => {
  async function reopened() {
    await scan();
    await db.delete(placeCache); // yeniden açılış: önbellek dosyası silindi
  }

  it("liste: adsız satırlar, kalıcı süzgeçler çalışır, durum bayraklardan türetilir", async () => {
    await scan();
    const full = await queryLeads(db, {}, { limit: 500 });
    await db.delete(placeCache);
    const empty = await queryLeads(db, {}, { limit: 500 });
    expect(empty.total).toBe(full.total);
    expect(
      empty.rows.every((r) => r.name === null && r.cached === false && r.address === null),
    ).toBe(true);
    expect(empty.rows.every((r) => r.countryCode === "GB" && r.categoryKey !== null)).toBe(true);

    const future = empty.rows.filter((r) => r.noveltyLabel === "future_opening");
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((r) => r.businessStatus === "FUTURE_OPENING")).toBe(true);
    expect(
      (await queryLeads(db, { businessStatus: ["FUTURE_OPENING"] }, { limit: 500 })).total,
    ).toBe(future.length);
    expect((await queryLeads(db, { categories: ["pub"] })).total).toBeGreaterThan(0);
    expect((await queryLeads(db, { countries: ["DE"] })).total).toBe(0);
    // Ada göre sıralama adsız kayıtları sona atar ve hata vermez
    expect((await queryLeads(db, {}, { sort: "name", limit: 5 })).rows).toHaveLength(5);
  });

  it("görünen ad (kendi kaydımız) adı olmayan satırlarda gösterilir ve aranabilir", async () => {
    await reopened();
    const first = (await queryLeads(db, {}, { limit: 1 })).rows[0]!;
    expect(await patchLead(db, first.leadId, { displayName: "  Kafe Örnek  " })).toBe(true);
    const row = (await queryLeads(db, { q: "afe Ör" })).rows[0]!;
    expect(row.leadId).toBe(first.leadId);
    expect(row.name).toBe("Kafe Örnek");
    expect(row.cached).toBe(false);
    await patchLead(db, first.leadId, { displayName: "   " });
    expect((await queryLeads(db, { q: "afe Ör" })).total).toBe(0);
  });

  it("harita noktaları yalnızca konumu olan kayıtlardır; facet sayıları önbelleksiz kayıtları bildirir", async () => {
    await reopened();
    const total = (await queryLeads(db, {})).total;
    const facets = await queryFacets(db, {});
    expect(facets.uncached).toBe(total);
    expect(facets.categories.length).toBeGreaterThan(0);
    expect(facets.businessStatus.OPERATIONAL).toBeGreaterThan(0);

    const ids = (await db.select().from(places).limit(7)).map((p) => p.placeId);
    for (const id of ids)
      await db.update(places).set({ lat: null, lng: null }).where(eq(places.placeId, id));
    const pts = await queryPoints(db, {});
    expect(pts.points).toHaveLength(total - 7);
    expect(pts.points.every((p) => p.every((v) => typeof v === "number"))).toBe(true);
  });

  it("CSV: Google alanları boş gelir, kendi alanlar (görünen ad, kategori, Maps bağlantısı) dolu kalır", async () => {
    await reopened();
    const first = (await queryLeads(db, {}, { limit: 1 })).rows[0]!;
    await patchLead(db, first.leadId, { displayName: "Kafe Örnek" });
    const chunks: string[] = [];
    for await (const c of exportLeadsCsv(db, { q: "Kafe Örnek" }, { includeGoogleFields: true }))
      chunks.push(c);
    const [header, line] = chunks.join("").replace("﻿", "").split("\r\n") as [string, string];
    const cols = parseCsvLine(header);
    const cells = parseCsvLine(line);
    const at = (name: string) => cells[cols.indexOf(name)];
    expect(at("gorunen_ad")).toBe("Kafe Örnek");
    expect(at("kategori")).not.toBe("");
    expect(at("google_haritalar_baglantisi")).toContain("google.com/maps");
    expect(at("ad")).toBe("");
    expect(at("adres")).toBe("");
    expect(at("web_sitesi")).toBe("");
  });
});

describe("Google verisini yenileme (refresh) ve zenginleştirme", () => {
  it("refresh: önbelleği Pro SKU ile doldurur, enrichedAt atamaz, lead durumunu değiştirmez; enrich Enterprise SKU kullanır", async () => {
    await scan(["cafe"]);
    await db.delete(placeCache);
    const ids = (await db.select({ id: places.placeId }).from(places).limit(3)).map((r) => r.id);
    expect(await queryUncachedPlaceIds(db, {}, 5000)).toHaveLength(
      (await db.select().from(places)).length,
    );

    const res = await enrichPlaces(deps(), ids, "refresh");
    expect(res.enriched).toBe(3);
    const cache = await getCacheMap(db, ids);
    for (const id of ids) {
      const c = cache.get(id)!;
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.enrichedAt).toBeNull();
      expect(c.website).toBeNull();
    }
    expect((await db.select().from(leads).where(eq(leads.placeId, ids[0]!)))[0]!.status).toBe(
      "new",
    );
    const places3 = await db.select().from(places).where(eq(places.placeId, ids[0]!));
    expect(places3[0]!.lat).not.toBeNull();
    expect(places3[0]!.coordsFetchedAt).toBeGreaterThan(0);

    let usage = await budgetStatus(db, "mock", 30);
    expect(usage.bySku.find((s) => s.sku === "place_details_pro")?.calls).toBe(3);
    expect(usage.bySku.find((s) => s.sku === "place_details_enterprise")).toBeUndefined();

    await enrichPlaces(deps(), ids.slice(0, 1), "enrich");
    usage = await budgetStatus(db, "mock", 30);
    expect(usage.bySku.find((s) => s.sku === "place_details_enterprise")?.calls).toBe(1);
    const enriched = (await getCacheMap(db, ids.slice(0, 1))).get(ids[0]!)!;
    expect(enriched.enrichedAt).not.toBeNull();
    expect((await db.select().from(leads).where(eq(leads.placeId, ids[0]!)))[0]!.status).toBe(
      "enriched",
    );
  });

  it("refresh sonrası liste yeniden adlı satırlar gösterir", async () => {
    await scan(["cafe"]);
    await db.delete(placeCache);
    const ids = await queryUncachedPlaceIds(db, {}, 5000);
    await enrichPlaces(deps(), ids, "refresh");
    const rows = (await queryLeads(db, {}, { limit: 500 })).rows;
    expect(rows.every((r) => r.cached && r.name)).toBe(true);
    expect((await queryFacets(db, {})).uncached).toBe(0);
  });
});

describe("Google Haritalar bağlantısı", () => {
  it("yer kimliğinden üretilir (kimlik kodlanır); demo kayıtlar koordinat araması kullanır", async () => {
    const { googleMapsUrl } = await import("@/lib/places/maps-url");
    expect(googleMapsUrl("ChIJ abc/1")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Google&query_place_id=ChIJ%20abc%2F1",
    );
    expect(googleMapsUrl("demo", { source: "demo", lat: 51.5, lng: -0.12 })).toContain(
      "query=51.50000,-0.12000",
    );
    expect(googleMapsUrl("demo", { source: "demo", lat: null, lng: null })).toBe(
      "https://www.google.com/maps",
    );
  });
});
