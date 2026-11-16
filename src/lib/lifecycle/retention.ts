import { sql } from "drizzle-orm";
import { lifecycleError } from "@/lib/backup/passphrase";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { notify } from "@/lib/notifications";
import { getSetting, getSettings, setSetting, type SettingValue } from "@/lib/settings";

/**
 * Faz 6 (paket Y.5, FR-CMPL-04): temas edilmemiş lead'lerin saklama süresi.
 *
 * Aday: `last_contacted_at IS NULL AND created_at < kesim AND status IN ('new','enriched')` ve hiç
 * kampanya satırı (`campaign_leads`) ya da iletisi (`messages`) YOK. Bilerek korunanlar: `do_not_contact` ve
 * `not_interested` (ikisi de uygulamanın geri kalanında iletişim yasağı sayılır ve engel listesine yazılmaz; lead
 * silinirse yeniden tarama/içe aktarma aynı işletmeyi 'new' olarak geri getirip yeniden uygun kılardı), temas
 * edilmiş lead'ler (gönderim geçmişi ve yasal denetim), engel listesi (`suppressions`), `audit_log` ve sicil satırları
 * (bağlantıları FK ile NULL olur). Silme 500'lük gruplar hâlinde yazma işleminde yapılır; koşul her grupta aynı ifadede
 * yeniden değerlendirilir. Bağlı kayıtlar (e-postalar, kişiler, zenginleştirme, içe aktarma bağı, tanıtım) FK
 * CASCADE ile gider.
 *
 * Planlayıcı `leads_last_contacted_idx`'i yanlış seçtiği için `INDEXED BY leads_retention_idx` ZORUNLUDUR (P0 notu).
 */

export const RETENTION_BATCH = 500;
export const RETENTION_STATUSES = ["new", "enriched"] as const;

/** Yerel takvimde `months` ay öncesi (ayın son gününe kırpılır: 31 Mart − 1 ay = 28/29 Şubat). */
export function retentionCutoff(now: number, months: number): number {
  const d = new Date(now);
  const target = new Date(
    d.getFullYear(),
    d.getMonth() - months,
    1,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target.getTime();
}

const predicate = (cutoff: number) => sql`
  leads.last_contacted_at IS NULL
  AND leads.created_at < ${cutoff}
  AND leads.status IN ('new', 'enriched')
  AND NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = leads.id)
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = leads.id)`;

export async function countRetentionCandidates(db: Db, cutoff: number): Promise<number> {
  const rows = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM leads INDEXED BY leads_retention_idx WHERE ${predicate(cutoff)}`,
  );
  return Number(rows[0]?.n ?? 0);
}

export type RetentionSettings = SettingValue<"retention.leads">;

export interface RetentionPreview {
  cutoff: number;
  leads: number;
}

export async function previewRetention(
  db: Db,
  now: number = Date.now(),
): Promise<{ settings: RetentionSettings; preview: RetentionPreview }> {
  const settings = await getSetting(db, "retention.leads");
  const cutoff = retentionCutoff(now, settings.months);
  return { settings, preview: { cutoff, leads: await countRetentionCandidates(db, cutoff) } };
}

export async function updateRetentionSettings(
  db: Db,
  input: RetentionSettings,
  now: number = Date.now(),
): Promise<{ settings: RetentionSettings; preview: RetentionPreview }> {
  await setSetting(db, "retention.leads", input);
  await audit(db, "retention.settings", "settings", "retention.leads", input);
  return previewRetention(db, now);
}

/**
 * Saklama süresini uygular. `expectedMax` verilirse (elle "Şimdi uygula") güncel aday sayısı onu aşıyorsa hiçbir şey
 * silinmez: `RETENTION_PREVIEW_STALE`. Sonuç denetim kaydına (yalnızca sayılar) ve `retention.lastRun`'a yazılır;
 * silinen varsa `retention.purged` bildirimi eklenir.
 */
export async function runRetention(
  db: Db,
  o: { now?: number; expectedMax?: number; manual?: boolean } = {},
): Promise<{ deleted: number; cutoff: number }> {
  const now = o.now ?? Date.now();
  const s = await getSettings(db, ["retention.leads"] as const);
  const cutoff = retentionCutoff(now, s["retention.leads"].months);
  if (o.expectedMax !== undefined && (await countRetentionCandidates(db, cutoff)) > o.expectedMax)
    throw lifecycleError("RETENTION_PREVIEW_STALE");
  let deleted = 0;
  for (;;) {
    const n = await db.transaction(async (tx) => {
      const rows = await tx.all<{ id: number }>(sql`
        DELETE FROM leads WHERE id IN (
          SELECT id FROM leads INDEXED BY leads_retention_idx WHERE ${predicate(cutoff)} LIMIT ${RETENTION_BATCH}
        ) RETURNING id`);
      return rows.length;
    });
    deleted += n;
    if (n < RETENTION_BATCH) break;
  }
  await setSetting(db, "retention.lastRun", { at: now, cutoff, deleted });
  await audit(db, "retention.run", "leads", undefined, {
    cutoff,
    deleted,
    months: s["retention.leads"].months,
    manual: !!o.manual,
  });
  if (deleted > 0)
    await notify(
      db,
      {
        kind: "retention.purged",
        dedupeKey: `retention.purged:${now}`,
        params: { n: deleted },
        url: "/settings#backup",
      },
      { now },
    );
  return { deleted, cutoff };
}
