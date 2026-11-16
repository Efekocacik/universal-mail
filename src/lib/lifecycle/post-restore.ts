import fs from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { validateBackupFolder } from "@/lib/backup/service";
import { completePendingErasures } from "@/lib/compliance/erasure";
import { ERASURE_OF_TRANSMISSION_RECORDS_APPROVED } from "@/lib/compliance/legal-status";
import { hashEmail } from "@/lib/compliance/suppression";
import { toLibsqlUrl } from "@/lib/config/paths";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  campaigns,
  leadEmails,
  leads,
  suppressions,
} from "@/lib/db/schema";
import { refreshLeadSummary } from "@/lib/email/store";
import { getSetting, setSetting } from "@/lib/settings";
import { errorMessage } from "@/lib/util";

/**
 * Faz 6 (paket Y, inceleme düzeltmesi P1): geri yüklemeden SONRA, veritabanı açılıp şeması güncellendikten sonra
 * çalışır. Geri yüklenen veri yedeğin anındaki durumdur; o andan sonra olanlar kaybolur. Kişiye yeniden yazılmasını ve
 * silinmiş verinin geri gelmesini önlemek için:
 *  1. `running` kampanyalar `paused` yapılır (neden `restore`); kullanıcı kontrol edip elle sürdürür.
 *  2. Geri yükleme öncesi kopyadaki (`pre-restore-*.db`) ETKİN engel kayıtları (`suppressions`) aktarılır: engel listesi
 *     yalnızca büyür (çıkış, şikâyet, silme talebi yedekten sonra gelmiş olsa da korunur).
 *  3. Yedekten sonra yeni gelen `erasure` engellerinin kişileri için silme yeniden uygulanır: adresi tutan `lead_emails`
 *     silinir, süren dizileri iptal edilir, işletmeleri "iletişim kurma" yapılır, ileti/dizi kayıtları (onay varsa)
 *     yer tutucuya çevrilir. Silme denetim kayıtları (`erasure.*`) da aktarılır (geçmiş listesi eksik kalmasın).
 *  4. Yedekten sonra kendisine e-posta gönderilmiş alıcıların (kopyada bu alıcıya giden iletim sayısı geri yüklenenden
 *     fazla) süren dizileri iptal edilir: kampanya sürdürülünce aynı kişiye aynı adım yeniden gitmez.
 *  5. Yedekten gelen özel yedek klasörü bu bilgisayarda kullanılamıyorsa varsayılana döner.
 * Kopya yoksa (ilk kurulum / silmeden sonra) yalnızca 1 ve 5 uygulanır. Kişisel veri günlüğe yazılmaz.
 */

export interface PostRestoreReport {
  campaignsPaused: number;
  suppressionsAdded: number;
  erasuresReapplied: number;
  sequencesStopped: number;
  folderReset: boolean;
  /** Kopyadan aktarım yapılamadı (kampanyalar yine de duraklatıldı). */
  carryFailed: boolean;
}

export const RESTORE_PAUSE_REASON = "restore";
const ACTIVE_SEQ = ["pending", "scheduled", "waiting_next"] as const;
const TRANSMITTED = ["sending", "sent", "unknown"] as const;
const ERASURE_AUDITS = ["erasure.executed", "erasure.pending_completed"] as const;
const CHUNK = 400;

const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

type Row = Record<string, unknown>;

async function rowsOf(c: Client, sqlText: string): Promise<Row[]> {
  try {
    return (await c.execute(sqlText)).rows as unknown as Row[];
  } catch (e) {
    // Tablo yoksa (çok eski kopya) boş; diğer hatalar çağırana.
    if (/no such table/i.test(errorMessage(e))) return [];
    throw e;
  }
}

interface Carry {
  suppressions: Row[];
  sentCounts: Map<string, number>;
  audits: Row[];
}

