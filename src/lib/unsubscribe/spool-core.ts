import type { UnsubscribeEvent } from "./relay";
import { MAX_TOKEN_LENGTH } from "./token-core";

/**
 * Aktarıcı kuyruğunun çalışma ortamından BAĞIMSIZ ortak parçaları (dosya tabanlı `FileSpool`, ./spool; D1 tabanlı
 * `D1Spool`, src/relay/d1-spool.ts). İki gerçekleme aynı olay şemasını, kimlik biçimini, hata kodlarını ve
 * istatistik şeklini kullanır; uygulamanın `HttpEventSource`u ikisini ayırt etmez.
 */

/** Kuyruk kimliği: 13 haneli ms zaman damgası + 16 hex rastgele (sözlük sırası = varış sırası). */
export const SPOOL_ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;
export const SPOOL_DEFAULT_MAX_PENDING = 100_000;

export interface SpoolStats {
  depth: number;
  /** En eski onaysız olayın yaşı (ms); kuyruk boşsa null. */
  oldestAgeMs: number | null;
  corrupt: number;
}

export class SpoolError extends Error {
  constructor(readonly code: "queue_full" | "invalid_event" | "write_failed") {
    super(code);
    this.name = "SpoolError";
  }
}

/** Kuyruğa yazılabilecek/kuyruktan okunabilecek olay: tam olarak 4 alan, katı türler. */
export function isSpoolEvent(e: unknown): e is UnsubscribeEvent {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    Object.keys(x).length === 4 &&
    x.v === 1 &&
    x.via === "one_click" &&
    typeof x.token === "string" &&
    x.token.length > 0 &&
    x.token.length <= MAX_TOKEN_LENGTH &&
    typeof x.receivedAt === "number" &&
    Number.isSafeInteger(x.receivedAt) &&
    x.receivedAt > 0
  );
}

/** Yeni kuyruk kimliği; `randomHex16` 16 küçük harfli hex karakter döndürmelidir. */
export function newSpoolId(now: number, randomHex16: string): string {
  return `${String(now).padStart(13, "0")}-${randomHex16}`;
}

/** WebCrypto ile 8 rastgele bayt → 16 hex karakter (Node ve Workers). */
export function webRandomHex16(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
