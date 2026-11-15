import { and, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { jobs, leads, registryCompanies, registryRuns } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { getSecret, secretStatus } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { errorMessage } from "@/lib/util";
import { categoryForCodes, CODE_RE, isSchemeAvailable } from "./codes";
import { createCompaniesHouseProvider } from "./companies-house";
import { createDemoRegistryProvider } from "./demo";
import { fromProviderError, PERMANENT_RUN_ERRORS, RegistryServiceError } from "./errors";
import { defaultSleep, type HttpDeps } from "./http";
import { createInseeProvider } from "./insee";
import {
  addressKey,
  assignMatches,
  buildCandidateIndex,
  foldText,
  localityKey,
  normaliseName,
  postcodeKey,
  postcodeKeyFromAddress,
  type CandidateIndex,
  type MatchCandidate,
  type MatchDecision,
  type MatchSubject,
} from "./match";
import {
  REGISTRY_FETCH_JOB,
  REGISTRY_MATCH_JOB,
  RegistryProviderError,
  registryWindow,
  type ActivityScheme,
  type RegistryCompanyInput,
  type RegistryProvider,
  type RegistryRunErrorCode,
  type RegistrySource,
} from "./types";

/* -------------------------------------------------------------------------------------------------------------
 * Sicil servisi (paket R). Sicil kayıtları BİZİM verimizdir (herkese açık sicil); Google içeriği (ad, adres) yalnızca
 * eşleştirme sırasında bellekte okunur ve hiçbir tabloya/yanıta yazılmaz: eşleşmeden yalnızca `matched_place_id` kalır.
 * ----------------------------------------------------------------------------------------------------------- */

type RunRow = typeof registryRuns.$inferSelect;
type CompanyRow = typeof registryCompanies.$inferSelect;

export interface RegistryRunDto {
  id: number;
  source: RegistrySource;
  isDemo: boolean;
  status: RunRow["status"];
  activityScheme: ActivityScheme;
  activityCodes: string[];
  windowFrom: string;
  windowTo: string;
  locality: string | null;
  fetchedCount: number;
  newCount: number;
  matchedCount: number;
  unmatchedCount: number;
  pendingCount: number;
  errorCode: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RegistryCompanyDto {
  id: number;
  source: RegistrySource;
  isDemo: boolean;
  externalId: string;
  name: string;
  tradingName: string | null;
  countryCode: "GB" | "FR";
  activityCodes: string[];
  categoryKey: string | null;
  incorporatedOn: string;
  postcode: string | null;
  locality: string | null;
  matchStatus: CompanyRow["matchStatus"];
  matchReason: string | null;
  matchScore: number | null;
  matchedPlaceId: string | null;
  /** Eşleşen yerin (arşivlenmemiş) lead'i; arayüz adı bu lead üzerinden (oturum önbelleği) gösterir. */
  matchedLeadId: number | null;
  leadId: number | null;
}

export function toRunDto(r: RunRow): RegistryRunDto {
  return {
    id: r.id,
    source: r.source,
    isDemo: r.isDemo,
    status: r.status,
    activityScheme: r.activityScheme,
    activityCodes: r.activityCodes,
    windowFrom: r.windowFrom,
    windowTo: r.windowTo,
    locality: r.locality,
    fetchedCount: r.fetchedCount,
    newCount: r.newCount,
    matchedCount: r.matchedCount,
    unmatchedCount: r.unmatchedCount,
    pendingCount: r.pendingCount,
    errorCode: r.errorCode,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

function toCompanyDto(c: CompanyRow, matchedLeadId: number | null): RegistryCompanyDto {
  return {
    id: c.id,
    source: c.source,
    isDemo: c.isDemo,
    externalId: c.externalId,
    name: c.name,
    tradingName: c.tradingName,
    countryCode: c.countryCode,
    activityCodes: c.activityCodes,
    categoryKey: c.categoryKey,
    incorporatedOn: c.incorporatedOn,
    postcode: c.postcode,
    locality: c.locality,
    matchStatus: c.matchStatus,
    matchReason: c.matchReason,
    matchScore: c.matchScore,
    matchedPlaceId: c.matchedPlaceId,
    matchedLeadId,
    leadId: c.leadId,
  };
}

/* ------------------------------------------------ sağlayıcı ------------------------------------------------- */

/** Demo kipi: Places sağlayıcısı "mock" ise tüm Faz 5 sağlayıcıları demodur (anahtar gerekmez, ağa çıkılmaz). */
export async function isRegistryDemo(db: Db): Promise<boolean> {
  return (await getSetting(db, "places.provider")) === "mock";
}

/**
 * Canlı istemcilerin HTTP bağımlılıkları (yalnızca testler değiştirir: sahte `fetch`, beklemesiz `sleep`). Üretimde
 * boştur: genel `fetch` ve gerçek bekleme kullanılır.
 */
export const registryHttp: { deps: HttpDeps } = { deps: {} };

const SETTING_KEY = {
  companies_house: "registry.companiesHouse",
  insee: "registry.insee",
} as const;
const SECRET_KEY = {
  companies_house: "registry.companiesHouseKey",
  insee: "registry.inseeKey",
} as const;

export async function providerFor(
  db: Db,
  source: RegistrySource,
  isDemo: boolean,
): Promise<RegistryProvider> {
  if (isDemo)
    return createDemoRegistryProvider(source, { getEpoch: () => getSetting(db, "mock.epoch") });
  const deps = { ...registryHttp.deps, getKey: () => getSecret(SECRET_KEY[source]) };
  return source === "companies_house"
    ? createCompaniesHouseProvider(deps)
    : createInseeProvider(deps);
}

/** Anahtar kayıtlı mı (depo veya `UM_` ortam değişkeni)? Değer okunmaz/döndürülmez. */
async function hasKey(source: RegistrySource): Promise<boolean> {
  return (await secretStatus(SECRET_KEY[source])).set;
}

/** "Sına" düğmesi: demo → ağsız başarı; canlı → tek en küçük yetkili istek. */
export async function testRegistry(
  db: Db,
  source: RegistrySource,
): Promise<{ ok: true; demo: boolean }> {
  const demo = await isRegistryDemo(db);
  if (!demo && !(await hasKey(source)))
    throw new RegistryServiceError("REGISTRY_KEY_MISSING", "Sicil anahtarı girilmemiş.");
  try {
    await (await providerFor(db, source, demo)).test();
  } catch (e) {
    if (e instanceof RegistryProviderError) throw fromProviderError(e);
    throw e;
  }
  return { ok: true, demo };
}

/* ------------------------------------------------ çalışmalar ------------------------------------------------ */

export interface CreateRunInput {
  source: RegistrySource;
  locality?: string;
  codes?: string[];
  windowDays?: number;
}

const ACTIVE_STATUSES = ["queued", "running"] as const;
/** Bu kadar eski olup işi kaybolmuş etkin çalışma "öksüz" sayılır (oluşturma ile iş ekleme arası yarışı dışlar). */
const ORPHAN_GRACE_MS = 60_000;

function isUniqueViolation(e: unknown): boolean {
  const cause = (e as { cause?: unknown })?.cause;
  return /UNIQUE constraint failed/i.test(`${errorMessage(e)} ${cause ? errorMessage(cause) : ""}`);
}

/**
 * Kaynağın etkin çalışması varken işi kuyrukta/çalışır durumda DEĞİLSE (işçi çöktü, iş kalıcı hata verdi ama çalışma
 * kapanamadı) çalışma `failed` yapılır; aksi halde kısmi tekil indeks yeni çalışmayı sonsuza dek engellerdi.
 */
export async function reapOrphanRuns(db: Db, source: RegistrySource, now: number): Promise<number> {
  const active = await db
    .select({ id: registryRuns.id })
    .from(registryRuns)
    .where(
      and(
        eq(registryRuns.source, source),
        inArray(registryRuns.status, [...ACTIVE_STATUSES]),
        lt(registryRuns.createdAt, now - ORPHAN_GRACE_MS),
      ),
    );
  let reaped = 0;
  for (const r of active) {
    const live = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.dedupeKey, `${REGISTRY_FETCH_JOB}:${r.id}`),
          inArray(jobs.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (live.length) continue;
    await failRun(db, r.id, "REGISTRY_UPSTREAM", now);
    reaped++;
  }
  return reaped;
}

export async function createRun(
  db: Db,
  input: CreateRunInput,
  now: number = Date.now(),
): Promise<{ run: RegistryRunDto; jobId: number }> {
  const { source } = input;
  const settings = await getSetting(db, SETTING_KEY[source]);
  const demo = await isRegistryDemo(db);
  const scheme: ActivityScheme =
    source === "companies_house" ? "SIC2007" : (settings as { scheme: ActivityScheme }).scheme;
  if (!isSchemeAvailable(scheme))
    throw new RegistryServiceError(
      "REGISTRY_SCHEME_UNAVAILABLE",
      "NAF 2025 kod tablosu henüz yayımlanmadı.",
    );
  if (!demo) {
    if (!settings.enabled)
      throw new RegistryServiceError("REGISTRY_DISABLED", "Bu sicil kaynağı kapalı.");
    if (!(await hasKey(source)))
      throw new RegistryServiceError("REGISTRY_KEY_MISSING", "Sicil anahtarı girilmemiş.");
  }
  const defaults = "sicCodes" in settings ? settings.sicCodes : settings.nafCodes;
  const codes = [...new Set(input.codes ?? defaults)];
  if (codes.length < 1 || codes.length > 20 || !codes.every((c) => CODE_RE[source].test(c)))
    throw new RegistryServiceError("VALIDATION", "Faaliyet kodları geçersiz.");
  const window = registryWindow(input.windowDays ?? settings.windowDays, now);
  const locality = input.locality?.trim() || null;

  await reapOrphanRuns(db, source, now);
  let row: RunRow;
  try {
    [row] = (await db
      .insert(registryRuns)
      .values({
        source,
        isDemo: demo,
        status: "queued",
        activityScheme: scheme,
        activityCodes: codes,
        windowFrom: window.from,
        windowTo: window.to,
        locality,
        createdAt: now,
      })
      .returning()) as [RunRow];
  } catch (e) {
    if (isUniqueViolation(e))
      throw new RegistryServiceError("REGISTRY_RUN_ACTIVE", "Bu kaynak için çalışma sürüyor.");
    throw e;
  }
  const jobId = await enqueueJob(
    db,
    REGISTRY_FETCH_JOB,
    { runId: row.id },
    { dedupeKey: `${REGISTRY_FETCH_JOB}:${row.id}`, maxAttempts: 3 },
  ).catch(async (e: unknown) => {
    // İş eklenemezse çalışma kuyrukta asılı kalmasın (kısmi tekil indeks kaynağı kilitlerdi).
    await failRun(db, row.id, "REGISTRY_UPSTREAM", now);
    throw e;
  });
  await audit(db, "registry.run_create", "registry_run", row.id, {
    source,
    isDemo: demo,
    scheme,
    codes,
    window,
    locality: locality !== null,
  });
  return { run: toRunDto(row), jobId: jobId! };
}

export async function listRuns(db: Db, limit = 20): Promise<RegistryRunDto[]> {
  const rows = await db
    .select()
    .from(registryRuns)
    .orderBy(desc(registryRuns.createdAt), desc(registryRuns.id))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(toRunDto);
}

export async function getRun(db: Db, id: number): Promise<RegistryRunDto> {
  const [row] = await db.select().from(registryRuns).where(eq(registryRuns.id, id)).limit(1);
  if (!row) throw new RegistryServiceError("NOT_FOUND", "Sicil çalışması bulunamadı.");
  return toRunDto(row);
}

/** Kuyrukta veya çalışan bir `registry.match` işi var mı? (Arayüz "Eşleştiriliyor…" gösterir.) */
export async function isMatchActive(db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, REGISTRY_MATCH_JOB), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return rows.length > 0;
}

export async function enqueueMatch(
  db: Db,
  runId: number | null,
  now: number = Date.now(),
): Promise<{ jobId: number }> {
  if (runId !== null) await getRun(db, runId);
  if (await isMatchActive(db))
    throw new RegistryServiceError("REGISTRY_MATCH_ACTIVE", "Eşleştirme zaten sürüyor.");
  const jobId = await enqueueJob(
    db,
    REGISTRY_MATCH_JOB,
    { runId },
    { dedupeKey: `${REGISTRY_MATCH_JOB}:${runId ?? "all"}:${now}`, maxAttempts: 2 },
  );
  if (jobId === null)
    throw new RegistryServiceError("REGISTRY_MATCH_ACTIVE", "Eşleştirme zaten sürüyor.");
  await audit(db, "registry.match_enqueue", "registry_run", runId ?? undefined, { runId });
  return { jobId };
}

async function failRun(db: Db, runId: number, code: RegistryRunErrorCode, now: number) {
  await db
    .update(registryRuns)
    .set({ status: "failed", errorCode: code, finishedAt: now })
    .where(and(eq(registryRuns.id, runId), inArray(registryRuns.status, [...ACTIVE_STATUSES])));
}

/* ------------------------------------------------ çekme işi ------------------------------------------------- */

const UPSERT_BATCH = 200;
/** Sayfa güvenlik sınırı: 5000 kayıt / 100 = 50 sayfa; sağlayıcı imleci döngüye girerse iş sonsuza dek sürmesin. */
const MAX_PAGES = 60;
const RATE_RETRIES = 3;

function toCompanyRow(
  item: RegistryCompanyInput,
  source: RegistrySource,
  isDemo: boolean,
  runId: number,
  now: number,
) {
  return {
    source,
    isDemo,
    externalId: item.externalId,
    name: item.name,
    tradingName: item.tradingName,
    nameNorm: normaliseName(item.tradingName ?? item.name).slice(0, 300),
    countryCode: item.countryCode,
    activityScheme: item.activityScheme,
    activityCodes: item.activityCodes,
    categoryKey: categoryForCodes(item.activityScheme, item.activityCodes),
    incorporatedOn: item.incorporatedOn,
    postcode: item.postcode,
    locality: item.locality,
    localityNorm: localityKey(item.locality)?.slice(0, 120) ?? null,
    addressLine: item.addressLine,
    registryStatus: item.registryStatus,
    lastRunId: runId,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

/**
 * Bir sayfayı (≤ 200'lük partilerle) `(source, external_id)` üzerinden ekler/günceller. Yeni kayıtlar `pending` başlar;
 * var olanların eşleşme durumu KORUNUR (elle/ret kararları ezilmez). Dönen değer yeni kayıt sayısıdır.
 * İdempotent: aynı sayfa yeniden işlenirse yalnızca `last_seen_at`/`updated_at` değişir.
 */
export async function upsertCompanies(
  db: Db,
  items: readonly RegistryCompanyInput[],
  ctx: { source: RegistrySource; isDemo: boolean; runId: number; now: number },
): Promise<number> {
  const unique = [...new Map(items.map((i) => [i.externalId, i])).values()];
  let created = 0;
  for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
    const batch = unique.slice(i, i + UPSERT_BATCH);
    const existing = await db
      .select({ id: registryCompanies.externalId })
      .from(registryCompanies)
      .where(
        and(
          eq(registryCompanies.source, ctx.source),
          inArray(
            registryCompanies.externalId,
            batch.map((b) => b.externalId),
          ),
        ),
      );
    created += batch.length - existing.length;
    const ex = (col: string) => sql.raw(`excluded.${col}`);
    await db
      .insert(registryCompanies)
      .values(batch.map((b) => toCompanyRow(b, ctx.source, ctx.isDemo, ctx.runId, ctx.now)))
      .onConflictDoUpdate({
        target: [registryCompanies.source, registryCompanies.externalId],
        set: {
          isDemo: ex("is_demo"),
          name: ex("name"),
          tradingName: ex("trading_name"),
          nameNorm: ex("name_norm"),
          activityScheme: ex("activity_scheme"),
          activityCodes: ex("activity_codes"),
          categoryKey: ex("category_key"),
          incorporatedOn: ex("incorporated_on"),
          postcode: ex("postcode"),
          locality: ex("locality"),
          localityNorm: ex("locality_norm"),
          addressLine: ex("address_line"),
          registryStatus: ex("registry_status"),
          lastRunId: ex("last_run_id"),
          lastSeenAt: ex("last_seen_at"),
          updatedAt: ex("updated_at"),
        },
      });
  }
  return created;
}

export interface FetchJobContext {
  shouldStop: () => boolean;
  log: (m: string) => void;
  /** İşin son denemesi mi? (Geçici hatada bile çalışma o zaman `failed` olur.) */
  finalAttempt: boolean;
  /** Testler: sağlayıcıyı doğrudan verir. */
  provider?: RegistryProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function searchWithRateRetry(
  provider: RegistryProvider,
  query: Parameters<RegistryProvider["search"]>[0],
  ctx: FetchJobContext,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.search(query);
    } catch (e) {
      if (
        !(e instanceof RegistryProviderError) ||
        e.code !== "REGISTRY_RATE" ||
        attempt >= RATE_RETRIES
      )
        throw e;
      const wait = e.retryAfterMs ?? 5_000;
      ctx.log(`Sicil hız sınırı: ${Math.round(wait / 1000)} sn bekleniyor.`);
      await (ctx.sleep ?? registryHttp.deps.sleep ?? defaultSleep)(wait);
      if (ctx.shouldStop()) throw new RegistryFetchInterrupted();
    }
  }
}

/**
 * `registry.fetch` işi: kuyrukta → çalışıyor; sağlayıcı sayfa sayfa çekilir, kayıtlar eklenir/güncellenir; bitince
 * `done` ve `registry.match {runId}` kuyruğa alınır. Yetki/anahtar/çok-fazla/bozuk-yanıt hataları kalıcıdır (çalışma
 * `failed`, iş yeniden denenmez); geçici hatalar işi yeniden dener (son denemede çalışma `failed`). Yeniden teslim
 * idempotenttir: bitmiş çalışma yeniden çekilmez, yarım kalan baştan çekilir (upsert).
 */
export async function executeFetch(
  db: Db,
  runId: number,
  ctx: FetchJobContext,
): Promise<"done" | "skipped"> {
  const clock = ctx.now ?? Date.now;
  const [run] = await db.select().from(registryRuns).where(eq(registryRuns.id, runId)).limit(1);
  if (!run || run.status === "done" || run.status === "failed") return "skipped";

  // Yeniden denemede `started_at` korunur: bu çalışmanın İLK denemeden beri eklediği kayıtlar "yeni" sayılır.
  const startedAt = run.startedAt ?? clock();
  if (run.status === "queued")
    await db
      .update(registryRuns)
      .set({ status: "running", startedAt })
      .where(eq(registryRuns.id, runId));
  // Kaynak başına tek etkin çalışma (kısmi tekil indeks) → bu andan sonra ilk kez görülen kayıtlar bu çalışmanındır.
  const countNew = async () => {
    const [r] = await db
      .select({ n: sql<number>`count(*)` })
      .from(registryCompanies)
      .where(
        and(
          eq(registryCompanies.source, run.source),
          sql`${registryCompanies.firstSeenAt} >= ${startedAt}`,
        ),
      );
    return Number(r?.n ?? 0);
  };

  let fetched = 0;
  let created = 0;
  try {
    const provider = ctx.provider ?? (await providerFor(db, run.source, run.isDemo));
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.shouldStop()) throw new RegistryFetchInterrupted();
      const res = await searchWithRateRetry(
        provider,
        {
          scheme: run.activityScheme,
          activityCodes: run.activityCodes,
          incorporatedFrom: run.windowFrom,
          incorporatedTo: run.windowTo,
          locality: run.locality,
          cursor,
        },
        ctx,
      );
      await upsertCompanies(db, res.items, {
        source: run.source,
        isDemo: run.isDemo,
        runId,
        now: clock(),
      });
      fetched += res.items.length;
      created = await countNew();
      await db
        .update(registryRuns)
        .set({ fetchedCount: fetched, newCount: created })
        .where(eq(registryRuns.id, runId));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    // İşçi kapanışı bir hata değildir: çalışma `failed` yapılmaz, iş katmanı denemeyi geri verip yeniden kuyruğa alır.
    if (e instanceof RegistryFetchInterrupted) {
      ctx.log(`Sicil çalışması ${runId}: işçi kapanıyor; sonraki açılışta baştan sürdürülecek.`);
      throw e;
    }
    const code: RegistryRunErrorCode =
      e instanceof RegistryProviderError ? e.code : "REGISTRY_UPSTREAM";
    const permanent = e instanceof RegistryProviderError && PERMANENT_RUN_ERRORS.has(e.code);
    ctx.log(`Sicil çalışması ${runId}: ${code} (${errorMessage(e)})`);
    if (permanent || ctx.finalAttempt) {
      await failRun(db, runId, code, clock());
      throw new PermanentRegistryError(`${code}: ${errorMessage(e)}`);
    }
    throw e;
  }

  // Eşleştirme işi çalışma `done` olmadan ÖNCE kuyruğa alınır: arayüz hiçbir anda "bitti ama eşleştirme yok" görmez
  // (yoklama erken durup eşleşme sonucunu kaçırırdı). İşçi işleri sırayla çalıştırdığı için eşleştirme bu iş bitmeden
  // başlamaz; yeniden denemede tekilleştirme anahtarı ikinci işi engeller.
  await enqueueJob(
    db,
    REGISTRY_MATCH_JOB,
    { runId },
    { dedupeKey: `${REGISTRY_MATCH_JOB}:${runId}:fetch`, maxAttempts: 2 },
  );
  const [pending] = await db
    .select({ n: sql<number>`count(*)` })
    .from(registryCompanies)
    .where(
      and(eq(registryCompanies.lastRunId, runId), eq(registryCompanies.matchStatus, "pending")),
    );
  const finishedAt = clock();
  await db
    .update(registryRuns)
    .set({
      status: "done",
      finishedAt,
      fetchedCount: fetched,
      newCount: created,
      pendingCount: Number(pending?.n ?? 0),
    })
    .where(eq(registryRuns.id, runId));
  ctx.log(`Sicil çalışması ${runId}: ${fetched} kayıt (${created} yeni).`);
  return "done";
}

/** İş katmanı bunu `NonRetryableJobError`'a çevirir (kütüphane iş kayıt defterine bağımlı olmasın). */
export class PermanentRegistryError extends Error {
  override name = "PermanentRegistryError";
}

/** İşçi kapanırken çekme durdu: hata DEĞİLDİR; iş katmanı deneme hakkı harcamadan yeniden kuyruğa alır. */
export class RegistryFetchInterrupted extends Error {
  override name = "RegistryFetchInterrupted";
  constructor() {
    super("İşçi kapanıyor; sicil çekme sonra sürdürülecek.");
  }
}

/* ------------------------------------------------ eşleştirme ------------------------------------------------ */

/** Kayıt dilimi; dilimler arasında olay döngüsüne dönülür (işçinin kalp atışı ve kapanış denetimi aksamaz). */
const MATCH_CHUNK = 500;
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));
const WRITE_CHUNK = 500;

