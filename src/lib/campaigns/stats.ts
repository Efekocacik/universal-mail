import { and, count, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { campaignLeads, campaigns, messageOpens, messages } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { CampaignError } from "./errors";

/**
 * Kampanya istatistikleri (Faz 5): A/B konu varyantı başına gönderilen/yanıtlanan/açılan ve açılma özeti. Salt okunur;
 * kampanya başına sabit sayıda gruplu sorgu (dizi sayısından bağımsız, N+1 yok). Sayılar kişisel veri içermez.
 *
 *  - A/B: yalnızca ilk e-posta (adım 0) ve `sent` iletiler, `subject_variant`'a göre. `replied` = dizinin durumu
 *    `replied`. Hiç varyantlı ileti yoksa `ab: null`.
 *  - Açılma: `opens.enabled` ayarın ŞU ANKİ değeri; `liveSupported` bu sürümde her zaman false (açılmalar yalnızca
 *    demo). Açılma verisi kesin değildir (görsel engelleme, otomatik ön yükleme); arayüz bunu belirtir.
 */

export interface VariantStats {
  sent: number;
  replied: number;
  opened: number;
}

export interface CampaignStats {
  ab: { a: VariantStats; b: VariantStats } | null;
  opens: { enabled: boolean; liveSupported: false; sent: number; opened: number };
}

const empty = (): VariantStats => ({ sent: 0, replied: 0, opened: 0 });

export async function getCampaignStats(db: DbExecutor, campaignId: number): Promise<CampaignStats> {
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");

  const sentOut = and(
    eq(messages.campaignId, campaignId),
    eq(messages.direction, "out"),
    eq(messages.purpose, "campaign"),
    eq(messages.status, "sent"),
  );

  // messages_campaign_idx (campaign_id, status) önekini kullanır; açılma ve dizi birincil anahtarla eşlenir.
  const variants = await db
    .select({
      variant: messages.subjectVariant,
      sent: count(),
      replied: sql<number>`sum(case when ${campaignLeads.status} = 'replied' then 1 else 0 end)`,
      opened: sql<number>`sum(case when ${messageOpens.messageId} is not null then 1 else 0 end)`,
    })
    .from(messages)
    .leftJoin(campaignLeads, eq(campaignLeads.id, messages.campaignLeadId))
    .leftJoin(messageOpens, eq(messageOpens.messageId, messages.id))
    .where(and(sentOut, eq(messages.stepIndex, 0), sql`${messages.subjectVariant} is not null`))
    .groupBy(messages.subjectVariant);

  let ab: CampaignStats["ab"] = null;
  if (variants.length > 0) {
    ab = { a: empty(), b: empty() };
    for (const v of variants) {
      if (v.variant !== "a" && v.variant !== "b") continue;
      ab[v.variant] = {
        sent: Number(v.sent),
        replied: Number(v.replied ?? 0),
        opened: Number(v.opened ?? 0),
      };
    }
  }

  const [totals] = await db
    .select({
      sent: count(),
      opened: sql<number>`sum(case when ${messageOpens.messageId} is not null then 1 else 0 end)`,
    })
    .from(messages)
    .leftJoin(messageOpens, eq(messageOpens.messageId, messages.id))
    .where(sentOut);

  const tracking = await getSetting(db, "tracking.opens");
  return {
    ab,
    opens: {
      enabled: tracking.enabled === true,
      liveSupported: false,
      sent: Number(totals?.sent ?? 0),
      opened: Number(totals?.opened ?? 0),
    },
  };
}
