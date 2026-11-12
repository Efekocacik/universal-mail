import { and, asc, count, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { budgetStatus } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import {
  campaignLeads,
  campaigns,
  leadEnrichment,
  leads,
  mailboxes,
  messages,
  places,
  regions,
  scanSchedules,
  scans,
  type MailboxStatus,
} from "@/lib/db/schema";
import type { ScanStatus } from "@/lib/domain/types";
import type { Locale } from "@/lib/i18n";
import { EMAIL_FOUND_STATES } from "@/lib/leads/email-states";
import { EMAIL_STATE, LEAD_NOT_ARCHIVED } from "@/lib/leads/query";
import { effectiveMailboxCap, nextUtcDayStart } from "@/lib/mail/scheduler/limits";
import { CONTACTED } from "@/lib/mail/send-service";
import { listNotifications, renderNotification, unreadCount } from "@/lib/notifications";
import { getSettings } from "@/lib/settings";
import { dayKey } from "@/lib/util";
import { dayStart, projectMonthSpend, utcMonth, weekStart } from "./time";

export {
  dayStart,
  defaultTimeZone,
  isValidTimeZone,
  projectMonthSpend,
  utcMonth,
  weekStart,
} from "./time";

/**
 * GÖSTERGE PANELİ okuma modeli (Faz 4, Paket E). Yalnızca OKUR; hiçbir şey yazmaz, Google'a veya posta sağlayıcısına
 * çağrı yapmaz. Her bölüm BAĞIMSIZ hesaplanır: biri başarısız olursa o bölüm `null` döner ve adı `errors` listesine
 * eklenir, diğerleri yine gösterilir (kısmi başarı). Saat dışarıdan verilebilir (`now`), testler gerçek beklemez.
 *
 * Sorgu sayısı satır sayısıyla ORANTILI DEĞİLDİR: her bölüm sabit sayıda gruplu sorgu kullanır ve her liste
 * sınırlıdır (`LIMIT`). Sayaçlar 0004 göçündeki kısmi dizinleri kullanır (`places_new_detected_idx`,
 * `places_opened_detected_idx`, `messages_out_day_idx`, `messages_in_received_idx`, `scan_schedules_due_idx`).
 *
 * Zaman tanımları:
 *  - "Bu hafta": kullanıcının saat dilimindeki Pazartesi 00:00'dan bu yana (`weekStart`).
 *  - "Bugün gönderilen": kullanıcının saat dilimindeki gece yarısından bu yana (`sentAt`). Posta kutusu günlük
 *    sınırları ise UTC gününe göre sayılır (Türkiye'de 03:00); o sayı `sentTodayLimitDay` olarak ayrıca döner.
 *  - "Yanıtlar": insan yanıtları, yani `reply` ve `negative` sınıfları (otomatik yanıt, geri dönme, abonelikten
 *    çıkma sayılmaz). Sınıflandırılmamış (`received`) iletiler yalnızca "incelemede" sayacına girer.
 *  - "Bu ay": UTC ayı (bütçe ayı ile aynı).
 *
 * Gizlilik: işletme adları yalnızca oturum önbelleğinden (`place_cache`) okunur ve bu yanıtta yalnızca bu bilgisayardaki
 * arayüze gider; alıcı e-posta adresi döndürülmez.
 */

export const DASHBOARD_SECTIONS = [
  "counters",
  "queue",
  "budget",
  "newThisWeek",
  "scans",
  "notifications",
] as const;
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

export const NEW_LIST_LIMIT = 8;
export const UPCOMING_SCANS_LIMIT = 5;
export const RECENT_NOTIFICATIONS_LIMIT = 5;
/** E-postası bulunmuş sayılan durumlar: Keşif bağlantısıyla ortak liste (`@/lib/leads/email-states`). */
export { EMAIL_FOUND_STATES };
const ACTIVE_SCAN_STATUSES: ScanStatus[] = ["queued", "running"];
const SEQUENCE_OPEN = ["scheduled", "waiting_next"] as const;

export interface DashboardCounters {
  businesses: number;
  withEmail: number;
  newThisWeek: number;
  openedThisWeek: number;
  activeCampaigns: number;
  pausedCampaigns: number;
  /** Bugün (kullanıcının saat diliminde gece yarısından beri) gönderilen kampanya iletisi. */
  sentToday: number;
  /** Günlük sınır sayacı: UTC gününde gönderilen (posta kutusu tavanları bu sayıyla karşılaştırılır). */
  sentTodayLimitDay: number;
  sentThisMonth: number;
  /** Bu ay gelen insan yanıtları: olumlu/olası (`reply`) ve olumsuz (`negative`). */
  repliesThisMonth: number;
  /** `repliesThisMonth` içindeki olumsuz ("ilgilenmiyorum") yanıtlar. */
  repliesNegative: number;
  /** Alıcıdan gelen ve kullanıcının kararını bekleyen ileti (takipler bu sürede bekler). */
  repliesPendingReview: number;
}

export interface DashboardMailboxQueue {
  id: number;
  label: string;
  provider: string;
  status: MailboxStatus;
  /** Bugün (UTC günü) sayılan kampanya iletisi. */
  used: number;
  /** Bugünkü geçerli tavan (kutu tavanı, ısınma ve profil sınırının küçüğü). */
  cap: number;
  /** Çalışan kampanyalarda bu kutudan sırası gelmiş (zamanı geçmiş veya belirsiz) dizi. */
  dueNow: number;
  /** Çalışan kampanyalarda bu kutudan sırada bekleyen bütün diziler. */
  waiting: number;
  /** Bir sonraki planlı gönderim zamanı (yoksa `null`). Tavan dolduysa en erken yarın (UTC). */
  nextSendAt: number | null;
  capReached: boolean;
  /** Kutu geçici olarak bekletiliyor (kota/429/erişim): bitiş ve kod. */
  backoff: { until: number; code: string } | null;
  reauthorizationRequired: boolean;
}

export interface DashboardBudget {
  month: string;
  provider: string;
  monthlyUsd: number;
  spentUsd: number;
  remainingUsd: number;
  pct: number;
  level: "ok" | "warning" | "blocked";
  projectedUsd: number;
  projectionReliable: boolean;
}

export interface DashboardNewItem {
  leadId: number;
  /** Önbellekteki ad veya kullanıcının verdiği görünen ad; ikisi de yoksa `null` (arayüz "Adı yüklenmedi" der). */
  name: string | null;
  city: string | null;
  countryCode: string | null;
  categoryKey: string | null;
  kind: "opened" | "new";
  detectedAt: number;
}

export interface DashboardScheduleItem {
  id: number;
  regionName: string;
  intervalDays: number;
  nextRunAt: number;
  /** Zamanı geçti ama henüz başlamadı (uygulama kapalıydı veya başka tarama sürüyor). */
  overdue: boolean;
  lastOutcome: string | null;
  lastSkipCode: string | null;
}

export interface DashboardNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  readAt: number | null;
}