/**
 * Oturum önbelleğinden aday dizinleri (ülke başına). Google adı/adresi YALNIZCA bellekte normalleştirilir; hiçbir yere
 * yazılmaz. Arşivlenmiş lead'ler aday değildir.
 */
export async function loadCandidateIndexes(
  db: Db,
  countries: readonly string[],
): Promise<Map<string, CandidateIndex>> {
  const out = new Map<string, CandidateIndex>();
  if (countries.length === 0) return out;
  const rows = await db
    .select({
      placeId: leads.placeId,
      city: leads.city,
      countryCode: leads.countryCode,
      name: placeCache.name,
      address: placeCache.formattedAddress,
    })
    .from(leads)
    .innerJoin(placeCache, eq(placeCache.placeId, leads.placeId))
    .where(
      and(
        sql`${leads.archivedAt} IS NULL`,
        isNotNull(leads.placeId),
        inArray(leads.countryCode, [...countries]),
      ),
    );
  const byCountry = new Map<string, MatchCandidate[]>();
  for (const r of rows) {
    const cc = r.countryCode!;
    const cand: MatchCandidate = {
      placeId: r.placeId!,
      nameNorm: normaliseName(r.name),
      cityKey: localityKey(r.city),
      postcodeKey: postcodeKeyFromAddress(cc, r.address),
      addressFold: r.address ? foldText(r.address) : "",
    };
    const arr = byCountry.get(cc);
    if (arr) arr.push(cand);
    else byCountry.set(cc, [cand]);
  }
  for (const [cc, cands] of byCountry) out.set(cc, buildCandidateIndex(cands));
  return out;
}

