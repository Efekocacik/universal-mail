import { z } from "zod";
import { HttpError } from "@/lib/api/http";

/**
 * Çıkış altyapısı uçlarının ortak parçaları (TB-3): giriş şemaları ve süreç içi kilit.
 *
 * Anahtar işlemleri (ensure/rotate/revoke), temel adres, anahtar dosyası, doğrulama, sağlık ve çekme anahtarı süreç
 * içinde SIRAYLA çalışır: `ensure*` atomik değildir ve gizli depo oku-değiştir-yaz yapar (iki eşzamanlı istek iki
 * anahtar üretebilir); doğrulama sürerken anahtar döndürmek de kanıtı tutarsız bırakır.
 */

export const keyActionSchema = z.object({ action: z.enum(["ensure", "rotate"]) }).strict();
export const revokeSchema = z.object({ confirm: z.literal(true) }).strict();
export const baseUrlSchema = z
  .object({ baseUrl: z.string().trim().min(1).max(253).nullable() })
  .strict();
export const drainSchema = z.object({ enabled: z.boolean() }).strict();
export const arfReportersSchema = z
  .object({ domains: z.array(z.string().trim().min(1).max(253)).max(200) })
  .strict();

const KID_RE = /^[0-9a-f]{16}$/;

/** Yol parametresindeki anahtar kimliği (16 onaltılık karakter). */
export function kidParam(raw: string | undefined): string {
  if (!raw || !KID_RE.test(raw)) throw new HttpError(400, "Geçersiz anahtar kimliği.");
  return raw;
}

const LOCK = Symbol.for("um.unsubscribeKeyLock");

/**
 * Süreç içi kilit: işlemleri sırayla çalıştırır. Next.js uçları ayrı paketlenebildiği için zincir `globalThis` üzerinde
 * tutulur (tüm uçlar aynı kilidi paylaşır). Bir işlemin hatası sonrakileri engellemez. Worker ayrı bir süreçtir;
 * onun kendiliğinden yeniden doğrulaması bu kilidin dışındadır.
 */
export async function withUnsubscribeLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<symbol, Promise<unknown> | undefined>;
  const prev = g[LOCK] ?? Promise.resolve();
  const run = prev.then(fn, fn);
  g[LOCK] = run.catch(() => undefined);
  return run;
}
