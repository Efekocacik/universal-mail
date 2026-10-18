import { and, eq, like, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { apiUsage } from "@/lib/db/schema";
import type { ProviderId, SkuId } from "@/lib/domain/types";
import { marginalCostUsd, PRICING_VERIFIED_AT, SKU_PRICING } from "@/lib/places/pricing";
import { dayKey, monthKey, round } from "@/lib/util";

export interface SkuUsage {
  sku: string;
  calls: number;
  costUsd: number;
}

export type BudgetLevel = "ok" | "warning" | "blocked";

export interface BudgetStatus {
  month: string;
  provider: ProviderId;
  monthlyUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** 0–100+ */
  pct: number;
  level: BudgetLevel;
  bySku: SkuUsage[];
  totalCalls: number;
  pricingVerifiedAt: string;
}

export const WARNING_PCT = 80;

export async function monthSkuCalls(
  db: Db,
  provider: ProviderId,
  sku: SkuId,
  month: string = monthKey(),
): Promise<number> {
  const rows = await db
    .select({ calls: sql<number>`coalesce(sum(${apiUsage.calls}), 0)` })
    .from(apiUsage)
    .where(
      and(eq(apiUsage.provider, provider), eq(apiUsage.sku, sku), like(apiUsage.day, `${month}-%`)),
    );
  return Number(rows[0]?.calls ?? 0);
}

/** Çağrıyı kaydeder ve bu çağrının EK maliyetini (ücretsiz kota ve kademeler dikkate alınarak) döndürür. */
export async function recordUsage(
  db: Db,
  provider: ProviderId,
  sku: SkuId,
  calls = 1,
  atMs: number = Date.now(),
): Promise<number> {
  const before = await monthSkuCalls(db, provider, sku, monthKey(atMs));
  const cost = marginalCostUsd(sku, before, calls);
  await db
    .insert(apiUsage)
    .values({ provider, sku, day: dayKey(atMs), calls, estCostUsd: cost })
    .onConflictDoUpdate({
      target: [apiUsage.provider, apiUsage.sku, apiUsage.day],
      set: {
        calls: sql`${apiUsage.calls} + ${calls}`,
        estCostUsd: sql`${apiUsage.estCostUsd} + ${cost}`,
      },
    });
  return cost;
}

export async function budgetStatus(
  db: Db,
  provider: ProviderId,
  monthlyUsd: number,
  month: string = monthKey(),
): Promise<BudgetStatus> {
  const rows = await db
    .select({
      sku: apiUsage.sku,
      calls: sql<number>`sum(${apiUsage.calls})`,
      cost: sql<number>`sum(${apiUsage.estCostUsd})`,
    })
    .from(apiUsage)
    .where(and(eq(apiUsage.provider, provider), like(apiUsage.day, `${month}-%`)))
    .groupBy(apiUsage.sku);
  const bySku: SkuUsage[] = rows.map((r) => ({
    sku: r.sku,
    calls: Number(r.calls),
    costUsd: round(Number(r.cost), 4),
  }));
  const spentUsd = round(
    bySku.reduce((a, r) => a + r.costUsd, 0),
    4,
  );
  const pct = monthlyUsd > 0 ? (spentUsd / monthlyUsd) * 100 : spentUsd > 0 ? 100 : 0;
  const level: BudgetLevel = pct >= 100 ? "blocked" : pct >= WARNING_PCT ? "warning" : "ok";
  return {
    month,
    provider,
    monthlyUsd,
    spentUsd,
    remainingUsd: round(Math.max(0, monthlyUsd - spentUsd), 4),
    pct: round(pct, 1),
    level,
    bySku,
    totalCalls: bySku.reduce((a, r) => a + r.calls, 0),
    pricingVerifiedAt: PRICING_VERIFIED_AT,
  };
}

export interface SpendCheck {
  ok: boolean;
  projectedUsd: number;
  reason?: string;
}

/**
 * Yeni ücretli çağrılar bütçeyi aşacak mı? Ücretsiz kota içindeki çağrıların maliyeti 0 olduğundan
 * bütçe 0 olsa bile ücretsiz kota bitene kadar çağrıya izin verilir.
 */
export async function canSpend(
  db: Db,
  provider: ProviderId,
  monthlyUsd: number,
  sku: SkuId,
  calls = 1,
): Promise<SpendCheck> {
  const status = await budgetStatus(db, provider, monthlyUsd);
  const before = await monthSkuCalls(db, provider, sku);
  const add = marginalCostUsd(sku, before, calls);
  const projectedUsd = round(status.spentUsd + add, 4);
  if (projectedUsd > monthlyUsd + 1e-9) {
    return {
      ok: false,
      projectedUsd,
      reason: `Aylık bütçe sınırına ulaşıldı (tahmini ${projectedUsd.toFixed(2)} / ${monthlyUsd.toFixed(2)} USD).`,
    };
  }
  return { ok: true, projectedUsd };
}

export function skuName(sku: string): string {
  return SKU_PRICING[sku as SkuId]?.label ?? sku;
}