async function writeDecisions(db: Db, decisions: Map<number, MatchDecision>, now: number) {
  const list = [...decisions.entries()].map(([id, d]) => ({
    id,
    s: d.status,
    r: d.reason,
    sc: d.score,
    p: d.placeId,
  }));
  for (let i = 0; i < list.length; i += WRITE_CHUNK) {
    const payload = JSON.stringify(list.slice(i, i + WRITE_CHUNK));
    // Tek ifade (UPDATE … FROM json_each): satır başına sorgu yok. `manual`/`rejected` kararlarına asla dokunulmaz.
    await db.run(sql`
      UPDATE registry_companies SET
        match_status = d.s,
        match_reason = d.r,
        match_score = d.sc,
        matched_place_id = d.p,
        matched_at = CASE WHEN d.s = 'matched' THEN ${now} ELSE NULL END,
        updated_at = ${now}
      FROM (
        SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.s') AS s,
               json_extract(value, '$.r') AS r, json_extract(value, '$.sc') AS sc, json_extract(value, '$.p') AS p
        FROM json_each(${payload})
      ) AS d
      WHERE registry_companies.id = d.id
        AND registry_companies.match_status IN ('pending', 'unmatched', 'matched')`);
  }
}

/**
 * Çalışma sayaçlarını kayıtlardan yeniden hesaplar (tek ifade, `registry_companies_run_idx`).
 *
 * Sayaçlar ANLIK GÖRÜNTÜDÜR: bir kayıt yeniden görüldüğünde `last_run_id` en yeni çalışmaya geçer, bu yüzden
 * `last_run_id` üzerinden sayım yalnızca kaynağının EN YENİ çalışması için eksiksizdir. Yalnızca o (ve `done`) çalışma
 * güncellenir; eski çalışmalar kendi eşleştirmelerinin sonundaki değerleri korur (genel "Yeniden eşleştir" geçmişi
 * 0/0/0'a düşürmez). `runId` verilirse yalnızca o çalışma (en yeniyse) güncellenir.
 */
