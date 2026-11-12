import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { MAIL_SEND_JOB } from "@/lib/mail/scheduler/job";
import { scheduleTick } from "@/lib/scan/schedule";

/** Electron ana sürecinden gelen IPC iletisi: bilgisayar uykudan uyandı / uygulama öne geldi. */
export interface WakeMessage {
  type: "wake";
}

export const isWakeMessage = (m: unknown): m is WakeMessage =>
  typeof m === "object" && m !== null && (m as { type?: unknown }).type === "wake";

/** Aynı dakikada gelen art arda uyandırmalar tek uyandırma sayılır. */
export const WAKE_DEBOUNCE_MS = 30_000;

/**
 * "Uyan": uyku sırasında kaçırılan zamanlamalar için tick hemen çalışır (kuyruktaki tick öne çekilir ya da yenisi
 * eklenir) ve kuyrukta bekleyen gönderim dağıtıcısı (`mail.send`) öne çekilir. Dağıtıcı hız ve saat kurallarını kendisi
 * yeniden değerlendirdiği için erken uyanmak gönderim kurallarını gevşetmez; çalışan bir işe dokunulmaz.
 * Gönderim zamanlayıcısı kapalıysa (`mailEnabled=false`) gönderim işlerine dokunulmaz.
 */
export async function handleWake(
  db: Db,
  opts: { now: number; mailEnabled: boolean },
): Promise<{ tickInserted: boolean; mailPulled: number }> {
  const inserted = await scheduleTick(db, { runAt: opts.now, now: opts.now, pullForward: true });
  let mailPulled = 0;
  if (opts.mailEnabled) {
    const r = await db
      .update(jobs)
      .set({ runAt: opts.now, updatedAt: opts.now })
      .where(and(eq(jobs.type, MAIL_SEND_JOB), eq(jobs.status, "queued"), gt(jobs.runAt, opts.now)))
      .returning({ id: jobs.id });
    mailPulled = r.length;
  }
  return { tickInserted: inserted !== null, mailPulled };
}

/** IPC dinleyicisi için uyandırma kapısı: son uyandırmadan bu yana `WAKE_DEBOUNCE_MS` geçmediyse `false`. */
export function createWakeGate(clock: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const now = clock();
    if (now - last < WAKE_DEBOUNCE_MS) return false;
    last = now;
    return true;
  };
}
