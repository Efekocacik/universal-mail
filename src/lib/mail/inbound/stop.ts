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
 *    sonraki adım engel denetimine takılır.) Durdurma kapsamı `target`'tır: adres düzeyindeki çıkış/şikâyette
 *    alıcının BÜTÜN kampanyalardaki süren dizileri (engel adres düzeyindedir).
 *  - Durumu korunan satırlara neden yazma ("not düşme") YALNIZCA olayın İLGİLİ OLDUĞU diziye (`about`) uygulanır:
 *    - TB-10: `completed` dizi DURUMUNU KORUR; yalnızca `stop_reason` kaydedilir (gönderim zaten bitmişti).
 *    - Şikâyet çıkıştan ağırdır: aynı dizi önce çıkış, sonra şikâyet görürse neden `complaint`'e yükseltilir
 *      (yalnızca `completed`/`unsubscribed` satırlarda; durum değişmez). Tersi nedeni değiştirmez.
 *    Böylece B kampanyasının iletisine yapılan şikâyet, A kampanyasında daha önce çıkışla durmuş ya da bitmiş diziyi
 *    "şikâyet" saymaz; A'nın sayaçları kendi olaylarını gösterir (inceleme bulgusu, 15.10-2).
 *  - Çift yazım: şikâyet nedeni yazılan her satırda `exclusion_reasons` içinde `"arf_complaint"` bulunur (geri alma
 *    sözleşmesi). İşaret zaten varsa yinelenmez; diğer gerekçeler korunur.
 *  - Yeniden çalıştırma aynı sonucu verir (koşullu, sabit değer yazımı; artırım yok): tekrar teslim edilen olay
 *    ikinci kez durdurmaz ve ikinci kez işaret eklemez.
 */

export const STOPPABLE: readonly CampaignLeadStatus[] = ["pending", "scheduled", "waiting_next"];

export type StopTarget = { campaignLeadId: number } | { recipientHash: string };

/** Denetim ayrıntısında tutulan kimlik listesinin üst sınırı (satır şişmesin; sayılar ayrıca tam yazılır). */
export const AUDIT_ID_LIMIT = 50;

/** Denetim kaydı için sınırlı kimlik listesi. */
export function auditIds(ids: readonly number[]): number[] {
  return ids.slice(0, AUDIT_ID_LIMIT);
}

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

/**
 * @param about Olayın ilgili olduğu dizi (eşleşen giden iletinin dizisi / bağlantı belirtecindeki dizi). Durumu korunan
 *   satırlara neden yalnızca bu diziye yazılır. Verilmezse: `target` tek diziyse o dizi, adres hedefiyse HİÇBİRİ.
 */
export async function stopSequences(
  tx: DbExecutor,
  target: StopTarget,
  reason: SequenceStopReason,
  now: number,
  about?: number | null,
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

  // Durumu korunacak satırlar (yalnızca `about` dizisi): `completed` (nedeni yoksa) ve şikâyette nedeni henüz
  // `complaint` olmayan `completed`/`unsubscribed` satırlar.
  const aboutId =
    about !== undefined ? about : "campaignLeadId" in target ? target.campaignLeadId : null;
  if (aboutId === null) return { stopped: stopped.map((r) => r.id), annotated: [] };
  const annotateWhere = complaint
    ? and(
        inArray(campaignLeads.status, ["completed", "unsubscribed"]),
        or(sql`${campaignLeads.stopReason} IS NULL`, ne(campaignLeads.stopReason, "complaint")),
      )
    : and(eq(campaignLeads.status, "completed"), sql`${campaignLeads.stopReason} IS NULL`);
  const annotated = await tx
    .update(campaignLeads)
    .set({ stopReason: reason, updatedAt: now, ...markers })
    .where(and(eq(campaignLeads.id, aboutId), annotateWhere))
    .returning({ id: campaignLeads.id });

  return { stopped: stopped.map((r) => r.id), annotated: annotated.map((r) => r.id) };
}

/** TB-11(d) sonucu: durdurulan dizi kimlikleri ve eşleşmede kullanılan işletme alan adı. */
export interface BusinessStopResult {
  stopped: number[];
  businessDomain: string | null;
}

/**
 * TB-11(d): DOĞRULANMIŞ şikâyetten sonra aynı İŞLETMENİN diğer SÜREN dizilerini durdurur — aynı lead (adres farklı
 * olsa da) veya aynı işletme alan adı (`businessDomainOf`: `shop.firma.de` ile `firma.de` aynı işletme; kişisel posta
 * sağlayıcıları işletme sayılmaz). Neden `complaint`; gerekçe `["arf_complaint", "business_complaint"]`.
 *
 * KASITLI SINIR: Diğer adreslere suppression YAZILMAZ ve lead kalıcı olarak engellenmez; yalnızca o anda süren diziler
 * durur. Bitmiş dizilere dokunulmaz. İşletmeyi kalıcı engellemek kullanıcının kararıdır (lead durumu "iletişime
 * geçme" veya alan adı engeli).
 *
 * Dönüş: durdurulan dizi kimlikleri ve eşleşmede kullanılan işletme alan adı (kişisel sağlayıcıda `null`) — denetim
 * kaydı başka adreslerin neden durduğunu izleyebilsin diye.
 */
export async function stopBusinessSequences(
  tx: DbExecutor,
  business: { leadId: number | null; recipientDomain: string | null },
  now: number,
): Promise<BusinessStopResult> {
  const reg = businessDomainOf(business.recipientDomain);
  const none: BusinessStopResult = { stopped: [], businessDomain: reg };
  const scope: SQL[] = [];
  if (business.leadId !== null) scope.push(eq(campaignLeads.leadId, business.leadId));
  if (reg) {
    scope.push(eq(campaignLeads.recipientDomain, reg));
    scope.push(like(campaignLeads.recipientDomain, `%.${reg}`));
  }
  if (scope.length === 0) return none;
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
  if (ids.length === 0) return none;
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
  return { stopped: rows.map((r) => r.id), businessDomain: reg };
}
