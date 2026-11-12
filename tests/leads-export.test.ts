import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import {
  auditLog,
  categorySets,
  leads,
  notifications,
  places,
  regions,
  scanSchedules,
  scans,
} from "@/lib/db/schema";
import { notify } from "@/lib/notifications";
import { CSV_COLUMNS, csvCell, exportLeadsCsv, selectColumns } from "@/lib/export/csv";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { getLeadDetail, queryFacets, queryLeads, queryPoints } from "@/lib/leads/query";
import { leadPatchSchema, patchLead, purgeDemoData } from "@/lib/leads/mutations";
import { MockPlacesProvider } from "@/lib/places/mock";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { budgetStatus } from "@/lib/budget";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let db: Db;
const provider = new MockPlacesProvider({ getEpoch: () => 0 });

async function scanLondon(keys: string[], half = 3.5) {
  const ids = (await db.select().from(categorySets))
    .filter((c) => keys.includes(c.key))
    .map((c) => c.id);
  const { scanId } = await createAndStartScan(db, {
    region: {
      kind: "city",
      name: "London",
      countryCode: "GB",
      bbox: bboxFromCenter(51.5085, -0.1257, half),
    },
    categoryIds: ids,
  });
  await runScan(
    {
      db,
      provider,
      getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
      getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
      sleep: async () => undefined,
      minIntervalMs: 0,
    },
    scanId,
  );
  return scanId;
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const part of gen) out += part;
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

