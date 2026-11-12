import { and, eq, exists, inArray, ne, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "@/lib/api/http";
import { purgeDemoCampaignData } from "@/lib/campaigns/purge";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { placeCache } from "@/lib/db/cache-schema";
import { apiUsage, leads, placeSnapshots, places, scanSchedules, scans } from "@/lib/db/schema";
import { deleteNotificationsFor } from "@/lib/notifications/service";

export const leadPatchSchema = z
  .object({
    status: z
      .enum([
        "new",
        "enriched",
        "queued",
        "sent",
        "replied",
        "not_interested",
        "customer",
        "do_not_contact",
      ])
      .optional(),
    notes: z.string().max(5000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    language: z.string().max(10).nullable().optional(),
    /** Kendi kaydımız: işletmenin görünen adı (Google adı saklanmadığı için kullanıcı girebilir). */
    displayName: z.string().trim().max(200).nullable().optional(),
    /**
     * Faz 4: "İletişime geçme" kilidini kaldırmak (durumu do_not_contact'tan başka bir değere çevirmek) için açık onay.
     * Yoksa istek 409 `LEAD_UNBLOCK_CONFIRM` ile reddedilir; arayüz onay penceresi gösterip `true` ile yeniden gönderir.
     */
    confirmUnblock: z.literal(true).optional(),
  })
  .strict();

export type LeadPatch = z.infer<typeof leadPatchSchema>;

/**
 * Tek lead'i günceller. `false`: lead yok. Uyum kilidi: durumu `do_not_contact` olan lead'in durumu ancak
 * `confirmUnblock: true` ile değiştirilebilir (yoksa 409 `LEAD_UNBLOCK_CONFIRM`); kaldırma ayrıca `lead.unblocked` olarak
 * denetim kaydına yazılır. Koşul SQL'de de vardır: onay sonrası eşzamanlı bir değişiklik kilidi sessizce açamaz.
 */
export async function patchLead(
  db: Db,
  leadId: number,
  patch: LeadPatch,
  opts: { now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const existing = await db
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!existing[0]) return false;
  const unblocking =
    patch.status !== undefined &&
    patch.status !== "do_not_contact" &&
    existing[0].status === "do_not_contact";
  if (unblocking && patch.confirmUnblock !== true) {
    throw new HttpError(
      409,
      "Bu işletme “İletişime geçme” olarak işaretli. Durumunu değiştirmek için onay vermeniz gerekir.",
      { code: "LEAD_UNBLOCK_CONFIRM" },
    );
  }
  const tags = patch.tags ? [...new Set(patch.tags)] : undefined;
  const updated = await db
    .update(leads)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(tags ? { tags } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName?.trim() || null }
        : {}),
      updatedAt: now,
    })
    .where(
      unblocking || patch.status === undefined || patch.status === "do_not_contact"
        ? eq(leads.id, leadId)
        : // Onaysız durum değişikliği kilitli satıra yazamaz (okuma ile yazma arasındaki yarışa karşı).
          and(eq(leads.id, leadId), ne(leads.status, "do_not_contact")),
    )
    .returning({ id: leads.id });
  if (updated.length === 0) {
    // Okumadan sonra lead silindi veya "İletişime geçme" olarak işaretlendi. Hiçbir alan yazılmadı ve denetim kaydı
    // yazılmaz; arayüz onay penceresini gösterip isteği (notlar dahil) `confirmUnblock` ile yeniden gönderir.
    const still = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!still[0]) return false;
    throw new HttpError(
      409,
      "Bu işletme az önce “İletişime geçme” olarak işaretlendi. Durumunu değiştirmek için onay vermeniz gerekir.",
      { code: "LEAD_UNBLOCK_CONFIRM" },
    );
  }
  if (unblocking) await audit(db, "lead.unblocked", "lead", leadId, { status: patch.status }, now);
  else if (patch.status)
    await audit(db, "lead.status", "lead", leadId, { status: patch.status }, now);
  return true;
}

