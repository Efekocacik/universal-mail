import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { domainRegistrations, jobs, leadEnrichment, leads } from "@/lib/db/schema";
import type { FetchFn } from "@/lib/email/safe-fetch";
import { getSetting, setSetting } from "@/lib/settings";
import { sleep as defaultSleep } from "@/lib/util";
import {
  bootstrapFresh,
  fetchBootstrap,
  lookupDomain,
  nextCheckAt,
  rateLimitDelayMs,
  rdapHostFor,
  type RdapBootstrap,
  type RdapOutcome,
} from "./rdap";
import { demoRdap } from "./rdap-demo";

/**
 * RDAP işi (`novelty.rdap`). Kuyruk tablosu `domain_registrations`dır (alan adı başına bir satır; aynı alan adını
 * paylaşan lead'ler tek sorgu yapar).
 * 1. `syncDomainQueue`: başarılı site taramasından gelen `lead_enrichment.site_domain` değerleri için eksik satırlar
 *    `pending` olarak eklenir (INSERT OR IGNORE; idempotent).
 * 2. `runRdapBatch`: zamanı gelen satırlar sırayla sorgulanır (en çok `limit`; istekler arası bekleme). Sonuç tek UPDATE ile
 *    yazılır; deneme sayısına göre geri çekilir. Ayar kapalıysa hiçbir ağ isteği yapılmaz.
 * 3. Birikmiş kuyruk (ör. ilk açılışta ~1.900 alan adı) tek tura sığmaz: tur bittiğinde hâlâ zamanı gelmiş satır varsa ve
 *    tur durdurulmadıysa iş kendini `RDAP_CONTINUE_DELAY_MS` sonra yeniden kuyruğa alır (`continueAfterJobId`). Böylece
 *    kuyruk saatler içinde erir; işçi tek iş yürüttüğünden turlar arasında taramalar ve gönderimler önce çalışır.
 * Demo sağlayıcıda ağ isteği YOKTUR (`demoRdap`).
 */
export const RDAP_JOB = "novelty.rdap";
export const RDAP_MAX_PER_RUN = 50;
/** Kuyruk erirken iki tur arası bekleme (başka işlerin araya girmesi için). */
export const RDAP_CONTINUE_DELAY_MS = 5_000;

