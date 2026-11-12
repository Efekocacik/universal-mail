import type { Db } from "@/lib/db/client";
import { wakeDispatchSafely, type WakeOutcome } from "@/lib/mail/scheduler/job";
import { scheduleTick } from "@/lib/scan/schedule";
import { errorMessage } from "@/lib/util";

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
 * uyandırması başarısız olursa tick yine de kurulmuş olur (`"failed"`; periyodik bakım işi yeniden kurar); tick
 * kurulamazsa dağıtıcı yine uyandırılır ve sonuçta `tickFailed` döner (`wake.failed` günlük satırı).
 */
export async function handleWake(
  db: Db,
  opts: { now: number; mailEnabled: boolean; log?: (m: string) => void },
): Promise<{ tickInserted: boolean; mail: WakeOutcome | "failed"; tickFailed?: true }> {
  // İki eylem bağımsızdır: tick kurulamasa da (ör. aynı bağlantıda açık işlem) gönderim dağıtıcısı yine uyandırılır.
  let tickInserted = false;
  let tickFailed = false;
  try {
    tickInserted =
      (await scheduleTick(db, { runAt: opts.now, now: opts.now, pullForward: true })) !== null;
  } catch (e) {
    tickFailed = true;
    (opts.log ?? console.warn)(
      `[worker] wake.failed step=tick error=${errorMessage(e).slice(0, 160)}`,
    );
  }
  const mail = await wakeDispatchSafely(db, {
    now: opts.now,
    enabled: opts.mailEnabled,
    source: "ipc.wake",
  });
  return tickFailed ? { tickInserted, mail, tickFailed: true } : { tickInserted, mail };
}

/** Uyandırma sonucu bir adımın başarısız olduğunu söylüyor mu (kapı bu durumda tüketilmez). */
export function wakeFailed(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const o = r as { tickFailed?: unknown; mail?: unknown };
  return o.tickFailed === true || o.mail === "failed";
}

/**
 * IPC dinleyicisi için uyandırma kapısı: son uyandırmadan bu yana `WAKE_DEBOUNCE_MS` geçmediyse `false`.
 * `release()`: son geçişi geri alır (başarısız uyandırma 30 sn'lik pencereyi tüketmesin; sonraki uyandırma denenir).
 */
export function createWakeGate(
  clock: () => number = Date.now,
): (() => boolean) & { release: () => void } {
  let last = -Infinity;
  let previous = -Infinity;
  const gate = () => {
    const now = clock();
    if (now - last < WAKE_DEBOUNCE_MS) return false;
    previous = last;
    last = now;
    return true;
  };
  return Object.assign(gate, {
    release: () => {
      last = previous;
    },
  });
}

/**
 * İşçinin IPC ileti işleyicisi (Electron ana süreci ↔ işçi sözleşmesi; saf, sınanır):
 *  - `"shutdown"` → güvenli kapanış;
 *  - `{type:'wake'}` → kapı izin verirse `handleWake` (hata günlüğe düşer, süreç çökmez; başarısız uyandırma kapıyı
 *    serbest bırakır, sonraki uyandırma beklemeden denenir);
 *  - diğer her şey yok sayılır.
 * Ters yön (`{type:'notify'}`, işçi → ana süreç) `nudgeOsNotifications` ile gönderilir (src/lib/scan/scan-notifications.ts).
 */
export function createWorkerMessageHandler(deps: {
  shutdown: () => void;
  wake: () => Promise<unknown>;
  gate: (() => boolean) & { release?: () => void };
  onError: (e: unknown) => void;
}): (m: unknown) => void {
  return (m) => {
    if (m === "shutdown") deps.shutdown();
    else if (isWakeMessage(m) && deps.gate())
      deps
        .wake()
        .then((r) => {
          if (wakeFailed(r)) deps.gate.release?.();
        })
        .catch((e) => {
          deps.gate.release?.();
          deps.onError(e);
        });
  };
}