/**
 * Demo verilerini temizler: demo işletmeler, bunlara ait lead'ler, demo sağlayıcıyla (`mock`) yapılmış taramalar, demo
 * kullanım kayıtları; Faz 4'te ayrıca
 * - çalışmalarının HEPSİ demo olan zamanlamalar (hiç çalışmamış zamanlama kullanıcı ayarıdır, KALIR),
 * - silinen taramalara/zamanlamalara bağlı bildirimler (`deleteNotificationsFor`).
 * Bölge yalnızca ne taraması ne zamanlaması kalmadıysa silinir (zamanlama bölgeye CASCADE ile bağlıdır; aksi halde
 * kullanıcının henüz çalışmamış zamanlaması sessizce silinirdi). Gerçek (Google) kayıtlara dokunulmaz.
 *
 * Önce demo kampanyaları (yalnızca demo posta kutulu) tek işlemde temizlenir; demo ve gerçek kayıtlar birbirine bağlıysa
 * HİÇBİR ŞEY silinmeden `conflict` hatası verilir (bkz. campaigns/purge.ts).
 */
export async function purgeDemoData(db: Db): Promise<{
  places: number;
  scans: number;
  campaigns: number;
  schedules: number;
  notifications: number;
}> {
  const demoCampaigns = await purgeDemoCampaignData(db);
  const demoPlaces = await db
    .select({ id: places.placeId })
    .from(places)
    .where(eq(places.source, "demo"));
  const demoScans = await db.select({ id: scans.id }).from(scans).where(eq(scans.provider, "mock"));
  const scanIds = demoScans.map((s) => s.id);
  // Taramalar silinmeden ÖNCE: en az bir çalışması olan ve gerçek sağlayıcıyla hiç çalışmamış zamanlamalar demo sayılır.
  const demoSchedules = await db
    .select({ id: scanSchedules.id })
    .from(scanSchedules)
    .where(
      and(
        exists(
          db
            .select({ one: sql`1` })
            .from(scans)
            .where(eq(scans.scheduleId, scanSchedules.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(scans)
            .where(and(eq(scans.scheduleId, scanSchedules.id), ne(scans.provider, "mock"))),
        ),
      ),
    );
  const scheduleIds = demoSchedules.map((s) => s.id);
  const notificationsDeleted = await deleteNotificationsFor(db, { scanIds, scheduleIds });
  if (scheduleIds.length) {
    // scans.schedule_id ON DELETE SET NULL; taramaların kendisi aşağıda silinir.
    await db.delete(scanSchedules).where(inArray(scanSchedules.id, scheduleIds));
  }

  if (scanIds.length) {
    await db.delete(placeSnapshots).where(inArray(placeSnapshots.scanId, scanIds));
    await db.delete(scans).where(inArray(scans.id, scanIds)); // scan_units ON DELETE CASCADE
  }
  await db.delete(leads).where(eq(leads.source, "demo"));
  if (demoPlaces.length) {
    for (let i = 0; i < demoPlaces.length; i += 500) {
      await db.delete(placeCache).where(
        inArray(
          placeCache.placeId,
          demoPlaces.slice(i, i + 500).map((p) => p.id),
        ),
      );
    }
  }
  await db.delete(places).where(eq(places.source, "demo"));
  await db.delete(apiUsage).where(eq(apiUsage.provider, "mock"));
  // Kalan zamanlaması olan bölge silinmez (scan_schedules.region_id ON DELETE CASCADE zamanlamayı da silerdi).
  await db.run(
    sql`DELETE FROM regions WHERE id NOT IN (SELECT region_id FROM scans) AND id NOT IN (SELECT region_id FROM scan_schedules)`,
  );
  await audit(db, "demo.purged", undefined, undefined, {
    places: demoPlaces.length,
    scans: scanIds.length,
    campaigns: demoCampaigns.campaigns,
    messages: demoCampaigns.messages,
    schedules: scheduleIds.length,
    notifications: notificationsDeleted,
  });
  return {
    places: demoPlaces.length,
    scans: scanIds.length,
    campaigns: demoCampaigns.campaigns,
    schedules: scheduleIds.length,
    notifications: notificationsDeleted,
  };
}