export async function syncDomainQueue(db: Db, now: number, leadIds?: number[]): Promise<number> {
  const scope = leadIds?.length
    ? sql` AND ${leadEnrichment.leadId} IN (${sql.join(
        leadIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const r = await db.run(sql`
    INSERT OR IGNORE INTO ${domainRegistrations}
      (domain, status, attempts, next_check_at, created_at, updated_at)
    SELECT DISTINCT ${leadEnrichment.siteDomain}, 'pending', 0, ${now}, ${now}, ${now}
    FROM ${leadEnrichment}
    WHERE ${leadEnrichment.siteDomain} IS NOT NULL${scope}`);
  return Number(r.rowsAffected ?? 0);
}

export interface RdapDeps {
  db: Db;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  shouldStop?: () => boolean;
  log?: (m: string) => void;
  /** Çalışan iş kimliği: verilirse ve kuyrukta zamanı gelmiş satır kaldıysa devam turu kuyruğa alınır. */
  continueAfterJobId?: number;
}

export interface RdapRunResult {
  checked: number;
  ok: number;
  failed: number;
  /** Kayıt tarihi bulunan alan adları (çağıran, bağlı lead'lerin yenilik skorunu yeniden hesaplar). */
  domains: string[];
  skippedReason?: "disabled" | "bootstrap_unavailable" | "stopped";
  /** Tur sonunda hâlâ zamanı gelmiş alan adı var mı (birikmiş kuyruk). */
  moreDue?: boolean;
  /** Devam turu kuyruğa alındıysa iş kimliği. */
  continuedJobId?: number | null;
  /** Hız sınırına takılan sunucu yüzünden bu turda sorgulanmadan ertelenen alan adı sayısı. */
  deferred?: number;
  /** Bu turda 429 veren sunucular ve ne zamana kadar sorgulanmayacakları. */
  rateLimited?: Record<string, number>;
}

async function loadBootstrap(deps: RdapDeps, now: number): Promise<RdapBootstrap | null> {
  const cached = (await getSetting(deps.db, "novelty.rdapBootstrap")) as RdapBootstrap | null;
  if (bootstrapFresh(cached, now)) return cached;
  try {
    const fresh = await fetchBootstrap(now, deps.fetch);
    if (fresh) {
      await setSetting(deps.db, "novelty.rdapBootstrap", fresh);
      return fresh;
    }
  } catch (e) {
    deps.log?.(`RDAP önyükleme alınamadı: ${(e as Error).message?.slice(0, 120)}`);
  }
  return cached; // eski de olsa kullanılabilir
}

export async function runRdapBatch(
  deps: RdapDeps,
  opts: { limit?: number } = {},
): Promise<RdapRunResult> {
  const { db } = deps;
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const res: RdapRunResult = { checked: 0, ok: 0, failed: 0, domains: [] };
  if (!(await getSetting(db, "novelty.rdap")).enabled) {
    res.skippedReason = "disabled";
    return res;
  }
  const demo = (await getSetting(db, "places.provider")) === "mock";
  await syncDomainQueue(db, clock());
  const due = await db
    .select()
    .from(domainRegistrations)
    .where(lte(domainRegistrations.nextCheckAt, clock()))
    .orderBy(asc(domainRegistrations.nextCheckAt))
    .limit(opts.limit ?? RDAP_MAX_PER_RUN);
  if (due.length === 0) return res;

  const bootstrap = demo ? null : await loadBootstrap(deps, clock());
  if (!demo && !bootstrap) {
    res.skippedReason = "bootstrap_unavailable";
    deps.log?.("RDAP önyükleme dosyası yok; alan adı yaşı bu tur denetlenmedi.");
    return res;
  }

  // 429 veren sunucu bu turda bir daha sorgulanmaz: o sunucunun kalan alan adları `Retry-After` sonrasına ertelenir
  // (deneme sayısı artmaz; hız sınırı alan adının hatası değildir) ve devam turu da en erken o ana kurulur.
  const throttled = new Map<string, number>();
  for (const row of due) {
    if (deps.shouldStop?.()) {
      res.skippedReason = "stopped";
      break;
    }
    const t = clock();
    const host = demo ? null : rdapHostFor(row.domain, bootstrap!);
    const until = host ? throttled.get(host) : undefined;
    if (until !== undefined) {
      await db
        .update(domainRegistrations)
        .set({ nextCheckAt: until, updatedAt: t })
        .where(eq(domainRegistrations.domain, row.domain));
      res.deferred = (res.deferred ?? 0) + 1;
      continue;
    }
    const out: RdapOutcome = demo
      ? demoRdap(row.domain, t)
      : await lookupDomain(row.domain, bootstrap!, deps.fetch, t);
    const limited = out.status === "rate_limited";
    const attempts = out.status === "error" ? row.attempts + 1 : limited ? row.attempts : 0;
    let next = nextCheckAt(out.status, attempts, t);
    if (limited) {
      next = t + rateLimitDelayMs(out.retryAfterMs);
      if (host) throttled.set(host, next);
      deps.log?.(
        `RDAP: ${host ?? "?"} hız sınırı (429); bu sunucu ${Math.round((next - t) / 60_000)} dk sorgulanmayacak.`,
      );
    }
    await db
      .update(domainRegistrations)
      .set({
        status: out.status,
        registeredAt: out.registeredAt,
        rdapHost: out.rdapHost,
        attempts,
        lastError: out.error,
        checkedAt: t,
        nextCheckAt: next,
        updatedAt: t,
      })
      .where(eq(domainRegistrations.domain, row.domain));
    res.checked++;
    if (out.status === "ok") {
      res.ok++;
      res.domains.push(row.domain);
    } else if (out.status === "error" || limited) res.failed++;
    if (!demo) await sleep(deps.minIntervalMs ?? 500);
  }
  if (throttled.size > 0) res.rateLimited = Object.fromEntries(throttled);
  if (res.checked > 0)
    await audit(
      db,
      "novelty.rdap_checked",
      "domains",
      undefined,
      { checked: res.checked, ok: res.ok, failed: res.failed },
      clock(),
    );
  if (!res.skippedReason) {
    const left = await db
      .select({ domain: domainRegistrations.domain })
      .from(domainRegistrations)
      .where(lte(domainRegistrations.nextCheckAt, clock()))
      .limit(1);
    // Hız sınırı yüzünden ertelenenler de kalan iş sayılır: devam turu sınır kalkınca onları sorgular.
    res.moreDue = left.length > 0 || (res.deferred ?? 0) > 0;
    if (res.moreDue && deps.continueAfterJobId !== undefined) {
      const t = clock();
      // Bir sunucu hız sınırı verdiyse devam turu hemen değil, en erken sınırın kalktığı anda (kuyruktaki sıra
      // nextCheckAt'e göre olduğundan aynı sunucuya ertesi turda yine ilk sırada gidilmesin).
      const earliest = throttled.size > 0 ? Math.min(...throttled.values()) : 0;
      res.continuedJobId = await enqueueRdap(db, {
        runAt: Math.max(t + RDAP_CONTINUE_DELAY_MS, earliest),
        now: t,
        exceptJobId: deps.continueAfterJobId,
      });
    }
  }
  deps.log?.(
    `RDAP: ${res.checked} alan adı denetlendi, ${res.ok} tarih bulundu, ${res.failed} hata${res.deferred ? `, ${res.deferred} ertelendi (hız sınırı)` : ""}${res.moreDue ? "; kalanlar için devam turu" : ""}`,
  );
  return res;
}

/** Bu alan adlarına bağlı lead'lerin yer kimlikleri (yenilik skorunu yeniden hesaplamak için). */
export async function placeIdsForDomains(db: Db, domains: string[]): Promise<string[]> {
  if (domains.length === 0) return [];
  const rows = await db
    .select({ placeId: leads.placeId })
    .from(leadEnrichment)
    .innerJoin(leads, eq(leads.id, leadEnrichment.leadId))
    .where(and(inArray(leadEnrichment.siteDomain, domains), isNotNull(leads.placeId)));
  return rows.map((r) => r.placeId!).filter(Boolean);
}

/** Kuyrukta/çalışan RDAP işi yoksa ekler (tek işlem; sabit tekilleştirme anahtarı yok). */
export async function enqueueRdap(
  db: Db,
  opts: { runAt: number; now: number; exceptJobId?: number },
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, RDAP_JOB),
          inArray(jobs.status, ["queued", "running"]),
          opts.exceptJobId !== undefined ? ne(jobs.id, opts.exceptJobId) : undefined,
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        type: RDAP_JOB,
        payload: {},
        status: "queued",
        priority: 0,
        maxAttempts: 1,
        runAt: opts.runAt,
        createdAt: opts.now,
        updatedAt: opts.now,
      })
      .returning({ id: jobs.id });
    return row?.id ?? null;
  });
}

/** Ayarlar kartı: RDAP durumu. */
export async function rdapStatus(db: Db, now: number) {
  const enabled = (await getSetting(db, "novelty.rdap")).enabled;
  const b = (await getSetting(db, "novelty.rdapBootstrap")) as RdapBootstrap | null;
  const rows = await db
    .select({ status: domainRegistrations.status, n: sql<number>`count(*)` })
    .from(domainRegistrations)
    .groupBy(domainRegistrations.status);
  const due = await db
    .select({ n: sql<number>`count(*)` })
    .from(domainRegistrations)
    .where(lte(domainRegistrations.nextCheckAt, now));
  const last = await db
    .select({ t: sql<number | null>`max(${domainRegistrations.checkedAt})` })
    .from(domainRegistrations);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = Number(r.n);
  return {
    enabled,
    demo: (await getSetting(db, "places.provider")) === "mock",
    bootstrap: b
      ? { fetchedAt: b.fetchedAt, publication: b.publication, tlds: Object.keys(b.map).length }
      : null,
    counts,
    due: Number(due[0]?.n ?? 0),
    lastCheckedAt: last[0]?.t === null || last[0]?.t === undefined ? null : Number(last[0].t),
  };
}
