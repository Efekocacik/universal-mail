import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardRoute from "@/app/api/dashboard/route";
import {
  budgetTone,
  clockTime,
  exploreLink,
  formatCount,
  formatUsd,
  queueState,
  relativeTime,
  scheduleState,
  usagePct,
} from "@/features/dashboard/model";
import { recordUsage } from "@/lib/budget";
import { dashboardUrl } from "@/lib/client/dashboard";
import type { DashboardMailboxQueue } from "@/lib/client/dashboard";
import {
  defaultTimeZone,
  getDashboard,
  isValidTimeZone,
  NEW_LIST_LIMIT,
  projectMonthSpend,
  utcMonth,
  weekStart,
} from "@/lib/dashboard";
import type { Db } from "@/lib/db/client";
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
} from "@/lib/db/schema";
import { hashEmail } from "@/lib/compliance/suppression";
import { notify } from "@/lib/notifications";
import { setSetting } from "@/lib/settings";
import { addSequence, createCampaign, DEMO_MAILBOX, seedBase } from "./helpers/campaign-fixture";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 4 / E — gösterge paneli okuma modeli, uç noktası ve saf görünüm mantığı. Geçici SQLite dosyası (gerçek
 * migrasyonlar, oturum önbelleği ekli); `.data` kullanılmaz, ağ yok. Saat dışarıdan verilir.
 */

/** Perşembe 12 Kasım 2026, 10:00 UTC (İstanbul 13:00). */
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);
/** İstanbul'da bu haftanın Pazartesi'si 00:00 = 8 Kasım 21:00 UTC. */
const WEEK_IST = Date.UTC(2026, 10, 8, 21, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ORIGIN = "http://127.0.0.1:3000";

let t: TestDb;
let db: Db;

beforeEach(async () => {
  history = null;
  t = await createTestDb();
  db = t.db;
  await seedBase(db, NOW - 30 * DAY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.cleanup();
});

let seq = 0;
async function addPlaceLead(o: {
  newAt?: number | null;
  openedAt?: number | null;
  name?: string;
  archived?: boolean;
  email?: "found_verified" | "not_found" | null;
}) {
  const placeId = `pl_${++seq}`;
  await db.insert(places).values({
    placeId,
    source: "demo",
    coordsFetchedAt: NOW,
    firstSeenAt: NOW - 20 * DAY,
    newDetectedAt: o.newAt ?? null,
    openedDetectedAt: o.openedAt ?? null,
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW,
  });
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      placeId,
      status: "enriched",
      displayName: o.name ?? null,
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      archivedAt: o.archived ? NOW - DAY : null,
      createdAt: NOW - 20 * DAY,
      updatedAt: NOW,
    })
    .returning({ id: leads.id });
  if (o.email) {
    await db.insert(leadEnrichment).values({
      leadId: l!.id,
      status: "done",
      emailStatus: o.email,
      updatedAt: NOW,
    } as typeof leadEnrichment.$inferInsert);
  }
  return l!.id;
}

/** Gönderim geçmişi için bitmiş bir kampanya ve dizisi (sayaçlara ve sıraya karışmaz). */
let history: { campaignId: number; cl: number } | null = null;
async function historySequence() {
  if (!history) {
    const campaignId = await createCampaign(db, { steps: 1 });
    await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, campaignId));
    const s = await addSequence(db, campaignId);
    await db.update(campaignLeads).set({ status: "completed" }).where(eq(campaignLeads.id, s.cl));
    history = { campaignId, cl: s.cl };
  }
  return history;
}

async function outMessage(o: {
  mailboxId?: number;
  sendDay: string;
  status?: "sent" | "failed" | "unknown";
  at?: number;
}) {
  const h = await historySequence();
  const email = `info@m${++seq}.example`;
  await db.insert(messages).values({
    direction: "out",
    purpose: "campaign",
    campaignId: h.campaignId,
    campaignLeadId: h.cl,
    idempotencyKey: `test:${seq}`,
    toAddress: email,
    mailboxId: o.mailboxId ?? DEMO_MAILBOX,
    peerHash: hashEmail(email),
    peerDomain: `m${seq}.example`,
    sendDay: o.sendDay,
    status: o.status ?? "sent",
    createdAt: o.at ?? NOW,
    sentAt: o.at ?? NOW,
  });
}

