import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, leads, places, scans } from "@/lib/db/schema";
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
    const names = byName.rows.map((r) => r.name.toLowerCase());
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
    const word = first.name.split(" ")[0]!;
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
    const sample = (await db.select().from(places).limit(1))[0]!;
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
    const p = (await db.select().from(places).limit(1))[0]!;
    await db
      .update(places)
      .set({ name: '=cmd|" /C calc"!A1' })
      .where(eq(places.placeId, p.placeId));
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
});