export async function refreshRunCounts(db: Db, runId: number | null): Promise<void> {
  const c = (statuses: string) =>
    sql.raw(
      `(SELECT count(*) FROM registry_companies c WHERE c.last_run_id = registry_runs.id AND c.match_status IN (${statuses}))`,
    );
  await db.run(sql`
    UPDATE registry_runs SET
      matched_count = ${c("'matched','manual'")},
      unmatched_count = ${c("'unmatched','rejected'")},
      pending_count = ${c("'pending'")}
    WHERE status = 'done'
      AND id IN (SELECT max(r2.id) FROM registry_runs r2 GROUP BY r2.source)
      AND ${runId === null ? sql`1` : sql`id = ${runId}`}`);
}

export interface MatchSummary {
  considered: number;
  matched: number;
  unmatched: number;
  pending: number;
}

/**
 * `registry.match` işi: çalışmanın (veya tümünün) `pending`/`unmatched` kayıtları ile yeri silinmiş `matched` kayıtları
 * oturum önbelleğindeki adaylarla eşleştirilir. `manual`/`rejected` kayıtlara dokunulmaz; zaten bağlı yerler aday
 * değildir (bire bir). Kayıtlar 500'lük kimlik dilimleriyle okunur (dilimler arasında olay döngüsüne dönülür); aday
 * dizini çalışma başına bir kez kurulur. Kendisinden lead oluşturulmuş kayıtlar (`lead_id`) eşleştirilmez: aynı işletme
 * için ikinci (harita) lead'i ile ikili sıra/kampanya oluşmasın; o kaydın lead'i zaten vardır.
 */