async function inMessage(o: {
  status: "received" | "matched";
  classification?: "reply";
  at: number;
}) {
  await db.insert(messages).values({
    direction: "in",
    purpose: "inbound",
    mailboxId: DEMO_MAILBOX,
    peerHash: hashEmail(`x${++seq}@in.example`),
    peerDomain: "in.example",
    status: o.status,
    classification: o.classification ?? null,
    createdAt: o.at,
    receivedAt: o.at,
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe("zaman yardımcıları", () => {
  it("hafta başlangıcı kullanıcının saat diliminde Pazartesi 00:00'dır", () => {
    expect(weekStart(NOW, "Europe/Istanbul")).toBe(WEEK_IST);
    expect(weekStart(NOW, "UTC")).toBe(Date.UTC(2026, 10, 9));
    // Pazartesi gece yarısından hemen sonra yine aynı gün.
    expect(weekStart(WEEK_IST + 1000, "Europe/Istanbul")).toBe(WEEK_IST);
    // Pazar günü bir önceki Pazartesi.
    expect(weekStart(Date.UTC(2026, 10, 15, 12), "UTC")).toBe(Date.UTC(2026, 10, 9));
    // Yaz saati: Londra 30 Mart 2026 Pazartesi 00:00 BST = 29 Mart 23:00 UTC.
    expect(weekStart(Date.UTC(2026, 3, 1, 12), "Europe/London")).toBe(Date.UTC(2026, 2, 29, 23));
  });

  it("saat dilimi doğrulaması ve varsayılan", () => {
    expect(isValidTimeZone("Europe/Istanbul")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("a b")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
    expect(isValidTimeZone(defaultTimeZone())).toBe(true);
  });

  it("UTC ayı ve harcama tahmini", () => {
    expect(utcMonth(NOW)).toMatchObject({ key: "2026-11", days: 30, start: Date.UTC(2026, 10, 1) });
    const p = projectMonthSpend(11, NOW);
    expect(p.reliable).toBe(true);
    expect(p.elapsedDays).toBe(11);
    expect(p.projectedUsd).toBeCloseTo((11 / (11 + 10 / 24)) * 30, 1);
    expect(projectMonthSpend(2, Date.UTC(2026, 10, 1, 12))).toMatchObject({
      projectedUsd: 2,
      reliable: false,
    });
  });
});

describe("getDashboard: sayaçlar", () => {
  it("boş veritabanında sıfırlar ve boş listeler; hiçbir bölüm hata vermez", async () => {
    const d = await getDashboard(db, { now: NOW, timeZone: "Europe/Istanbul" });
    expect(d.errors).toEqual([]);
    expect(d).toMatchObject({ weekStart: WEEK_IST, today: "2026-11-12", month: "2026-11" });
    expect(d.counters).toEqual({
      businesses: 0,
      withEmail: 0,
      newThisWeek: 0,
      openedThisWeek: 0,
      activeCampaigns: 0,
      pausedCampaigns: 0,
      sentToday: 0,
      sentThisMonth: 0,
      repliesThisMonth: 0,
      repliesPendingReview: 0,
    });
    expect(d.newThisWeek).toEqual({ items: [], total: 0 });
    expect(d.scans).toEqual({ active: 0, upcoming: [] });
    expect(d.notifications).toEqual({ items: [], unread: 0 });
    expect(Object.keys(d.timings).sort()).toEqual(
      ["budget", "counters", "newThisWeek", "notifications", "queue", "scans"].sort(),
    );
  });

  it("işletme, e-posta, bu hafta yeni/açılan (arşiv hariç); gönderim ve yanıt sayıları", async () => {
    await addPlaceLead({ email: "found_verified" });
    await addPlaceLead({ email: "not_found" });
    await addPlaceLead({ newAt: WEEK_IST + HOUR });
    await addPlaceLead({ newAt: WEEK_IST - HOUR }); // geçen hafta
    await addPlaceLead({ openedAt: NOW - HOUR });
    await addPlaceLead({ openedAt: NOW - HOUR, archived: true, email: "found_verified" });

    await createCampaign(db, { steps: 1 });
    await createCampaign(db, { steps: 1, status: "paused" });

    await outMessage({ sendDay: "2026-11-12" });
    await outMessage({ sendDay: "2026-11-12", status: "unknown" });
    await outMessage({ sendDay: "2026-11-12", status: "failed" }); // sayılmaz
    await outMessage({ sendDay: "2026-11-03" });
    await outMessage({ sendDay: "2026-10-31" }); // geçen ay

    await inMessage({ status: "matched", classification: "reply", at: NOW - DAY });
    await inMessage({ status: "matched", classification: "reply", at: Date.UTC(2026, 9, 20) });
    await inMessage({ status: "received", at: Date.UTC(2026, 9, 25) });

    const d = await getDashboard(db, { now: NOW, timeZone: "Europe/Istanbul" });
    // 5 işletme + gönderim geçmişi fikstürünün yeri olmayan lead'i; arşivlenen sayılmaz.
    expect(d.counters).toEqual({
      businesses: 6,
      withEmail: 1,
      newThisWeek: 1,
      openedThisWeek: 1,
      activeCampaigns: 1,
      pausedCampaigns: 1,
      sentToday: 2,
      sentThisMonth: 3,
      repliesThisMonth: 1,
      repliesPendingReview: 1,
    });
  });
});

describe("getDashboard: gönderim sırası", () => {
  it("kutu başına kullanım, tavan, sıradaki gönderim; kapalı ve yapılandırılmamış kutular listelenmez", async () => {
    await db.insert(mailboxes).values([
      { provider: "gmail", label: "Kapalı", status: "disabled", createdAt: NOW, updatedAt: NOW },
      { provider: "gmail", label: "Hazır değil", createdAt: NOW, updatedAt: NOW },
    ]);
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c, { nextSendAt: null });
    await addSequence(db, c, { nextSendAt: NOW + 2 * HOUR });
    await addSequence(db, c, { nextSendAt: NOW + 5 * HOUR });
    const paused = await createCampaign(db, { steps: 1, status: "paused" });
    await addSequence(db, paused, { nextSendAt: null }); // duraklatılmış kampanya sayılmaz
    await outMessage({ sendDay: "2026-11-12" });
    await outMessage({ sendDay: "2026-11-11" });

    const d = await getDashboard(db, { now: NOW, timeZone: "UTC" });
    expect(d.queue!.mailboxes).toHaveLength(1);
    const [m] = d.queue!.mailboxes;
    expect(m).toMatchObject({
      id: DEMO_MAILBOX,
      used: 1,
      dueNow: 1,
      waiting: 3,
      nextSendAt: NOW,
      capReached: false,
      backoff: null,
      reauthorizationRequired: false,
    });
    expect(m!.cap).toBeGreaterThan(0);
    expect(d.queue).toMatchObject({ dueNow: 1, waiting: 3 });

    // Sırası gelen yoksa en yakın planlı zaman.
    await db
      .update(campaignLeads)
      .set({ nextSendAt: NOW + 2 * HOUR })
      .where(isNull(campaignLeads.nextSendAt));
    const [later] = (await getDashboard(db, { now: NOW })).queue!.mailboxes;
    expect(later).toMatchObject({ dueNow: 0, nextSendAt: NOW + 2 * HOUR });
  });

  it("tavan dolunca sonraki gönderim yarına, kutu beklemesindeyse bekleme bitişine kayar", async () => {
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c, { nextSendAt: NOW + HOUR });
    await db.update(mailboxes).set({ dailyCap: 1 }).where(eq(mailboxes.id, DEMO_MAILBOX));
    await outMessage({ sendDay: "2026-11-12" });
    let [m] = (await getDashboard(db, { now: NOW })).queue!.mailboxes;
    expect(m).toMatchObject({ capReached: true, nextSendAt: Date.UTC(2026, 10, 13) });

    await db.update(mailboxes).set({ dailyCap: 20 }).where(eq(mailboxes.id, DEMO_MAILBOX));
    await setSetting(db, "mail.mailboxSendBackoff", {
      [String(DEMO_MAILBOX)]: { until: NOW + 3 * HOUR, code: "rate_limited", at: NOW },
      "99": { until: NOW - HOUR, code: "rate_limited", at: NOW - 2 * HOUR },
    });
    [m] = (await getDashboard(db, { now: NOW })).queue!.mailboxes;
    expect(m).toMatchObject({
      capReached: false,
      backoff: { until: NOW + 3 * HOUR, code: "rate_limited" },
      nextSendAt: NOW + 3 * HOUR,
    });
  });

  it("yeniden bağlanması gereken kutu işaretlenir; kutu yoksa boş liste", async () => {
    await db
      .update(mailboxes)
      .set({ status: "error", lastError: "reauthorization_required" })
      .where(eq(mailboxes.id, DEMO_MAILBOX));
    const [m] = (await getDashboard(db, { now: NOW })).queue!.mailboxes;
    expect(m).toMatchObject({ reauthorizationRequired: true, waiting: 0, nextSendAt: null });
    await db.update(mailboxes).set({ status: "disabled" });
    expect((await getDashboard(db, { now: NOW })).queue).toEqual({
      mailboxes: [],
      dueNow: 0,
      waiting: 0,
    });
  });
});

describe("getDashboard: bütçe, yeni işletmeler, taramalar, bildirimler", () => {
  it("bütçe durumu ve ay sonu tahmini", async () => {
    await setSetting(db, "places.provider", "google");
    await setSetting(db, "budget.monthlyUsd", 10);
    // Ücretsiz kotayı aşan çağrılar maliyet üretir.
    await recordUsage(db, "google", "text_search_pro", 6000, Date.UTC(2026, 10, 2));
    const b = (await getDashboard(db, { now: NOW })).budget!;
    expect(b).toMatchObject({ month: "2026-11", provider: "google", monthlyUsd: 10 });
    expect(b.spentUsd).toBeGreaterThan(0);
    expect(b.projectionReliable).toBe(true);
    expect(b.projectedUsd).toBeGreaterThan(b.spentUsd);
  });

  it("bu hafta yeni/açılan listesi: en yeni önce, sınırlı, arşiv hariç, ad önbellekten veya görünen addan", async () => {
    for (let i = 0; i < NEW_LIST_LIMIT + 2; i++) {
      await addPlaceLead({ newAt: WEEK_IST + (i + 1) * 60_000, name: `İşletme ${i}` });
    }
    const opened = await addPlaceLead({ openedAt: NOW - 1000, newAt: WEEK_IST + 1000 });
    await addPlaceLead({ openedAt: NOW - 500, archived: true });
    await addPlaceLead({ newAt: WEEK_IST - 1 });
    const d = await getDashboard(db, { now: NOW, timeZone: "Europe/Istanbul" });
    expect(d.newThisWeek!.total).toBe(NEW_LIST_LIMIT + 3);
    expect(d.newThisWeek!.items).toHaveLength(NEW_LIST_LIMIT);
    expect(d.newThisWeek!.items[0]).toMatchObject({
      leadId: opened,
      kind: "opened",
      name: null,
      detectedAt: NOW - 1000,
      countryCode: "GB",
    });
    expect(d.newThisWeek!.items[1]).toMatchObject({
      kind: "new",
      name: `İşletme ${NEW_LIST_LIMIT + 1}`,
    });
  });

  it("aktif taramalar ve yaklaşan planlı taramalar (en yakın önce, kapalılar hariç)", async () => {
    const [r] = await db
      .insert(regions)
      .values({
        name: "Londra",
        kind: "bbox",
        geometry: { bbox: { south: 51.4, west: -0.2, north: 51.6, east: 0.1 } },
        createdAt: NOW,
      })
      .returning({ id: regions.id });
    const sched = (key: string, nextRunAt: number, enabled = true) => ({
      regionId: r!.id,
      scanKey: key,
      categorySetIds: [1],
      strategy: "text" as const,
      fieldProfile: "discovery" as const,
      intervalDays: 7 as const,
      enabled,
      nextRunAt,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db
      .insert(scanSchedules)
      .values([sched("a", NOW + 2 * DAY), sched("b", NOW - HOUR), sched("c", NOW + DAY, false)]);
    await db
      .update(scanSchedules)
      .set({ lastOutcome: "skipped", lastSkipCode: "BUDGET_BLOCKED" })
      .where(eq(scanSchedules.scanKey, "a"));
    await db.insert(scans).values({
      regionId: r!.id,
      scanKey: "manual",
      categorySetIds: [1],
      queries: [],
      strategy: "text",
      fieldProfile: "discovery",
      provider: "mock",
      status: "running",
      createdAt: NOW,
    });
    const s = (await getDashboard(db, { now: NOW })).scans!;
    expect(s.active).toBe(1);
    expect(s.upcoming.map((u) => [u.regionName, u.overdue, u.lastSkipCode])).toEqual([
      ["Londra", true, null],
      ["Londra", false, "BUDGET_BLOCKED"],
    ]);
  });

  it("son bildirimler istenen dilde; okunmamış sayısı", async () => {
    await notify(
      db,
      {
        kind: "scan.done",
        dedupeKey: "scan.done:1",
        params: { n: 3, region: "Londra" },
        url: "/scans",
      },
      { now: NOW - HOUR },
    );
    await notify(
      db,
      {
        kind: "place.opened",
        dedupeKey: "place.opened:watch:2026-11-12",
        params: { n: 2 },
        url: "/",
      },
      { now: NOW },
    );
    const tr = (await getDashboard(db, { now: NOW, locale: "tr" })).notifications!;
    const en = (await getDashboard(db, { now: NOW, locale: "en" })).notifications!;
    expect(tr.unread).toBe(2);
    expect(tr.items.map((i) => i.kind)).toEqual(["place.opened", "scan.done"]);
    expect(tr.items[0]).toMatchObject({ url: "/", readAt: null, createdAt: NOW });
    expect(tr.items[0]!.title).not.toBe(en.items[0]!.title);
    expect(tr.items[0]!.title.length).toBeGreaterThan(0);
  });
});

describe("getDashboard: kısmi başarısızlık", () => {
  it("bir bölüm hata verirse yalnızca o bölüm null olur; günlükte veri yok", async () => {
    const logs: string[] = [];
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          const real = Reflect.get(target, prop, receiver) as Db["select"];
          return (...args: Parameters<Db["select"]>) => {
            const fields = args[0] as Record<string, unknown> | undefined;
            if (fields && "regionName" in fields) throw new TypeError("info@secret.example");
            return real.apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const d = await getDashboard(broken, { now: NOW, log: (m) => logs.push(m) });
    expect(d.errors).toEqual(["scans"]);
    expect(d.scans).toBeNull();
    expect(d.counters).not.toBeNull();
    expect(d.notifications).not.toBeNull();
    expect(logs).toEqual(["[dashboard] section_failed section=scans error=TypeError"]);
  });

  it("varsayılan günlükleyici console.warn kullanır", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      select: () => {
        throw new Error("x");
      },
    } as unknown as Db;
    const d = await getDashboard(broken, { now: NOW });
    expect(d.errors.length).toBe(6);
    expect(warn).toHaveBeenCalled();
  });
});

describe("GET /api/dashboard", () => {
  const get = (qs = "") =>
    dashboardRoute.GET(new Request(`${ORIGIN}/api/dashboard${qs}`), undefined);

  it("bölümlü yanıt, önbelleksiz ve Server-Timing başlıklı", async () => {
    const res = await get("?tz=Europe/Istanbul&locale=en");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("server-timing")).toMatch(/counters;dur=/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("timings");
    expect(body).toMatchObject({ timeZone: "Europe/Istanbul", errors: [] });
  });

  it("bilinmeyen parametre veya geçersiz saat dilimi 400 INVALID_QUERY", async () => {
    for (const qs of ["?tz=Mars/Base", "?foo=1", "?locale=de"]) {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_QUERY" });
    }
  });

  it("istemci adresi dil ve saat dilimini taşır", () => {
    expect(dashboardUrl("tr", "Europe/Istanbul")).toBe(
      "/api/dashboard?locale=tr&tz=Europe%2FIstanbul",
    );
    expect(dashboardUrl("en", null)).toBe("/api/dashboard?locale=en");
  });
});

describe("gösterge paneli görünüm mantığı", () => {
  const base: DashboardMailboxQueue = {
    id: 1,
    label: "Demo",
    provider: "demo",
    status: "connected",
    used: 3,
    cap: 20,
    dueNow: 0,
    waiting: 0,
    nextSendAt: null,
    capReached: false,
    backoff: null,
    reauthorizationRequired: false,
  };

  it("Keşif bağlantıları", () => {
    expect(exploreLink("opened", WEEK_IST)).toBe(`/?lifecycle=opened&detectedSince=${WEEK_IST}`);
    expect(exploreLink("new")).toBe("/?lifecycle=new");
    expect(exploreLink("future", -1)).toBe("/?lifecycle=future");
  });

  it("kutu satırı durumu önceliği", () => {
    expect(queueState(base, NOW)).toEqual({ kind: "idle" });
    expect(queueState({ ...base, waiting: 2, nextSendAt: NOW + HOUR }, NOW)).toEqual({
      kind: "next",
      at: NOW + HOUR,
    });
    expect(queueState({ ...base, waiting: 2, dueNow: 2, nextSendAt: NOW }, NOW)).toEqual({
      kind: "due",
      n: 2,
    });
    expect(
      queueState({ ...base, waiting: 2, capReached: true, nextSendAt: NOW + DAY }, NOW),
    ).toEqual({
      kind: "capReached",
      until: NOW + DAY,
    });
    expect(
      queueState(
        { ...base, waiting: 2, capReached: true, backoff: { until: NOW + HOUR, code: "x" } },
        NOW,
      ),
    ).toEqual({ kind: "backoff", until: NOW + HOUR });
    expect(queueState({ ...base, backoff: { until: NOW - 1, code: "x" } }, NOW)).toEqual({
      kind: "idle",
    });
    expect(queueState({ ...base, reauthorizationRequired: true }, NOW)).toEqual({ kind: "reauth" });
  });

  it("yüzde, ton, tarama durumu ve biçimlendirme", () => {
    expect(usagePct(5, 20)).toBe(25);
    expect(usagePct(30, 20)).toBe(100);
    expect(usagePct(1, 0)).toBe(0);
    expect(budgetTone("ok")).toBe("primary");
    expect(budgetTone("warning")).toBe("warning");
    expect(budgetTone("blocked")).toBe("danger");
    const s = {
      id: 1,
      regionName: "x",
      intervalDays: 7,
      nextRunAt: NOW,
      lastOutcome: null,
      lastSkipCode: null,
    };
    expect(scheduleState({ ...s, overdue: true })).toBe("overdue");
    expect(scheduleState({ ...s, overdue: false, lastOutcome: "skipped" })).toBe("skipped");
    expect(scheduleState({ ...s, overdue: false })).toBe("ok");
    expect(relativeTime(NOW + 3 * HOUR, NOW, "en")).toBe("in 3 hours");
    expect(relativeTime(NOW - DAY, NOW, "en")).toBe("yesterday");
    expect(relativeTime(NOW + 10_000, NOW, "en")).toBe("this minute");
    expect(relativeTime(NOW + 5 * 60_000, NOW, "tr")).toMatch(/5 dakika/);
    expect(clockTime(NOW, "tr")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatCount(12345, "tr")).toBe("12.345");
    expect(formatUsd(3.5, "en")).toBe("US$3.50");
  });
});
