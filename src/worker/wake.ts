import type { Db } from "@/lib/db/client";
import { wakeDispatchSafely, type WakeOutcome } from "@/lib/mail/scheduler/job";
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
 * eklenir) ve gönderim dağıtıcısı `wakeDispatchSafely` ile uyandırılır (Paket E'nin tek uyandırma yolu: bekleyen
 * `mail.send` işi öne çekilir, yoksa tek iş eklenir, çalışan iş varsa bayrak bırakılır). Dağıtıcı hız ve saat
 * kurallarını kendisi yeniden değerlendirdiği için erken uyanmak gönderim kurallarını gevşetmez.
 * Gönderim zamanlayıcısı kapalıysa (`mailEnabled=false`) gönderim işlerine dokunulmaz (`"disabled"`). Dağıtıcı
 * uyandırması başarısız olursa tick yine de kurulmuş olur (`"failed"`; periyodik bakım işi yeniden kurar).
 */
export async function handleWake(
  db: Db,
  opts: { now: number; mailEnabled: boolean },
): Promise<{ tickInserted: boolean; mail: WakeOutcome | "failed" }> {
  const inserted = await scheduleTick(db, { runAt: opts.now, now: opts.now, pullForward: true });
  const mail = await wakeDispatchSafely(db, {
    now: opts.now,
    enabled: opts.mailEnabled,
    source: "ipc.wake",
  });
  return { tickInserted: inserted !== null, mail };
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