export interface DashboardData {
  generatedAt: number;
  timeZone: string;
  weekStart: number;
  /** UTC gün anahtarı ("YYYY-MM-DD"). */
  today: string;
  month: string;
  counters: DashboardCounters | null;
  queue: { mailboxes: DashboardMailboxQueue[]; dueNow: number; waiting: number } | null;
  budget: DashboardBudget | null;
  newThisWeek: { items: DashboardNewItem[]; total: number } | null;
  scans: { active: number; upcoming: DashboardScheduleItem[] } | null;
  notifications: { items: DashboardNotification[]; unread: number } | null;
  errors: DashboardSection[];
  /** Bölüm süreleri (ms); `Server-Timing` başlığı için. */
  timings: Partial<Record<DashboardSection, number>>;
}

export interface DashboardOptions {
  now?: number;
  timeZone?: string;
  locale?: Locale;
  log?: (message: string) => void;
}

interface Ctx {
  db: Db;
  now: number;
  weekStart: number;
  /** Kullanıcının saat dilimindeki bugünün başlangıcı. */
  localDayStart: number;
  today: string;
  month: ReturnType<typeof utcMonth>;
  locale: Locale;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

async function counters(c: Ctx): Promise<DashboardCounters> {
  const { db } = c;
  const monthFirst = `${c.month.key}-01`;
  const nextMonthFirst = dayKey(c.month.end);
  const [leadRow] = await db
    .select({
      businesses: count(),
      withEmail: sql<number>`coalesce(sum(CASE WHEN ${EMAIL_STATE} IN (${sql.join(
        EMAIL_FOUND_STATES.map((s) => sql`${s}`),
        sql`, `,
      )}) THEN 1 ELSE 0 END), 0)`,
    })
    .from(leads)
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .where(LEAD_NOT_ARCHIVED);
  const detected = (col: typeof places.newDetectedAt | typeof places.openedDetectedAt) =>
    db
      .select({ n: count() })
      .from(places)
      .innerJoin(leads, eq(leads.placeId, places.placeId))
      .where(and(gte(col, c.weekStart), LEAD_NOT_ARCHIVED));
  const [newRow] = await detected(places.newDetectedAt);
  const [openedRow] = await detected(places.openedDetectedAt);
  const campaignRows = await db
    .select({ status: campaigns.status, n: count() })
    .from(campaigns)
    .where(inArray(campaigns.status, ["running", "paused"]))
    .groupBy(campaigns.status);
  const outBase = and(
    eq(messages.direction, "out"),
    eq(messages.purpose, "campaign"),
    inArray(messages.status, [...CONTACTED]),
  );
  // Yerel gün ay başından önce başlayabilir (ör. 1'inde TSİ 00:00–03:00): alt sınır ikisinin küçüğüdür.
  const localFirstKey = dayKey(c.localDayStart);
  const fromKey = localFirstKey < monthFirst ? localFirstKey : monthFirst;
  const [sent] = await db
    .select({
      today: sql<number>`coalesce(sum(CASE WHEN ${messages.sentAt} >= ${c.localDayStart} THEN 1 ELSE 0 END), 0)`,
      limitDay: sql<number>`coalesce(sum(CASE WHEN ${messages.sendDay} = ${c.today} THEN 1 ELSE 0 END), 0)`,
      month: sql<number>`coalesce(sum(CASE WHEN ${messages.sendDay} >= ${monthFirst} THEN 1 ELSE 0 END), 0)`,
    })
    .from(messages)
    .where(and(outBase, gte(messages.sendDay, fromKey), lt(messages.sendDay, nextMonthFirst)));
  const [inbound] = await db
    .select({
      replies: sql<number>`coalesce(sum(CASE WHEN ${messages.classification} IN ('reply', 'negative') AND ${messages.receivedAt} >= ${c.month.start} THEN 1 ELSE 0 END), 0)`,
      negative: sql<number>`coalesce(sum(CASE WHEN ${messages.classification} = 'negative' AND ${messages.receivedAt} >= ${c.month.start} THEN 1 ELSE 0 END), 0)`,
      pending: sql<number>`coalesce(sum(CASE WHEN ${messages.status} = 'received' THEN 1 ELSE 0 END), 0)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "in"),
        or(gte(messages.receivedAt, c.month.start), eq(messages.status, "received")),
      ),
    );
  const byStatus = new Map(campaignRows.map((r) => [r.status, num(r.n)]));
  return {
    businesses: num(leadRow?.businesses),
    withEmail: num(leadRow?.withEmail),
    newThisWeek: num(newRow?.n),
    openedThisWeek: num(openedRow?.n),
    activeCampaigns: byStatus.get("running") ?? 0,
    pausedCampaigns: byStatus.get("paused") ?? 0,
    sentToday: num(sent?.today),
    sentTodayLimitDay: num(sent?.limitDay),
    sentThisMonth: num(sent?.month),
    repliesThisMonth: num(inbound?.replies),
    repliesNegative: num(inbound?.negative),
    repliesPendingReview: num(inbound?.pending),
  };
}

async function queue(c: Ctx): Promise<NonNullable<DashboardData["queue"]>> {
  const { db, now } = c;
  const boxes = await db
    .select()
    .from(mailboxes)
    .where(and(ne(mailboxes.status, "disabled"), ne(mailboxes.status, "not_configured")))
    .orderBy(asc(mailboxes.id));
  if (boxes.length === 0) return { mailboxes: [], dueNow: 0, waiting: 0 };
  const ids = boxes.map((b) => b.id);
  const used = await db
    .select({ mailboxId: messages.mailboxId, n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.sendDay, c.today),
        inArray(messages.mailboxId, ids),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        inArray(messages.status, [...CONTACTED]),
      ),
    )
    .groupBy(messages.mailboxId);
  const seqs = await db
    .select({
      mailboxId: campaigns.mailboxId,
      waiting: count(),
      dueNow: sql<number>`coalesce(sum(CASE WHEN ${campaignLeads.nextSendAt} IS NULL OR ${campaignLeads.nextSendAt} <= ${now} THEN 1 ELSE 0 END), 0)`,
      nextAt: sql<
        number | null
      >`min(CASE WHEN ${campaignLeads.nextSendAt} > ${now} THEN ${campaignLeads.nextSendAt} END)`,
    })
    .from(campaignLeads)
    .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
    .where(
      and(
        eq(campaigns.status, "running"),
        inArray(campaigns.mailboxId, ids),
        inArray(campaignLeads.status, [...SEQUENCE_OPEN]),
      ),
    )
    .groupBy(campaigns.mailboxId);
  // Bekleme kayıtları tek ayar satırındadır: bir kez okunur (kutu başına sorgu yok).
  const { "mail.mailboxSendBackoff": backoffs } = await getSettings(db, [
    "mail.mailboxSendBackoff",
  ] as const);
  const usedBy = new Map(used.map((u) => [u.mailboxId, num(u.n)]));
  const seqBy = new Map(seqs.map((s) => [s.mailboxId, s]));
  const rows: DashboardMailboxQueue[] = boxes.map((b) => {
    const cap = effectiveMailboxCap(b, now);
    const usedToday = usedBy.get(b.id) ?? 0;
    const s = seqBy.get(b.id);
    const dueNow = num(s?.dueNow);
    const capReached = usedToday >= cap;
    const b0 = backoffs[String(b.id)];
    const backoff = b0 && b0.until > now ? { until: b0.until, code: b0.code } : null;
    let nextSendAt: number | null = s?.nextAt == null ? null : num(s.nextAt);
    if (dueNow > 0) nextSendAt = now;
    if (nextSendAt !== null && capReached) nextSendAt = Math.max(nextSendAt, nextUtcDayStart(now));
    if (nextSendAt !== null && backoff) nextSendAt = Math.max(nextSendAt, backoff.until);
    return {
      id: b.id,
      label: b.label,
      provider: b.provider,
      status: b.status,
      used: usedToday,
      cap,
      dueNow,
      waiting: num(s?.waiting),
      nextSendAt,
      capReached,
      backoff,
      reauthorizationRequired: b.status === "error" && b.lastError === "reauthorization_required",
    };
  });
  return {
    mailboxes: rows,
    dueNow: rows.reduce((a, r) => a + r.dueNow, 0),
    waiting: rows.reduce((a, r) => a + r.waiting, 0),
  };
}

async function budget(c: Ctx): Promise<DashboardBudget> {
  const s = await getSettings(c.db, ["places.provider", "budget.monthlyUsd"] as const);
  const b = await budgetStatus(c.db, s["places.provider"], s["budget.monthlyUsd"], c.month.key);
  const p = projectMonthSpend(b.spentUsd, c.now);
  return {
    month: b.month,
    provider: b.provider,
    monthlyUsd: b.monthlyUsd,
    spentUsd: b.spentUsd,
    remainingUsd: b.remainingUsd,
    pct: b.pct,
    level: b.level,
    projectedUsd: p.projectedUsd,
    projectionReliable: p.reliable,
  };
}

async function newThisWeek(c: Ctx): Promise<NonNullable<DashboardData["newThisWeek"]>> {
  const { db } = c;
  const detectedAt = sql<number>`max(coalesce(${places.openedDetectedAt}, 0), coalesce(${places.newDetectedAt}, 0))`;
  const where = and(
    LEAD_NOT_ARCHIVED,
    or(gte(places.newDetectedAt, c.weekStart), gte(places.openedDetectedAt, c.weekStart)),
  );
  const rows = await db
    .select({
      leadId: leads.id,
      name: sql<string | null>`coalesce(${placeCache.name}, ${leads.displayName})`,
      city: leads.city,
      countryCode: leads.countryCode,
      categoryKey: leads.categoryKey,
      openedAt: places.openedDetectedAt,
      detectedAt,
    })
    .from(leads)
    .innerJoin(places, eq(places.placeId, leads.placeId))
    .leftJoin(placeCache, eq(placeCache.placeId, leads.placeId))
    .where(where)
    .orderBy(desc(detectedAt), desc(leads.id))
    .limit(NEW_LIST_LIMIT);
  const [total] = await db
    .select({ n: count() })
    .from(leads)
    .innerJoin(places, eq(places.placeId, leads.placeId))
    .where(where);
  return {
    total: num(total?.n),
    items: rows.map((r) => ({
      leadId: r.leadId,
      name: r.name,
      city: r.city,
      countryCode: r.countryCode,
      categoryKey: r.categoryKey,
      kind: r.openedAt !== null && r.openedAt >= c.weekStart ? "opened" : "new",
      detectedAt: num(r.detectedAt),
    })),
  };
}

async function scanSection(c: Ctx): Promise<NonNullable<DashboardData["scans"]>> {
  const { db } = c;
  const [active] = await db
    .select({ n: count() })
    .from(scans)
    .where(inArray(scans.status, ACTIVE_SCAN_STATUSES));
  const upcoming = await db
    .select({
      id: scanSchedules.id,
      regionName: regions.name,
      intervalDays: scanSchedules.intervalDays,
      nextRunAt: scanSchedules.nextRunAt,
      lastOutcome: scanSchedules.lastOutcome,
      lastSkipCode: scanSchedules.lastSkipCode,
    })
    .from(scanSchedules)
    .innerJoin(regions, eq(regions.id, scanSchedules.regionId))
    .where(eq(scanSchedules.enabled, true))
    .orderBy(asc(scanSchedules.nextRunAt), asc(scanSchedules.id))
    .limit(UPCOMING_SCANS_LIMIT);
  return {
    active: num(active?.n),
    upcoming: upcoming.map((u) => ({ ...u, overdue: u.nextRunAt <= c.now })),
  };
}

async function notificationSection(c: Ctx): Promise<NonNullable<DashboardData["notifications"]>> {
  const rows = await listNotifications(c.db, { limit: RECENT_NOTIFICATIONS_LIMIT });
  const unread = await unreadCount(c.db);
  return {
    unread,
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ...renderNotification(r, c.locale),
      url: r.url,
      createdAt: r.createdAt,
      readAt: r.readAt,
    })),
  };
}

/** Gösterge paneli verisi. Hiçbir zaman fırlatmaz: başarısız bölüm `null` olur ve `errors` içinde adı yer alır. */
export async function getDashboard(db: Db, opts: DashboardOptions = {}): Promise<DashboardData> {
  const now = opts.now ?? Date.now();
  const timeZone = opts.timeZone ?? "UTC";
  const c: Ctx = {
    db,
    now,
    weekStart: weekStart(now, timeZone),
    localDayStart: dayStart(now, timeZone),
    today: dayKey(now),
    month: utcMonth(now),
    locale: opts.locale ?? "tr",
  };
  const errors: DashboardSection[] = [];
  const timings: DashboardData["timings"] = {};
  const log = opts.log ?? ((m: string) => console.warn(m));
  // Bölümler SIRAYLA çalışır: tek SQLite bağlantısında paralel okuma kazanç sağlamaz, hata yalıtımı basit kalır.
  async function run<T>(name: DashboardSection, fn: (c: Ctx) => Promise<T>): Promise<T | null> {
    const started = performance.now();
    try {
      return await fn(c);
    } catch (e) {
      errors.push(name);
      // Yalnızca hata adı: SQL metni veya veri günlüğe yazılmaz.
      log(
        `[dashboard] section_failed section=${name} error=${e instanceof Error ? e.name : "unknown"}`,
      );
      return null;
    } finally {
      timings[name] = Math.round((performance.now() - started) * 10) / 10;
    }
  }
  return {
    generatedAt: now,
    timeZone,
    weekStart: c.weekStart,
    today: c.today,
    month: c.month.key,
    counters: await run("counters", counters),
    queue: await run("queue", queue),
    budget: await run("budget", budget),
    newThisWeek: await run("newThisWeek", newThisWeek),
    scans: await run("scans", scanSection),
    notifications: await run("notifications", notificationSection),
    errors,
    timings,
  };
}