describe("lead sorguları", () => {
  it("sayfalama, toplam ve sıralama", async () => {
    await scanLondon(["cafe", "pub"]);
    const all = await queryLeads(db, {}, { limit: 500 });
    expect(all.total).toBeGreaterThan(50);
    expect(all.rows.length).toBe(Math.min(all.total, 500));

    const page1 = await queryLeads(db, {}, { limit: 10, offset: 0 });
    const page2 = await queryLeads(db, {}, { limit: 10, offset: 10 });
    expect(page1.rows).toHaveLength(10);
    expect(page1.total).toBe(all.total);
    expect(new Set([...page1.rows, ...page2.rows].map((r) => r.leadId)).size).toBe(20);

    // Varsayılan sıralama: yenilik skoru azalan
    const scores = page1.rows.map((r) => r.noveltyScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    const byName = await queryLeads(db, {}, { sort: "name", limit: 30 });
    const names = byName.rows.map((r) => r.name!.toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("süzgeçler: yenilik etiketi, ülke, kategori, iş durumu, harita kutusu", async () => {
    await scanLondon(["cafe", "pub"]);
    const future = await queryLeads(db, { novelty: ["future_opening"] }, { limit: 500 });
    expect(future.total).toBeGreaterThan(0);
    expect(
      future.rows.every(
        (r) =>
          r.noveltyLabel === "future_opening" &&
          r.businessStatus === "FUTURE_OPENING" &&
          r.openingDate,
      ),
    ).toBe(true);

    expect((await queryLeads(db, { countries: ["GB"] })).total).toBe(
      (await queryLeads(db, {})).total,
    );
    expect((await queryLeads(db, { countries: ["DE"] })).total).toBe(0);

    const pubs = await queryLeads(db, { categories: ["pub"] }, { limit: 500 });
    expect(pubs.total).toBeGreaterThan(0);
    expect(pubs.rows.every((r) => r.primaryType === "pub" || r.primaryType === "bar")).toBe(true);
    expect((await queryLeads(db, { categories: ["yok"] })).total).toBe(0);

    expect((await queryLeads(db, { businessStatus: ["OPERATIONAL"] })).total + future.total).toBe(
      (await queryLeads(db, {})).total,
    );

    const small = bboxFromCenter(51.5085, -0.1257, 0.5);
    const inBox = await queryLeads(db, { bbox: small }, { limit: 500 });
    expect(inBox.total).toBeGreaterThan(0);
    expect(inBox.total).toBeLessThan((await queryLeads(db, {})).total);
    expect(
      inBox.rows.every(
        (r) =>
          r.lat! >= small.south &&
          r.lat! <= small.north &&
          r.lng! >= small.west &&
          r.lng! <= small.east,
      ),
    ).toBe(true);
  });

  it("metin araması özel karakterleri (%, _) düz metin sayar ve SQL enjeksiyonuna dayanıklıdır", async () => {
    await scanLondon(["cafe"]);
    const first = (await queryLeads(db, {}, { limit: 1 })).rows[0]!;
    const word = first.name!.split(" ")[0]!;
    const hit = await queryLeads(db, { q: word.toUpperCase() });
    expect(hit.rows.some((r) => r.leadId === first.leadId)).toBe(true);
    expect((await queryLeads(db, { q: "%" })).total).toBe(0);
    expect((await queryLeads(db, { q: "_" })).total).toBe(0);
    expect((await queryLeads(db, { q: "'; DROP TABLE leads; --" })).total).toBe(0);
    expect((await queryLeads(db, {})).total).toBeGreaterThan(0); // tablo yerinde
  });

  it("tarama süzgeci yalnızca o taramada görülenleri verir", async () => {
    const a = await scanLondon(["cafe"]);
    const b = await scanLondon(["pub"]);
    const onlyA = await queryLeads(db, { scanId: a }, { limit: 500 });
    const onlyB = await queryLeads(db, { scanId: b }, { limit: 500 });
    expect(
      onlyA.rows.every((r) => r.primaryType === "cafe" || r.primaryType === "coffee_shop"),
    ).toBe(true);
    expect(onlyB.rows.every((r) => r.primaryType === "pub" || r.primaryType === "bar")).toBe(true);
  });

  it("nokta listesi harita için kompakt ve sınırlıdır", async () => {
    await scanLondon(["cafe", "pub"]);
    const { points, truncated, total } = await queryPoints(db, {});
    expect(truncated).toBe(false);
    expect(total).toBe(points.length);
    expect(points[0]).toHaveLength(5);
    const limited = await queryPoints(db, {}, 10);
    expect(limited.points).toHaveLength(10);
    expect(limited.truncated).toBe(true);
    // en yüksek öncelikli (yakında açılacak) noktalar başta
    expect(limited.points[0]![3]).toBe(0);
  });

  it("facet sayıları tutarlıdır", async () => {
    await scanLondon(["cafe", "pub"]);
    const f = await queryFacets(db, {});
    expect(f.countries).toEqual([{ code: "GB", count: f.total }]);
    expect(Object.values(f.novelty).reduce((a, b) => a + b, 0)).toBe(f.total);
    expect(Object.values(f.businessStatus).reduce((a, b) => a + b, 0)).toBe(f.total);
    expect(f.cities[0]?.name).toBe("London");
    expect(f.novelty.future_opening).toBeGreaterThan(0);
  });

  it("lead ayrıntısı ve düzenleme", async () => {
    await scanLondon(["cafe"]);
    const row = (await queryLeads(db, {}, { limit: 1 })).rows[0]!;
    const before = await getLeadDetail(db, row.leadId);
    expect(before?.place?.placeId).toBe(row.placeId);
    expect(
      await patchLead(db, row.leadId, {
        status: "not_interested",
        notes: "Aradık, ilgilenmiyor",
        tags: ["a", "a", "b"],
      }),
    ).toBe(true);
    const after = await getLeadDetail(db, row.leadId);
    expect(after?.lead.status).toBe("not_interested");
    expect(after?.lead.tags).toEqual(["a", "b"]);
    expect(after?.lead.notes).toBe("Aradık, ilgilenmiyor");
    expect(await patchLead(db, 999_999, { status: "sent" })).toBe(false);
    expect(leadPatchSchema.safeParse({ status: "bilinmeyen" }).success).toBe(false);
    expect((await db.select().from(auditLog)).some((a) => a.action === "lead.status")).toBe(true);
  });
});

describe("CSV dışa aktarma", () => {
  it("varsayılan olarak Google kaynaklı alanlar dahil edilmez", async () => {
    await scanLondon(["cafe"]);
    const csv = await collect(exportLeadsCsv(db, {}, { includeGoogleFields: false }));
    const header = csv.replace("﻿", "").split("\r\n")[0]!;
    const headers = header.split(",");
    expect(headers).toContain("place_id");
    expect(headers).toContain("yenilik_skoru");
    for (const c of CSV_COLUMNS.filter((c) => c.origin === "google"))
      expect(headers).not.toContain(c.header);
    expect(csv.startsWith("﻿")).toBe(true);
    // Ad ve adres sızmamalı
    const sample = (await db.select().from(placeCache).limit(1))[0]!;
    expect(csv).not.toContain(sample.name);
    expect(csv).not.toContain(sample.formattedAddress!);
  });

  it("bilinçli olarak açılırsa Google alanları da gelir; satır sayısı süzgece uyar; denetim kaydı yazılır", async () => {
    await scanLondon(["cafe", "pub"]);
    const filters = { novelty: ["future_opening" as const] };
    const expected = (await queryLeads(db, filters, { limit: 500 })).total;
    const csv = await collect(exportLeadsCsv(db, filters, { includeGoogleFields: true }));
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines.length - 1).toBe(expected);
    expect(lines[0]!.split(",")).toEqual(expect.arrayContaining(["ad", "adres", "web_sitesi"]));
    const log = (await db.select().from(auditLog).where(eq(auditLog.action, "export.leads")))[0]!;
    expect(log.detail).toMatchObject({ rows: expected, includeGoogleFields: true });
  });

  it("büyük dışa aktarmada tüm kayıtlar parça parça gelir", async () => {
    await scanLondon(["cafe", "pub"], 6);
    const total = (await queryLeads(db, {})).total;
    expect(total).toBeGreaterThan(300);
    const csv = await collect(exportLeadsCsv(db, {}, { includeGoogleFields: true }));
    expect(csv.split("\r\n").filter(Boolean).length - 1).toBe(total);
  });

  it("hücre kaçışı ve CSV enjeksiyonu koruması", () => {
    expect(csvCell("düz")).toBe("düz");
    expect(csvCell('içinde "tırnak"')).toBe('"içinde ""tırnak"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("satır\nsonu")).toBe('"satır\nsonu"');
    expect(csvCell('=HYPERLINK("http://kotu")')).toBe(`"'=HYPERLINK(""http://kotu"")"`);
    expect(csvCell("+90 555")).toBe("'+90 555");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe("-5"); // sayılar etkilenmez
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("zararlı bir işletme adı dışa aktarmada etkisizleştirilir", async () => {
    await scanLondon(["cafe"]);
    const p = (await db.select().from(placeCache).limit(1))[0]!;
    await db
      .update(placeCache)
      .set({ name: '=cmd|" /C calc"!A1' })
      .where(eq(placeCache.placeId, p.placeId));
    const csv = await collect(exportLeadsCsv(db, {}, { includeGoogleFields: true }));
    expect(csv).toContain(`"'=cmd|"" /C calc""!A1"`);
    expect(csv).not.toMatch(/(^|,)=cmd/m);
    expect(selectColumns(false).every((c) => c.origin === "own")).toBe(true);
  });
});

describe("demo verilerini temizleme", () => {
  it("demo kayıtlar, taramalar ve kullanım silinir; bölge kalıntısı kalmaz", async () => {
    await scanLondon(["cafe"]);
    expect((await budgetStatus(db, "mock", 30)).totalCalls).toBeGreaterThan(0);
    const res = await purgeDemoData(db);
    expect(res.places).toBeGreaterThan(0);
    expect(res.scans).toBe(1);
    expect(await db.select().from(places)).toHaveLength(0);
    expect(await db.select().from(leads)).toHaveLength(0);
    expect(await db.select().from(scans)).toHaveLength(0);
    expect((await budgetStatus(db, "mock", 30)).totalCalls).toBe(0);
  });

  it("Faz 4: demo zamanlaması ve bağlı bildirimler silinir; çalışmamış zamanlama ve bölgesi KALIR", async () => {
    const manualId = await scanLondon(["cafe"]);
    const manual = (await db.select().from(scans).where(eq(scans.id, manualId)))[0]!;
    const now = Date.now();
    const geometry = (await db.select().from(regions).where(eq(regions.id, manual.regionId)))[0]!
      .geometry;
    // Taraması olmayan iki bölge: biri zamanlamalı (kalmalı), biri boş (silinmeli)
    const [scheduledRegion] = await db
      .insert(regions)
      .values({ name: "Zamanlanmış", kind: "bbox", geometry, createdAt: now })
      .returning({ id: regions.id });
    const [emptyRegion] = await db
      .insert(regions)
      .values({ name: "Boş", kind: "bbox", geometry, createdAt: now })
      .returning({ id: regions.id });
    const sched = (regionId: number, key: string) => ({
      regionId,
      scanKey: key,
      categorySetIds: manual.categorySetIds,
      strategy: manual.strategy,
      fieldProfile: manual.fieldProfile,
      intervalDays: 14 as const,
      nextRunAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
    });
    const [demoSchedule, idleSchedule] = await db
      .insert(scanSchedules)
      .values([sched(manual.regionId, manual.scanKey), sched(scheduledRegion!.id, "idle-key")])
      .returning({ id: scanSchedules.id });
    // Zamanlamanın demo sağlayıcıyla çalışmış bir taraması
    const { id: _id, ...copy } = manual;
    const [run] = await db
      .insert(scans)
      .values({
        ...copy,
        origin: "schedule",
        scheduleId: demoSchedule!.id,
        scheduleSlot: now,
        createdAt: now,
      })
      .returning({ id: scans.id });
    await db
      .update(scanSchedules)
      .set({ lastScanId: run!.id, lastOutcome: "completed" })
      .where(eq(scanSchedules.id, demoSchedule!.id));

    const n = (dedupeKey: string, entity?: string, entityId?: number) =>
      notify(db, {
        kind: dedupeKey.startsWith("schedule") ? "schedule.skipped" : "scan.done",
        dedupeKey,
        url: "/scans",
        entity,
        entityId,
      });
    await n(`scan.done:${manualId}`, "scan", manualId);
    await n(`scan.done:${run!.id}`); // entity yok: anahtardan bulunur
    await n(
      `schedule.skipped:${demoSchedule!.id}:NEEDS_ACK:2026-11-01`,
      "schedule",
      demoSchedule!.id,
    );
    await n(
      `schedule.skipped:${idleSchedule!.id}:NEEDS_ACK:2026-11-01`,
      "schedule",
      idleSchedule!.id,
    );

    const res = await purgeDemoData(db);
    expect(res).toMatchObject({ scans: 2, schedules: 1, notifications: 3 });
    expect(await db.select().from(scans)).toHaveLength(0);
    expect((await db.select().from(scanSchedules)).map((s) => s.id)).toEqual([idleSchedule!.id]);
    expect((await db.select().from(notifications)).map((r) => r.dedupeKey)).toEqual([
      `schedule.skipped:${idleSchedule!.id}:NEEDS_ACK:2026-11-01`,
    ]);
    const left = await db
      .select({ id: regions.id })
      .from(regions)
      .where(inArray(regions.id, [manual.regionId, scheduledRegion!.id, emptyRegion!.id]));
    expect(left.map((r) => r.id)).toEqual([scheduledRegion!.id]);
    const auditRow = (await db.select().from(auditLog)).find((a) => a.action === "demo.purged");
    expect(auditRow?.detail).toMatchObject({ schedules: 1, notifications: 3 });
  });

  it("gerçek sağlayıcıyla en az bir kez çalışmış zamanlama silinmez (taramaları mock olsa bile)", async () => {
    const manualId = await scanLondon(["cafe"]);
    const manual = (await db.select().from(scans).where(eq(scans.id, manualId)))[0]!;
    const now = Date.now();
    const [s] = await db
      .insert(scanSchedules)
      .values({
        regionId: manual.regionId,
        scanKey: manual.scanKey,
        categorySetIds: manual.categorySetIds,
        strategy: manual.strategy,
        fieldProfile: manual.fieldProfile,
        intervalDays: 7,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: scanSchedules.id });
    const { id: _id, ...copy } = manual;
    await db.insert(scans).values([
      { ...copy, origin: "schedule", scheduleId: s!.id, scheduleSlot: 1, createdAt: now },
      {
        ...copy,
        provider: "google",
        origin: "schedule",
        scheduleId: s!.id,
        scheduleSlot: 2,
        createdAt: now,
      },
    ]);
    const res = await purgeDemoData(db);
    expect(res.schedules).toBe(0);
    expect(await db.select().from(scanSchedules)).toHaveLength(1);
    // Gerçek tarama ve bölgesi kalır
    expect((await db.select().from(scans)).map((x) => x.provider)).toEqual(["google"]);
    expect(await db.select().from(regions).where(eq(regions.id, manual.regionId))).toHaveLength(1);
  });
});

describe("arşivlenmiş lead'ler (Faz 4 sözleşmesi)", () => {
  it("varsayılan liste, sayım ve dışa aktarma arşivlenmişleri gizler; archived:true yalnızca onları gösterir", async () => {
    await scanLondon(["cafe"]);
    const all = await queryLeads(db, {}, { limit: 500 });
    const target = all.rows[0]!.leadId;
    await db.update(leads).set({ archivedAt: Date.now() }).where(eq(leads.id, target));
    const visible = await queryLeads(db, {}, { limit: 500 });
    expect(visible.total).toBe(all.total - 1);
    expect(visible.rows.some((r) => r.leadId === target)).toBe(false);
    const archived = await queryLeads(db, { archived: true }, { limit: 500 });
    expect(archived.rows.map((r) => r.leadId)).toEqual([target]);
    const csv = await collect(exportLeadsCsv(db, {}, { includeGoogleFields: false }));
    expect(csv.trim().split("\n")).toHaveLength(all.total); // başlık + (toplam − 1)
  });
});