export async function runMatch(
  db: Db,
  runId: number | null,
  now: number = Date.now(),
): Promise<MatchSummary> {
  const scope: SQL[] = [
    or(
      inArray(registryCompanies.matchStatus, ["pending", "unmatched"]),
      and(
        eq(registryCompanies.matchStatus, "matched"),
        sql`${registryCompanies.matchedPlaceId} IS NULL`,
      ),
    )!,
    sql`${registryCompanies.leadId} IS NULL`,
  ];
  if (runId !== null) scope.push(eq(registryCompanies.lastRunId, runId));
  const countries = (
    await db
      .selectDistinct({ cc: registryCompanies.countryCode })
      .from(registryCompanies)
      .where(and(...scope))
  ).map((r) => r.cc);
  const indexes = await loadCandidateIndexes(db, countries);
  const taken = new Set(
    (
      await db
        .select({ p: registryCompanies.matchedPlaceId })
        .from(registryCompanies)
        .where(isNotNull(registryCompanies.matchedPlaceId))
    ).map((r) => r.p!),
  );
  const summary: MatchSummary = { considered: 0, matched: 0, unmatched: 0, pending: 0 };
  let afterId = 0;
  for (;;) {
    const rows = await db
      .select({
        id: registryCompanies.id,
        countryCode: registryCompanies.countryCode,
        nameNorm: registryCompanies.nameNorm,
        localityNorm: registryCompanies.localityNorm,
        postcode: registryCompanies.postcode,
        addressLine: registryCompanies.addressLine,
      })
      .from(registryCompanies)
      .where(and(...scope, sql`${registryCompanies.id} > ${afterId}`))
      .orderBy(registryCompanies.id)
      .limit(MATCH_CHUNK);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;
    const subjects: MatchSubject[] = rows.map((r) => ({
      id: r.id,
      countryCode: r.countryCode,
      nameNorm: r.nameNorm,
      localityKey: r.localityNorm,
      postcodeKey: postcodeKey(r.countryCode, r.postcode),
      addressKey: addressKey(r.addressLine),
    }));
    const decisions = assignMatches(subjects, indexes, taken);
    for (const d of decisions.values()) {
      summary.considered++;
      summary[d.status]++;
      if (d.placeId) taken.add(d.placeId);
    }
    await writeDecisions(db, decisions, now);
    if (rows.length < MATCH_CHUNK) break;
    await yieldToEventLoop();
  }
  await refreshRunCounts(db, runId);
  return summary;
}

