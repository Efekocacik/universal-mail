import { and, eq, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { businessDomainOf } from "@/lib/compliance/eligibility";
import type { DbExecutor } from "@/lib/db/client";
import { campaignLeads, type CampaignLeadStatus, type SequenceStopReason } from "@/lib/db/schema";
import { ARF_COMPLAINT_CODE, BUSINESS_COMPLAINT_CODE } from "./complaint";

/**
 * Çıkış ve şikâyet yollarının ORTAK dizi durdurma çekirdeği (Aşama 15.10-2: TB-2, TB-10, TB-11(d)).
 *
 * Kullananlar: gelen ileti işleme (çıkış/şikâyet), inceleme kararı, demo çıkış bağlantısı ve RFC 8058 tek tıklamalı
 * çıkış. Hepsi çağıranın İŞLEMİ içinde çalışır (engel + durdurma + denetim birlikte kalıcı olur ya da hiçbiri).
 *
 * Kurallar:
 *  - Süren dizi (`pending`, `scheduled`, `waiting_next`) durur: `status = 'unsubscribed'`, `stop_reason` yazılır,
 *    `next_send_at` boşaltılır. (`in_flight` gönderim ortasındadır; dokunulmaz — sonucu kaydedildikten sonra bir
 *    sonraki adım engel denetimine takılır.)
 *  - TB-10: `completed` dizi DURUMUNU KORUR; yalnızca `stop_reason` kaydedilir (gönderim zaten bitmişti).
 *  - Şikâyet çıkıştan ağırdır: aynı dizi önce çıkış, sonra şikâyet görürse neden `complaint`'e yükseltilir (yalnızca
 *    `completed`/`unsubscribed` satırlarda; durum değişmez). Tersi (şikâyetten sonra çıkış) nedeni değiştirmez.
 *  - Çift yazım: şikâyet nedeni yazılan her satırda `exclusion_reasons` içinde `"arf_complaint"` bulunur (geri alma
 *    sözleşmesi). İşaret zaten varsa yinelenmez; diğer gerekçeler korunur.
 *  - Yeniden çalıştırma aynı sonucu verir (koşullu, sabit değer yazımı; artırım yok): tekrar teslim edilen olay
 *    ikinci kez durdurmaz ve ikinci kez işaret eklemez.
 */

export const STOPPABLE: readonly CampaignLeadStatus[] = ["pending", "scheduled", "waiting_next"];

export type StopTarget = { campaignLeadId: number } | { recipientHash: string };

export interface StopResult {
  /** Bu çağrıda durdurulan (`unsubscribed`'a geçen) diziler. */
  stopped: number[];
  /** Durumu korunup yalnızca nedeni kaydedilen/yükseltilen diziler (TB-10: `completed`; şikâyette `unsubscribed`). */
  annotated: number[];
}

function targetSql(t: StopTarget): SQL {
  return "campaignLeadId" in t
    ? eq(campaignLeads.id, t.campaignLeadId)
    : eq(campaignLeads.recipientHash, t.recipientHash);
}

/** `exclusion_reasons` JSON dizisine verilen kodları (yoksa) sona ekleyen ifade; geçersiz JSON yeni diziyle değişir. */
export function appendReasonsSql(codes: readonly string[]): SQL {
  let expr: SQL = sql`${campaignLeads.exclusionReasons}`;
  for (const code of codes) {
    expr = sql`CASE WHEN EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value = ${code}) THEN ${expr} ELSE json_insert(${expr}, '$[#]', ${code}) END`;
  }
  return sql`CASE WHEN json_valid(${campaignLeads.exclusionReasons}) THEN ${expr} ELSE ${JSON.stringify(codes)} END`;
}

export async function stopSequences(
  tx: DbExecutor,
  target: StopTarget,
  reason: SequenceStopReason,
  now: number,
): Promise<StopResult> {
  const complaint = reason === "complaint";
  const markers = complaint ? { exclusionReasons: appendReasonsSql([ARF_COMPLAINT_CODE]) } : {};
  const stopped = await tx
    .update(campaignLeads)
    .set({
      status: "unsubscribed",
      stopReason: reason,
      nextSendAt: null,
      updatedAt: now,
      ...markers,
    })
    .where(and(targetSql(target), inArray(campaignLeads.status, [...STOPPABLE])))
    .returning({ id: campaignLeads.id });

  // Durumu korunacak satırlar: `completed` (nedeni yoksa) ve şikâyette nedeni henüz `complaint` olmayan
  // `completed`/`unsubscribed` satırlar.
  const annotateWhere = complaint
    ? and(
        inArray(campaignLeads.status, ["completed", "unsubscribed"]),
        or(sql`${campaignLeads.stopReason} IS NULL`, ne(campaignLeads.stopReason, "complaint")),
      )
    : and(eq(campaignLeads.status, "completed"), sql`${campaignLeads.stopReason} IS NULL`);
  const annotated = await tx
    .update(campaignLeads)
    .set({ stopReason: reason, updatedAt: now, ...markers })
    .where(and(targetSql(target), annotateWhere))
    .returning({ id: campaignLeads.id });

  return { stopped: stopped.map((r) => r.id), annotated: annotated.map((r) => r.id) };
}

/**
 * TB-11(d): DOĞRULANMIŞ şikâyetten sonra aynı İŞLETMENİN diğer SÜREN dizilerini durdurur — aynı lead (adres farklı
 * olsa da) veya aynı işletme alan adı (`businessDomainOf`: `shop.firma.de` ile `firma.de` aynı işletme; kişisel posta
 * sağlayıcıları işletme sayılmaz). Neden `complaint`; gerekçe `["arf_complaint", "business_complaint"]`.
 *
 * KASITLI SINIR: Diğer adreslere suppression YAZILMAZ ve lead kalıcı olarak engellenmez; yalnızca o anda süren diziler
 * durur. Bitmiş dizilere dokunulmaz. İşletmeyi kalıcı engellemek kullanıcının kararıdır (lead durumu "iletişime
 * geçme" veya alan adı engeli).
 */
export async function stopBusinessSequences(
  tx: DbExecutor,
  business: { leadId: number | null; recipientDomain: string | null },
  now: number,
): Promise<number[]> {
  const reg = businessDomainOf(business.recipientDomain);
  const scope: SQL[] = [];
  if (business.leadId !== null) scope.push(eq(campaignLeads.leadId, business.leadId));
  if (reg) {
    scope.push(eq(campaignLeads.recipientDomain, reg));
    scope.push(like(campaignLeads.recipientDomain, `%.${reg}`));
  }
  if (scope.length === 0) return [];
  const candidates = await tx
    .select({
      id: campaignLeads.id,
      leadId: campaignLeads.leadId,
      domain: campaignLeads.recipientDomain,
    })
    .from(campaignLeads)
    .where(and(inArray(campaignLeads.status, [...STOPPABLE]), or(...scope)));
  // SQL ön süzgecinden sonra kesin eşleşme (LIKE yalnızca alt alan adı adayı bulur).
  const ids = candidates
    .filter(
      (r) =>
        (business.leadId !== null && r.leadId === business.leadId) ||
        (reg !== null && businessDomainOf(r.domain) === reg),
    )
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .update(campaignLeads)
    .set({
      status: "unsubscribed",
      stopReason: "complaint",
      nextSendAt: null,
      updatedAt: now,
      exclusionReasons: appendReasonsSql([ARF_COMPLAINT_CODE, BUSINESS_COMPLAINT_CODE]),
    })
    .where(and(inArray(campaignLeads.id, ids), inArray(campaignLeads.status, [...STOPPABLE])))
    .returning({ id: campaignLeads.id });
  return rows.map((r) => r.id);
}
