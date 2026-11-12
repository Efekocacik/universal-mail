import { errorMessage } from "@/lib/util";

/**
 * İşçi açılışında tek seferlik adımlar (`recover`, ilk tick) için kısa yeniden deneme. Aynı süreçte tek libsql bağlantısı
 * açık bir işlem tutarken (TRANSACTION_ACTIVE) ya da başka süreç yazarken (SQLITE_BUSY) adım fırlatırsa işçi hemen
 * çökmez; birkaç kez kısa aralıkla yeniden dener. Son denemenin hatası çağırana fırlatılır.
 */
export async function withShortRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (m: string) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      opts.log?.(
        `retry step=${label} attempt=${i}/${attempts} error=${errorMessage(e).slice(0, 120)}`,
      );
      await sleep(delayMs * i);
    }
  }
}
