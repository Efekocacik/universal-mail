import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { purgeDemoCampaignData } from "@/lib/campaigns/purge";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { placeCache } from "@/lib/db/cache-schema";
import { apiUsage, leads, placeSnapshots, places, scans } from "@/lib/db/schema";

export const leadPatchSchema = z.object({
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
});

export type LeadPatch = z.infer<typeof leadPatchSchema>;

export async function patchLead(db: Db, leadId: number, patch: LeadPatch): Promise<boolean> {
  const existing = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!existing[0]) return false;
  const tags = patch.tags ? [...new Set(patch.tags)] : undefined;
  await db
    .update(leads)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(tags ? { tags } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName?.trim() || null }
        : {}),
      updatedAt: Date.now(),
    })
    .where(eq(leads.id, leadId));
  if (patch.status) await audit(db, "lead.status", "lead", leadId, { status: patch.status });
  return true;
}

/**
 * Demo verilerini siler: demo işletmeler, bunlara ait lead'ler, demo sağlayıcıyla yapılmış taramalar ve
 * demo kullanım kayıtları. Gerçek (Google) kayıtlara dokunulmaz.
 */
/**
 * Demo verilerini temizler. Önce demo kampanyaları (yalnızca demo posta kutulu) tek işlemde temizlenir; demo ve gerçek
 * kayıtlar birbirine bağlıysa HİÇBİR ŞEY silinmeden `conflict` hatası verilir (bkz. campaigns/purge.ts).
 */
export async function purgeDemoData(
  db: Db,
): Promise<{ places: number; scans: number; campaigns: number }> {
  const demoCampaigns = await purgeDemoCampaignData(db);
  const demoPlaces = await db
    .select({ id: places.placeId })
    .from(places)
    .where(eq(places.source, "demo"));
  const demoScans = await db.select({ id: scans.id }).from(scans).where(eq(scans.provider, "mock"));
  const scanIds = demoScans.map((s) => s.id);

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
  await db.run(sql`DELETE FROM regions WHERE id NOT IN (SELECT region_id FROM scans)`);
  await audit(db, "demo.purged", undefined, undefined, {
    places: demoPlaces.length,
    scans: scanIds.length,
    campaigns: demoCampaigns.campaigns,
    messages: demoCampaigns.messages,
  });
  return { places: demoPlaces.length, scans: scanIds.length, campaigns: demoCampaigns.campaigns };
}