async function readPrevious(file: string): Promise<Carry> {
  const c = createClient({ url: toLibsqlUrl(file) });
  try {
    await c.execute("PRAGMA busy_timeout = 8000");
    const sup = await rowsOf(
      c,
      "SELECT scope, email_hash, hash_alg, email_masked, domain, reason, source, note, added_at FROM suppressions WHERE lifted_at IS NULL",
    );
    const sent = await rowsOf(
      c,
      `SELECT peer_hash AS h, COUNT(*) AS n FROM messages WHERE direction = 'out' AND status IN (${TRANSMITTED.map((s) => `'${s}'`).join(",")}) GROUP BY peer_hash`,
    );
    const audits = await rowsOf(
      c,
      `SELECT at, action, entity, entity_id, detail FROM audit_log WHERE action IN (${ERASURE_AUDITS.map((s) => `'${s}'`).join(",")})`,
    );
    return {
      suppressions: sup,
      sentCounts: new Map(sent.map((r) => [String(r.h), Number(r.n)])),
      audits,
    };
  } finally {
    c.close();
  }
}

async function pauseRunning(db: Db, now: number): Promise<number> {
  const rows = await db
    .update(campaigns)
    .set({ status: "paused", pausedAt: now, pauseReason: RESTORE_PAUSE_REASON, updatedAt: now })
    .where(eq(campaigns.status, "running"))
    .returning({ id: campaigns.id });
  return rows.length;
}

async function carryOver(
  db: Db,
  prev: Carry,
  now: number,
): Promise<{ suppressionsAdded: number; erasuresReapplied: number; sequencesStopped: number }> {
  return db.transaction(async (tx) => {
    // 2. Engel kayıtları (kısmi tekil dizinler aynı etkin kaydı ikinci kez eklemez).
    const erasureHashes = new Set<string>();
    let suppressionsAdded = 0;
    for (const r of prev.suppressions) {
      const scope = r.scope === "domain" ? "domain" : "email";
      const ins = await tx
        .insert(suppressions)
        .values({
          scope,
          emailHash: r.email_hash === null ? null : String(r.email_hash),
          hashAlg: r.hash_alg === null ? null : String(r.hash_alg),
          emailMasked: r.email_masked === null ? null : String(r.email_masked),
          domain: String(r.domain),
          reason: String(r.reason) as typeof suppressions.$inferInsert.reason,
          source: String(r.source) as typeof suppressions.$inferInsert.source,
          note: r.note === null ? null : String(r.note),
          addedAt: Number(r.added_at),
        })
        .onConflictDoNothing()
        .returning({ id: suppressions.id });
      if (ins.length === 0) continue;
      suppressionsAdded++;
      if (r.reason === "erasure" && scope === "email" && r.email_hash)
        erasureHashes.add(String(r.email_hash));
    }

    // 3. Yedekten sonraki silme talepleri yeniden uygulanır.
    const leadIds = new Set<number>();
    if (erasureHashes.size > 0) {
      const emails = await tx
        .select({ id: leadEmails.id, leadId: leadEmails.leadId, email: leadEmails.email })
        .from(leadEmails);
      const hit = emails.filter((e) => erasureHashes.has(hashEmail(e.email)));
      for (const part of chunks(hit.map((e) => e.id)))
        await tx.delete(leadEmails).where(inArray(leadEmails.id, part));
      for (const e of hit) leadIds.add(e.leadId);
    }

    // 4. Yedekten sonra e-posta gönderilmiş alıcılar + silme talebi gelenler: süren diziler iptal.
    const restoredSent = new Map<string, number>();
    if (prev.sentCounts.size > 0) {
      const rows = await tx.all<{ h: string; n: number }>(
        sql.raw(
          `SELECT peer_hash AS h, COUNT(*) AS n FROM messages WHERE direction = 'out' AND status IN (${TRANSMITTED.map((s) => `'${s}'`).join(",")}) GROUP BY peer_hash`,
        ),
      );
      for (const r of rows) restoredSent.set(String(r.h), Number(r.n));
    }
    const stopHashes = new Set(erasureHashes);
    for (const [h, n] of prev.sentCounts) if (n > (restoredSent.get(h) ?? 0)) stopHashes.add(h);
    let sequencesStopped = 0;
    for (const part of chunks([...stopHashes])) {
      const r = await tx
        .update(campaignLeads)
        .set({ status: "cancelled", nextSendAt: null, updatedAt: now })
        .where(
          and(
            inArray(campaignLeads.recipientHash, part),
            inArray(campaignLeads.status, [...ACTIVE_SEQ]),
          ),
        )
        .returning({
          id: campaignLeads.id,
          leadId: campaignLeads.leadId,
          h: campaignLeads.recipientHash,
        });
      sequencesStopped += r.length;
      for (const x of r) if (x.h && erasureHashes.has(x.h)) leadIds.add(x.leadId);
    }
    if (erasureHashes.size > 0) {
      for (const part of chunks([...erasureHashes])) {
        const r = await tx
          .select({ leadId: campaignLeads.leadId })
          .from(campaignLeads)
          .where(inArray(campaignLeads.recipientHash, part));
        for (const x of r) leadIds.add(x.leadId);
      }
      for (const part of chunks([...leadIds]))
        await tx
          .update(leads)
          .set({ status: "do_not_contact", updatedAt: now })
          .where(inArray(leads.id, part));
      for (const id of leadIds) await refreshLeadSummary(tx as unknown as Db, id, now);
    }

    // Silme denetim kayıtları (aynı an + işlem zaten varsa eklenmez).
    if (prev.audits.length > 0) {
      const have = new Set(
        (
          await tx
            .select({ at: auditLog.at, action: auditLog.action })
            .from(auditLog)
            .where(inArray(auditLog.action, [...ERASURE_AUDITS]))
        ).map((r) => `${r.action}@${r.at}`),
      );
      for (const a of prev.audits) {
        const key = `${String(a.action)}@${Number(a.at)}`;
        if (have.has(key)) continue;
        let detail: unknown = null;
        try {
          detail = a.detail === null ? null : JSON.parse(String(a.detail));
        } catch {
          detail = null;
        }
        await tx.insert(auditLog).values({
          at: Number(a.at),
          action: String(a.action),
          entity: a.entity === null ? null : String(a.entity),
          entityId: a.entity_id === null ? null : String(a.entity_id),
          detail,
        });
        have.add(key);
      }
    }
    return { suppressionsAdded, erasuresReapplied: erasureHashes.size, sequencesStopped };
  });
}

