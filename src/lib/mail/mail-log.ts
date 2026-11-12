import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { campaigns, messages } from "@/lib/db/schema";
import { maskEmail } from "@/lib/compliance/suppression";
import { parseEmail } from "@/lib/email/address";
import { csvCell } from "@/lib/export/csv";
import { effectiveClassification } from "./inbound/complaint";

/**
 * Gönderim günlüğü (FR-CMP-10) ve CSV dışa aktarımı (Aşama 13).
 *
 * GİZLİLİK: Adresler YALNIZCA maskeli gösterilir (`i***@alanadi`); tam adres dışa aktarımı hiçbir koşulda
 * (açık onayla bile) yoktur. Silinmiş (`redacted_at`) satırlarda adres, alan adı, konu ve hata metni boştur.
 * Hata metinleri adres içerebileceğinden günlükte yalnızca hata KODU bulunur. İleti gövdesi saklanmadığı için
 * dışa aktarılamaz.
 */

export const MAIL_LOG_MAX_LIMIT = 200;
export const MAIL_LOG_EXPORT_MAX_ROWS = 50_000;

export interface MailLogFilters {
  direction?: "out" | "in";
  purpose?: "campaign" | "test" | "inbound";
  campaignId?: number;
  status?: string;
  /** Epoch ms, dahil. */
  from?: number;
  to?: number;
}

export interface MailLogItem {
  id: number;
  direction: "out" | "in";
  purpose: "campaign" | "test" | "inbound";
  campaignId: number | null;
  campaignName: string | null;
  stepIndex: number | null;
  status: string;
  deliveryStatus: string | null;
  classification: string | null;
  /** Giden: maskeli alıcı. Gelen: yalnızca gönderenin alan adı. Silinmişse null. */
  peer: string | null;
  subject: string | null;
  errorCode: string | null;
  at: number;
  redacted: boolean;
}

function conditions(f: MailLogFilters): SQL[] {
  const c: SQL[] = [];
  if (f.direction) c.push(eq(messages.direction, f.direction));
  if (f.purpose) c.push(eq(messages.purpose, f.purpose));
  if (f.campaignId !== undefined) c.push(eq(messages.campaignId, f.campaignId));
  if (f.status) c.push(eq(messages.status, f.status as never));
  if (f.from !== undefined) c.push(gte(messages.createdAt, f.from));
  if (f.to !== undefined) c.push(lte(messages.createdAt, f.to));
  return c;
}

function maskAddress(addr: string | null): string | null {
  if (!addr) return null;
  const p = parseEmail(addr);
  return p ? maskEmail(p.local, p.domain) : null;
}

type Row = {
  m: typeof messages.$inferSelect;
  campaignName: string | null;
};

function toItem({ m, campaignName }: Row): MailLogItem {
  const redacted = m.redactedAt !== null;
  return {
    id: m.id,
    direction: m.direction,
    purpose: m.purpose,
    campaignId: m.campaignId,
    campaignName: redacted ? null : campaignName,
    stepIndex: m.stepIndex,
    status: m.status,
    deliveryStatus: m.deliveryStatus,
    // 15.10-2: eski satırlar (`other` + ARF işareti) de `complaint` olarak gösterilir/dışa aktarılır.
    classification: effectiveClassification(m.classification, m.errorCode),
    peer: redacted ? null : m.direction === "out" ? maskAddress(m.toAddress) : m.peerDomain,
    subject: redacted ? null : m.subjectLogged,
    errorCode: redacted ? null : m.errorCode,
    at: m.sentAt ?? m.receivedAt ?? m.createdAt,
    redacted,
  };
}

export async function listMailLog(
  db: DbExecutor,
  filters: MailLogFilters,
  page: { beforeId?: number; limit?: number } = {},
): Promise<{ items: MailLogItem[]; nextBeforeId: number | null }> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), MAIL_LOG_MAX_LIMIT);
  const where = [...conditions(filters)];
  if (page.beforeId !== undefined) where.push(lt(messages.id, page.beforeId));
  const rows = await db
    .select({ m: messages, campaignName: campaigns.name })
    .from(messages)
    .leftJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(toItem);
  return { items, nextBeforeId: more ? items[items.length - 1]!.id : null };
}

export const MAIL_LOG_CSV_HEADERS = [
  "id",
  "tarih_utc",
  "yon",
  "tur",
  "kampanya_no",
  "adim",
  "durum",
  "teslim_durumu",
  "siniflandirma",
  "alici_maskeli_veya_alan_adi",
  "konu",
  "hata_kodu",
  "silindi",
] as const;

export function mailLogCsvLine(i: MailLogItem): string {
  return [
    i.id,
    new Date(i.at).toISOString(),
    i.direction === "out" ? "giden" : "gelen",
    i.purpose,
    i.campaignId,
    i.stepIndex,
    i.status,
    i.deliveryStatus,
    i.classification,
    i.peer,
    i.subject,
    i.errorCode,
    i.redacted ? "evet" : "",
  ]
    .map(csvCell)
    .join(",");
}

/** CSV satırlarını parça parça üretir (en çok `MAIL_LOG_EXPORT_MAX_ROWS` satır). */
export async function* exportMailLogCsv(
  db: DbExecutor,
  filters: MailLogFilters,
): AsyncGenerator<string> {
  yield `﻿${MAIL_LOG_CSV_HEADERS.join(",")}\r\n`;
  let before: number | undefined;
  let sent = 0;
  while (sent < MAIL_LOG_EXPORT_MAX_ROWS) {
    const { items, nextBeforeId } = await listMailLog(db, filters, {
      beforeId: before,
      limit: MAIL_LOG_MAX_LIMIT,
    });
    for (const it of items) {
      yield `${mailLogCsvLine(it)}\r\n`;
      if (++sent >= MAIL_LOG_EXPORT_MAX_ROWS) return;
    }
    if (nextBeforeId === null) return;
    before = nextBeforeId;
  }
}