/* ------------------------------------------------ liste ----------------------------------------------------- */

export const MATCH_FILTERS = ["matched", "unmatched", "pending"] as const;
export type MatchFilter = (typeof MATCH_FILTERS)[number];

export interface CompanyListQuery {
  source?: RegistrySource;
  country?: "GB" | "FR";
  /** Boş = tümü. `matched` elle bağlananları, `unmatched` reddedilenleri de kapsar. */
  match?: MatchFilter[];
  runId?: number;
  q?: string;
  /** Bu lead'e bağlı kayıtlar (eşleşen yeri veya ondan oluşturulan lead). */
  leadId?: number;
  limit?: number;
  cursor?: string | null;
}

export interface CompanyStats {
  total: number;
  matched: number;
  unmatched: number;
  pending: number;
  /** matched / (matched + unmatched + pending), 0..1; kayıt yoksa 0. */
  matchRate: number;
}

const STATUS_GROUP: Record<MatchFilter, CompanyRow["matchStatus"][]> = {
  matched: ["matched", "manual"],
  unmatched: ["unmatched", "rejected"],
  pending: ["pending"],
};

export function encodeCursor(incorporatedOn: string, id: number): string {
  return Buffer.from(`${incorporatedOn}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { inc: string; id: number } | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\|(\d{1,15})$/.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  return m ? { inc: m[1]!, id: Number(m[2]) } : null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function listCompanies(
  db: Db,
  q: CompanyListQuery,
): Promise<{ items: RegistryCompanyDto[]; nextCursor: string | null; stats: CompanyStats }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const base: SQL[] = [];
  if (q.source) base.push(eq(registryCompanies.source, q.source));
  if (q.country) base.push(eq(registryCompanies.countryCode, q.country));
  if (q.runId !== undefined) base.push(eq(registryCompanies.lastRunId, q.runId));
  if (q.q?.trim()) {
    const p = `%${escapeLike(q.q.trim())}%`;
    base.push(
      or(
        sql`${registryCompanies.name} LIKE ${p} ESCAPE '\\'`,
        sql`${registryCompanies.tradingName} LIKE ${p} ESCAPE '\\'`,
      )!,
    );
  }
  if (q.leadId !== undefined)
    base.push(
      or(
        eq(registryCompanies.leadId, q.leadId),
        sql`${registryCompanies.matchedPlaceId} = (SELECT place_id FROM leads WHERE id = ${q.leadId})`,
      )!,
    );
  const filtered = [...base];
  if (q.match?.length)
    filtered.push(
      inArray(
        registryCompanies.matchStatus,
        q.match.flatMap((m) => STATUS_GROUP[m]),
      ),
    );
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) throw new RegistryServiceError("VALIDATION", "Geçersiz sayfa imleci.");
    filtered.push(
      or(
        lt(registryCompanies.incorporatedOn, c.inc),
        and(eq(registryCompanies.incorporatedOn, c.inc), lt(registryCompanies.id, c.id)),
      )!,
    );
  }
  // Eşleşen yerin lead'i aynı sorguda (LEFT JOIN; satır başına sorgu yok). Ad Google'dan gelmez.
  const rows = await db
    .select({ c: registryCompanies, matchedLeadId: leads.id })
    .from(registryCompanies)
    .leftJoin(
      leads,
      and(eq(leads.placeId, registryCompanies.matchedPlaceId), sql`${leads.archivedAt} IS NULL`),
    )
    .where(filtered.length ? and(...filtered) : undefined)
    .orderBy(desc(registryCompanies.incorporatedOn), desc(registryCompanies.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor(last.c.incorporatedOn, last.c.id) : null;

  const groups = await db
    .select({ s: registryCompanies.matchStatus, n: sql<number>`count(*)` })
    .from(registryCompanies)
    .where(base.length ? and(...base) : undefined)
    .groupBy(registryCompanies.matchStatus);
  const count = (f: MatchFilter) =>
    groups.filter((g) => STATUS_GROUP[f].includes(g.s)).reduce((a, g) => a + Number(g.n), 0);
  const stats = {
    matched: count("matched"),
    unmatched: count("unmatched"),
    pending: count("pending"),
  };
  const total = stats.matched + stats.unmatched + stats.pending;
  return {
    items: page.map((r) => toCompanyDto(r.c, r.matchedLeadId ?? null)),
    nextCursor,
    stats: { total, ...stats, matchRate: total ? stats.matched / total : 0 },
  };
}

/* ------------------------------------------------ lead'e dönüştürme ----------------------------------------- */

/**
 * Eşleşmeyen sicil kaydından lead oluşturur (`source='registry'`, yer kimliği yok). Aynı işlemde kayıt `lead_id` alır;
 * ikinci çağrı 409 `REGISTRY_ALREADY_LEAD` (idempotent: aynı lead döner). Kayıt haritadaki bir yerle eşleşmişse
 * 409 `REGISTRY_MATCHED` + o yerin lead'i (kopya lead oluşturulmaz).
 */
export async function promoteToLead(
  db: Db,
  companyId: number,
  now: number = Date.now(),
): Promise<{ leadId: number }> {
  const leadId = await db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(registryCompanies)
      .where(eq(registryCompanies.id, companyId))
      .limit(1);
    if (!c) throw new RegistryServiceError("NOT_FOUND", "Sicil kaydı bulunamadı.");
    if (c.leadId !== null)
      throw new RegistryServiceError("REGISTRY_ALREADY_LEAD", "Bu kayıttan lead oluşturuldu.", {
        leadId: c.leadId,
      });
    if (c.matchedPlaceId !== null) {
      const [l] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.placeId, c.matchedPlaceId), sql`${leads.archivedAt} IS NULL`))
        .limit(1);
      throw new RegistryServiceError("REGISTRY_MATCHED", "Kayıt haritadaki bir yerle eşleşti.", {
        leadId: l?.id ?? null,
      });
    }
    const [lead] = await tx
      .insert(leads)
      .values({
        source: "registry",
        placeId: null,
        displayName: c.tradingName ?? c.name,
        countryCode: c.countryCode,
        city: c.locality,
        categoryKey: c.categoryKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    const linked = await tx
      .update(registryCompanies)
      .set({ leadId: lead!.id, updatedAt: now })
      .where(and(eq(registryCompanies.id, companyId), sql`${registryCompanies.leadId} IS NULL`))
      .returning({ id: registryCompanies.id });
    /* v8 ignore next 2 -- aynı işlem içinde okunan satır değişemez; savunma amaçlı */
    if (linked.length !== 1)
      throw new RegistryServiceError("REGISTRY_ALREADY_LEAD", "Bu kayıttan lead oluşturuldu.");
    await audit(tx, "registry.lead_create", "lead", lead!.id, {
      registryCompanyId: companyId,
      source: c.source,
      isDemo: c.isDemo,
    });
    return lead!.id;
  });
  return { leadId };
}
