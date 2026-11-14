import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, notifications, scans } from "@/lib/db/schema";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { PlacesApiError } from "@/lib/places/errors";
import { MockPlacesProvider } from "@/lib/places/mock";
import type { PlacesProvider } from "@/lib/places/provider";
import { isAutoResumable } from "@/lib/scan/pause-codes";
import { runScan, type RunnerDeps } from "@/lib/scan/runner";
import { cancelScan, createAndStartScan, pauseScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Çalıştırıcının durum yazıları karşılaştır-ve-yaz (CAS): kullanıcı bir Places çağrısı sürerken iptal ederse veya
 * duraklatırsa çalıştırıcının geç gelen "duraklatıldı (PROVIDER_*)", "başarısız" ya da "tamamlandı" yazısı bunu ezmez.
 * Ezseydi PROVIDER_* kodu zamanlanmış taramanın kullanıcı iptalinden sonra kendiliğinden sürdürülmesine yol açardı.
 */

let t: TestDb;
let db: Db;
const box = bboxFromCenter(51.5085, -0.1257, 3.5);

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
});
afterEach(async () => {
  await t.cleanup();
});

async function startScan(): Promise<number> {
  const rows = await db.select().from(categorySets);
  const { scanId } = await createAndStartScan(db, {
    region: { kind: "city", name: "London", countryCode: "GB", bbox: box },
    categoryIds: rows.filter((r) => r.key === "cafe").map((r) => r.id),
  });
  return scanId;
}

function deps(provider: PlacesProvider, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    db,
    provider,
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...over,
  };
}

/** İlk çağrıda taramayı kullanıcı adına `act` ile değiştirip sonra verilen hatayı fırlatan sağlayıcı. */
function interruptingProvider(act: () => Promise<unknown>, err: Error): PlacesProvider {
  const base = new MockPlacesProvider({ getEpoch: () => 0 });
  let fired = false;
  const hit = async () => {
    if (!fired) {
      fired = true;
      await act();
      throw err;
    }
    throw new Error("ikinci çağrı yapılmamalı");
  };
  return Object.assign(Object.create(base) as PlacesProvider, {
    searchText: hit,
    searchNearby: hit,
  });
}

async function row(scanId: number) {
  return (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
}

describe("çalıştırıcı CAS", () => {
  it("çağrı sürerken iptal + geçici sağlayıcı hatası: tarama iptal kalır, PROVIDER_* yazılmaz", async () => {
    const scanId = await startScan();
    const provider = interruptingProvider(
      () => cancelScan(db, scanId),
      new PlacesApiError("rate", "Hız sınırı"),
    );
    const out = await runScan(deps(provider), scanId);
    expect(out).toBe("cancelled");
    const s = await row(scanId);
    expect(s.status).toBe("cancelled");
    expect(s.pauseCode).toBeNull();
    expect(isAutoResumable(s.status, s.pauseCode)).toBe(false);
    const n = await db.select().from(notifications);
    expect(n.filter((x) => x.kind === "scan.paused")).toHaveLength(0);
  });

  it("çağrı sürerken iptal + kalıcı hata: 'failed' yazılmaz, bildirim gitmez", async () => {
    const scanId = await startScan();
    const provider = interruptingProvider(
      () => cancelScan(db, scanId),
      new PlacesApiError("auth", "Anahtar geçersiz"),
    );
    expect(await runScan(deps(provider), scanId)).toBe("cancelled");
    expect((await row(scanId)).status).toBe("cancelled");
    const n = await db.select().from(notifications);
    expect(n.filter((x) => x.kind === "scan.failed")).toHaveLength(0);
  });

  it("çağrı sürerken kullanıcı duraklatması sağlayıcı kodu ile ezilmez", async () => {
    const scanId = await startScan();
    const provider = interruptingProvider(
      () => pauseScan(db, scanId),
      new PlacesApiError("network", "Ağ hatası"),
    );
    expect(await runScan(deps(provider), scanId)).toBe("paused");
    const s = await row(scanId);
    expect(s.status).toBe("paused");
    expect(s.pauseCode === null || !String(s.pauseCode).startsWith("PROVIDER_")).toBe(true);
    expect(isAutoResumable(s.status, s.pauseCode)).toBe(false);
  });

  it("sonlandırma sırasında iptal: 'completed' yazılmaz, tamamlandı denetimi/bildirimi yok", async () => {
    const scanId = await startScan();
    const provider = new MockPlacesProvider({ getEpoch: () => 0 });
    const out = await runScan(
      deps(provider, {
        getNoveltyConfig: async () => {
          await cancelScan(db, scanId);
          return getSetting(db, "novelty.thresholds");
        },
      }),
      scanId,
    );
    expect(out).toBe("cancelled");
    expect((await row(scanId)).status).toBe("cancelled");
    const a = await db.select().from(auditLog).where(eq(auditLog.action, "scan.completed"));
    expect(a).toHaveLength(0);
  });
});
