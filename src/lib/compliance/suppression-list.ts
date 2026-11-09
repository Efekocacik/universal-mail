import { and, count, desc, eq, isNotNull, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import {
  suppressions,
  type SuppressionReason,
  type SuppressionScope,
  type SuppressionSource,
} from "@/lib/db/schema";
import { PROTECTED_REASONS } from "./suppression";

/**
 * Suppression listesi (FR-CMPL-02), SALT OKUNUR.
 *
 * Gizlilik: veritabanında tam adres YOKTUR (yalnızca özet, ekleme anında üretilmiş maskeli görünüm ve alan adı).
 * Bu yüzden liste yanıltıcı bir adres göstermez:
 *  - `masked`: kayıtlı maskeli görünüm (`i***@cafe.example`).
 *  - `domain`: alan adı kaydı; alan adı gösterilir.
 *  - `erased`: silme talebi kaydı. Adres, özet, özet öneki VE alan adı gösterilmez; alan adı aramasına da girmez.
 *  - `unavailable`: maskeli görünümü olmayan diğer e-posta kayıtları; hiçbir şey uydurulmaz.
 * Serbest metin `note` alanı ve ileti bağlantısı yanıta HİÇ konmaz.
 */

export type DisplayKind = "masked" | "domain" | "erased" | "unavailable";

export interface SuppressionListItem {
  id: number;
  scope: SuppressionScope;
  display: { kind: DisplayKind; text: string | null };
  reason: SuppressionReason;
  source: SuppressionSource;
  addedAt: number;
  liftedAt: number | null;
  active: boolean;
  /** Sıradan kaldırma yolu açık mı? (Çıkış, şikâyet ve silme talebi nedenleri kaldırılamaz.) */
  liftable: boolean;
}

export type SuppressionState = "active" | "lifted" | "all";

export interface SuppressionListQuery {
  state?: SuppressionState;
  reason?: SuppressionReason;
  scope?: SuppressionScope;
  /** Alan adı araması (silme talebi kayıtları dışarıda kalır). */
  q?: string;
  beforeId?: number;
  limit?: number;
}

export interface SuppressionList {
  items: SuppressionListItem[];
  /** Süzgece uyan toplam kayıt. */
  total: number;
  /** Sonraki sayfa için `beforeId`; son sayfada null. */
  nextBeforeId: number | null;
  /** Süzgeçten bağımsız özet. */
  summary: { active: number; lifted: number; byReason: Partial<Record<SuppressionReason, number>> };
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listSuppressions(
  db: DbExecutor,
  query: SuppressionListQuery = {},
): Promise<SuppressionList> {
  const conds: (SQL | undefined)[] = [];
  const state = query.state ?? "active";
  if (state === "active") conds.push(isNull(suppressions.liftedAt));
  if (state === "lifted") conds.push(isNotNull(suppressions.liftedAt));
  if (query.reason) conds.push(eq(suppressions.reason, query.reason));
  if (query.scope) conds.push(eq(suppressions.scope, query.scope));
  const q = query.q?.trim().toLowerCase().slice(0, 100);
  if (q) {
    conds.push(ne(suppressions.reason, "erasure"));
    conds.push(sql`${suppressions.domain} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`);
  }
  const where = and(...conds);

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(suppressions)
    .where(and(where, query.beforeId ? lt(suppressions.id, query.beforeId) : undefined))
    .orderBy(desc(suppressions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(suppressions).where(where);

  const summaryRows = await db
    .select({
      reason: suppressions.reason,
      lifted: sql<number>`CASE WHEN ${suppressions.liftedAt} IS NULL THEN 0 ELSE 1 END`,
      n: count(),
    })
    .from(suppressions)
    .groupBy(
      suppressions.reason,
      sql`CASE WHEN ${suppressions.liftedAt} IS NULL THEN 0 ELSE 1 END`,
    );
  const summary: SuppressionList["summary"] = { active: 0, lifted: 0, byReason: {} };
  for (const r of summaryRows) {
    if (Number(r.lifted) === 1) summary.lifted += Number(r.n);
    else {
      summary.active += Number(r.n);
      summary.byReason[r.reason] = (summary.byReason[r.reason] ?? 0) + Number(r.n);
    }
  }

  return {
    items: page.map((r) => {
      const active = r.liftedAt === null;
      let display: SuppressionListItem["display"];
      if (r.reason === "erasure") display = { kind: "erased", text: null };
      else if (r.scope === "domain") display = { kind: "domain", text: r.domain };
      else if (r.emailMasked) display = { kind: "masked", text: r.emailMasked };
      else display = { kind: "unavailable", text: null };
      return {
        id: r.id,
        scope: r.scope,
        display,
        reason: r.reason,
        source: r.source,
        addedAt: r.addedAt,
        liftedAt: r.liftedAt,
        active,
        liftable: active && !PROTECTED_REASONS.has(r.reason),
      };
    }),
    total: Number(n),
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
    summary,
  };
}