/** 5. Yedekten gelen özel klasör bu bilgisayarda kullanılamıyorsa varsayılana döner. */
async function resetUnusableFolder(db: Db): Promise<boolean> {
  const folder = await getSetting(db, "backup.folder");
  if (folder === null) return false;
  try {
    validateBackupFolder(folder);
    return false;
  } catch {
    await setSetting(db, "backup.folder", null);
    return true;
  }
}

export async function reconcileAfterRestore(
  db: Db,
  o: { previousDb: string | null; now: number; log: (m: string) => void },
): Promise<PostRestoreReport> {
  const rep: PostRestoreReport = {
    campaignsPaused: await pauseRunning(db, o.now),
    suppressionsAdded: 0,
    erasuresReapplied: 0,
    sequencesStopped: 0,
    folderReset: false,
    carryFailed: false,
  };
  if (o.previousDb && fs.existsSync(o.previousDb)) {
    try {
      const c = await carryOver(db, await readPrevious(o.previousDb), o.now);
      Object.assign(rep, c);
      if (c.erasuresReapplied > 0 && ERASURE_OF_TRANSMISSION_RECORDS_APPROVED)
        await completePendingErasures(db, { now: o.now });
    } catch (e) {
      rep.carryFailed = true;
      o.log(`geri yükleme sonrası aktarım başarısız: ${errorMessage(e).slice(0, 200)}`);
    }
  }
  try {
    rep.folderReset = await resetUnusableFolder(db);
  } catch (e) {
    o.log(`yedek klasörü denetlenemedi: ${errorMessage(e).slice(0, 200)}`);
  }
  await audit(db, "data.restore.reconciled", "data", undefined, { ...rep }, o.now);
  return rep;
}
