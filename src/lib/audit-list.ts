import { and, desc, like, lt, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { csvCell } from "@/lib/export/csv";

/**
 * İşlem günlüğü (audit log) listesi ve dışa aktarımı (FR-CMPL-06, Aşama 13).
 *
 * GİZLİLİK: Ham `detail` JSON'u HİÇBİR ZAMAN döndürülmez. Yalnızca izinli işlem aileleri için, değeri sayı, mantıksal
 * değer veya kısa güvenli belirteç olan alanlar özetlenir; adres/alan adı/ad/not/metin adlı anahtarlar ve `@`
 * içeren değerler atılır. `email.*`, `lead.*`, `settings.*`, `consent.*`, `setup.*` gibi kişisel veri taşıyabilen
 * ailelerde ayrıntı hiç gösterilmez.
 */

export const AUDIT_MAX_LIMIT = 200;
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** Ayrıntısı gösterilebilen işlem aileleri (diğerlerinde ayrıntı boş). */
const DETAIL_PREFIXES = [
  "campaign.",
  "suppression.",
  "template.",
  "policy.",
  "inbound.",
  "mail.",
  "export.",
  "unsubscribe.",
  "autostop.",
  "dns.",
] as const;

const SECRET_KEY_RE =
  /(mail|address|domain|name|note|text|message|subject|body|url|token|hash|key|reason_text)/i;
const ALWAYS_OK_KEY_RE =
  /^(minRecipients|minBounces|minRateBp|fromRecipients|toRecipients|fromRateBp|toRateBp|recipients|bounced)$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,48}$/;

export function summarizeAuditDetail(action: string, detail: unknown): string {
  if (!DETAIL_PREFIXES.some((p) => action.startsWith(p))) return "";
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (!ALWAYS_OK_KEY_RE.test(k) && !/Id$/.test(k) && SECRET_KEY_RE.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}=${v}`);
    else if (typeof v === "boolean") parts.push(`${k}=${v}`);
    else if (typeof v === "string" && SAFE_TOKEN_RE.test(v) && !v.includes("@"))
      parts.push(`${k}=${v}`);
    if (parts.length >= 12) break;
  }
  return parts.join("; ");
}

export interface AuditItem {
  id: number;
  at: number;
  action: string;
  entity: string | null;
  entityId: string | null;
  summary: string;
}

export async function listAudit(
  db: DbExecutor,
  filters: { actionPrefix?: string } = {},
  page: { beforeId?: number; limit?: number } = {},
): Promise<{ items: AuditItem[]; nextBeforeId: number | null }> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), AUDIT_MAX_LIMIT);
  const where: SQL[] = [];
  if (filters.actionPrefix) {
    // LIKE joker karakterleri kaçırılır; yalnızca güvenli önek kabul edilir.
    const p = filters.actionPrefix.replace(/[^A-Za-z0-9_.]/g, "");
    if (p) where.push(like(auditLog.action, `${p}%`));
  }
  if (page.beforeId !== undefined) where.push(lt(auditLog.id, page.beforeId));
  const rows = await db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId !== null && /^[A-Za-z0-9_.:-]{1,48}$/.test(r.entityId) ? r.entityId : null,
    summary: summarizeAuditDetail(r.action, r.detail),
  }));
  return { items, nextBeforeId: more ? items[items.length - 1]!.id : null };
}

export const AUDIT_CSV_HEADERS = [
  "id",
  "tarih_utc",
  "islem",
  "varlik",
  "varlik_no",
  "ozet",
] as const;

export async function* exportAuditCsv(
  db: DbExecutor,
  filters: { actionPrefix?: string } = {},
): AsyncGenerator<string> {
  yield `﻿${AUDIT_CSV_HEADERS.join(",")}\r\n`;
  let before: number | undefined;
  let sent = 0;
  while (sent < AUDIT_EXPORT_MAX_ROWS) {
    const { items, nextBeforeId } = await listAudit(db, filters, {
      beforeId: before,
      limit: AUDIT_MAX_LIMIT,
    });
    for (const it of items) {
      yield `${[it.id, new Date(it.at).toISOString(), it.action, it.entity, it.entityId, it.summary].map(csvCell).join(",")}\r\n`;
      if (++sent >= AUDIT_EXPORT_MAX_ROWS) return;
    }
    if (nextBeforeId === null) return;
    before = nextBeforeId;
  }
}
