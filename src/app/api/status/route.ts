import { desc, inArray, sql } from "drizzle-orm";
import { json, route, database } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { budgetStatus } from "@/lib/budget";
import { jobs, scans } from "@/lib/db/schema";
import { unreadCount } from "@/lib/notifications";
import { scheduleSummary } from "@/lib/scan/schedule";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Üst çubuk için özet: bütçe, sürmekte olan/yarım kalan taramalar, kuyruk, okunmamış bildirimler. Düzenli yoklanır. */
export const GET = route(async () => {
  const db = await database();
  const settings = await getSettings(db, ["places.provider", "budget.monthlyUsd"] as const);
  const [budget, setup] = await Promise.all([
    budgetStatus(db, settings["places.provider"], settings["budget.monthlyUsd"]),
    getSetupState(db),
  ]);
  const active = await db
    .select({
      id: scans.id,
      status: scans.status,
      progress: scans.progress,
      pauseReason: scans.pauseReason,
      provider: scans.provider,
    })
    .from(scans)
    .where(inArray(scans.status, ["queued", "running", "paused", "budget_stopped"]))
    .orderBy(desc(scans.id))
    .limit(10);
  const queued = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  return json({
    provider: settings["places.provider"],
    setupCompleted: setup.completed,
    budget,
    scans: active,
    pendingJobs: Number(queued[0]?.n ?? 0),
    /** Faz 4: zil rozeti (okunmamış bildirim sayısı; kısmi indeksli ucuz sayım). */
    unreadNotifications: await unreadCount(db),
    /** Faz 4: etkin zamanlamalar, zamanı gelmiş olanlar ve en yakın çalışma (gösterge paneli "yaklaşan"). */
    schedules: await scheduleSummary(db, Date.now()),
  });
});
