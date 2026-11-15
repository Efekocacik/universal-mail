import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { jobs, leadEnrichment, leads } from "@/lib/db/schema";
import { enqueueEmailSearch } from "@/lib/email/enqueue";
import { markEnrichmentQueued, requeueRunningEnrichment } from "@/lib/email/store";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * E-posta araması kuyruğa alınırken lead'ler toplu işaretlenir (N+1 düzeltmesi): 2000 lead için lead başına ayrı
 * otomatik commit yerine tek işlemde 500'lük çok satırlı INSERT … ON CONFLICT. `running` satırlar korunur.
 */

let t: TestDb;
let db: Db;

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
});

async function mkLeads(n: number): Promise<number[]> {
  const rows = await db
    .insert(leads)
    .values(
      Array.from({ length: n }, () => ({
        source: "demo" as const,
        status: "enriched" as const,
        countryCode: "GB",
        city: "London",
        categoryKey: "cafe",
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .returning({ id: leads.id });
  return rows.map((r) => r.id);
}

describe("markEnrichmentQueued", () => {
  it("yeni satır ekler, var olanı kuyruğa alır (diğer sütunlar korunur), çalışanı ellemez", async () => {
    const [a, b, c] = await mkLeads(3);
    await db.insert(leadEnrichment).values([
      { leadId: b!, status: "failed", lastError: "x", attempts: 2, updatedAt: 1 },
      { leadId: c!, status: "running", updatedAt: 1 },
    ]);
    await markEnrichmentQueued(db, [a!, b!, c!, a!], 50);
    const rows = new Map((await db.select().from(leadEnrichment)).map((r) => [r.leadId, r]));
    expect(rows.get(a!)).toMatchObject({ status: "queued", updatedAt: 50 });
    expect(rows.get(b!)).toMatchObject({
      status: "queued",
      lastError: "x",
      attempts: 2,
      updatedAt: 50,
    });
    expect(rows.get(c!)).toMatchObject({ status: "running", updatedAt: 1 });
  });

  it("1200 lead: ifade sayısı lead sayısından bağımsız (parça başına bir INSERT)", async () => {
    const ids = await mkLeads(1200);
    const client = await getClient();
    const spy = vi.spyOn(client, "transaction");
    await enqueueEmailSearch(db, ids);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect((await db.select().from(leadEnrichment)).every((r) => r.status === "queued")).toBe(true);
    expect(await db.$count(leadEnrichment)).toBe(1200);
    expect(await db.$count(jobs)).toBe(60); // 20'lik iş parçaları
  });

  it("requeueRunningEnrichment yalnızca çalışanları kuyruğa döndürür", async () => {
    const [a, b] = await mkLeads(2);
    await db.insert(leadEnrichment).values([
      { leadId: a!, status: "running", updatedAt: 1 },
      { leadId: b!, status: "done", updatedAt: 1 },
    ]);
    await requeueRunningEnrichment(db, [a!, b!], 9);
    const rows = new Map((await db.select().from(leadEnrichment)).map((r) => [r.leadId, r]));
    expect(rows.get(a!)).toMatchObject({ status: "queued", updatedAt: 9 });
    expect(rows.get(b!)).toMatchObject({ status: "done", updatedAt: 1 });
  });
});
