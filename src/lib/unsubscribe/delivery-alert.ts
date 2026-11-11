import type { DbExecutor } from "@/lib/db/client";
import { getSetting, type SettingValue } from "@/lib/settings";
import { VERIFICATION_TTL_MS } from "./endpoint";

/**
 * Çıkış (unsubscribe) teslimat uyarıları (C14 / TB-4). SALT OKUNUR ve AĞSIZ: yalnızca saklanan son sağlık kaydına ve
 * doğrulama kanıtına bakar; aktarıcıya istek atmaz, sağlık denetimi başlatmaz, hiçbir şey yazmaz.
 *
 * Uyarılar:
 *  - `delivery_unhealthy`: son sağlık denetimi kötü (`queue_deep`, `events_stale`, `corrupt_events`, `unreachable`).
 *    Gelen çıkış talepleri işlenmiyor olabilir.
 *  - `proof_expiring`: uç nokta kanıtı `PROOF_WARN_MS` (5 gün) içinde sona eriyor. Süre dolunca canlı gönderim için
 *    çıkış bağlantısı hazırlanamaz (sessizce durur).
 *  - `proof_expired`: kanıt (aynı adres ve aynı etkin anahtar için) süresi dolmuş.
 * Uç nokta hiç yapılandırılmadıysa uyarı YOKTUR (bugünkü varsayılan durum: gürültü üretmez).
 */

export const PROOF_WARN_MS = 5 * 86_400_000;
const DAY_MS = 86_400_000;

export type DeliveryAlert =
  | { kind: "delivery_unhealthy"; code: string; checkedAt: number }
  | { kind: "proof_expiring"; expiresAt: number; daysLeft: number }
  | { kind: "proof_expired"; expiredAt: number };

export interface DeliveryAlertInput {
  endpoint: Pick<SettingValue<"mail.unsubscribeEndpoint">, "baseUrl" | "verified" | "delivery">;
  /** Etkin (iptal edilmemiş) imza anahtarının kimliği; yoksa null. */
  currentKid: string | null;
}

export function computeDeliveryAlerts(input: DeliveryAlertInput, now: number): DeliveryAlert[] {
  const { baseUrl, verified, delivery } = input.endpoint;
  if (!baseUrl) return [];
  const out: DeliveryAlert[] = [];
  if (delivery && !delivery.ok) {
    out.push({ kind: "delivery_unhealthy", code: delivery.code, checkedAt: delivery.checkedAt });
  }
  // Kanıt yalnızca aynı adres ve şu anki imza anahtarı için anlamlıdır (anahtar döndürüldüyse süre değil yeniden
  // doğrulama sorunudur; bunu uç nokta ekranı gösterir).
  if (verified && verified.baseUrl === baseUrl && verified.kid === input.currentKid) {
    const expiresAt = verified.verifiedAt + VERIFICATION_TTL_MS;
    const left = expiresAt - now;
    if (left <= 0) out.push({ kind: "proof_expired", expiredAt: expiresAt });
    else if (left <= PROOF_WARN_MS) {
      out.push({ kind: "proof_expiring", expiresAt, daysLeft: Math.ceil(left / DAY_MS) });
    }
  }
  return out;
}

/** Saklanan kayıtlardan uyarılar (salt okunur; ağ yok). */
export async function getDeliveryAlerts(
  db: DbExecutor,
  now = Date.now(),
): Promise<DeliveryAlert[]> {
  const endpoint = await getSetting(db, "mail.unsubscribeEndpoint");
  const keys = await getSetting(db, "mail.unsubscribeKeys");
  const current = keys.keys.find((k) => k.kid === keys.current && k.revokedAt === null);
  return computeDeliveryAlerts({ endpoint, currentKid: current?.kid ?? null }, now);
}
