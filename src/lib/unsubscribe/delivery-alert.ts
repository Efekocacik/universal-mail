import type { DbExecutor } from "@/lib/db/client";
import { getSetting, type SettingValue } from "@/lib/settings";
import { isUnsubscribeDrainActive, type Env } from "./drain-job";
import { DELIVERY_FRESH_MS, VERIFICATION_TTL_MS } from "./endpoint";

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
 *  - `delivery_stale`: uç nokta doğrulanmış (kanıt bu adres için var) ama kuyruk sağlığı hiç denetlenmemiş ya da son
 *    denetim `DELIVERY_FRESH_MS`'ten (24 saat) eski: düzenli çekme kapalı, çalışmıyor veya takılmış olabilir; talepler
 *    aktarıcıda birikirken son "sağlıklı" kaydı sonsuza dek gösterilmez.
 *  - `verify_failed`: kanıt yok (ör. kendiliğinden yeniden doğrulama başarısız olup kanıt düştü) ve son doğrulama
 *    denemesi başarısız: canlı gönderim için çıkış bağlantısı hazırlanamaz.
 * Uç nokta hiç yapılandırılmadıysa uyarı YOKTUR (bugünkü varsayılan durum: gürültü üretmez).
 */

export const PROOF_WARN_MS = 5 * 86_400_000;
const DAY_MS = 86_400_000;

export type DeliveryAlert =
  | { kind: "delivery_unhealthy"; code: string; checkedAt: number }
  | { kind: "proof_expiring"; expiresAt: number; daysLeft: number }
  | { kind: "proof_expired"; expiredAt: number }
  | { kind: "delivery_stale"; checkedAt: number | null }
  | { kind: "verify_failed"; code: string; at: number };

export interface DeliveryAlertInput {
  endpoint: Pick<
    SettingValue<"mail.unsubscribeEndpoint">,
    "baseUrl" | "verified" | "delivery" | "lastAttempt"
  >;
  /** Etkin (iptal edilmemiş) imza anahtarının kimliği; yoksa null. */
  currentKid: string | null;
}

export function computeDeliveryAlerts(input: DeliveryAlertInput, now: number): DeliveryAlert[] {
  const { baseUrl, verified, delivery, lastAttempt } = input.endpoint;
  if (!baseUrl) return [];
  const out: DeliveryAlert[] = [];
  if (delivery && !delivery.ok) {
    out.push({ kind: "delivery_unhealthy", code: delivery.code, checkedAt: delivery.checkedAt });
  } else if (
    // Hiç doğrulanmamış (yeni girilmiş) bir adres için gürültü üretilmez; kanıt varsa sağlık kaydı taze olmalıdır.
    verified &&
    verified.baseUrl === baseUrl &&
    (!delivery || now - delivery.checkedAt > DELIVERY_FRESH_MS)
  ) {
    out.push({ kind: "delivery_stale", checkedAt: delivery?.checkedAt ?? null });
  }
  if (!verified && lastAttempt && !lastAttempt.ok) {
    out.push({ kind: "verify_failed", code: lastAttempt.code, at: lastAttempt.at });
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

/* ---------------------------------------------------------------------------------------------- */
/* Canlı kampanya gönderim kapısı: çıkış talepleri gerçekten çekiliyor mu?                          */

/**
 * Neden canlı KAMPANYA gönderimi ertelenmeli:
 *  - `drain_disabled`: çekme işi kapalı (ne ortam bayrağı ne Ayarlar anahtarı): gerçek çıkış tıklamaları aktarıcıda
 *    birikir ve uygulamaya hiç ulaşmaz.
 *  - `drain_unhealthy`: son sağlık kaydı kötü (`queue_deep`, `events_stale`, `corrupt_events`, `unreachable`,
 *    `no_channel_key`).
 *  - `drain_stale`: son 24 saatte (`DELIVERY_FRESH_MS`) hiç sağlık kaydı yok: iş çalışmıyor veya takılmış olabilir.
 */
export type DrainGateCode = "drain_disabled" | "drain_unhealthy" | "drain_stale";

export type DrainGate = { ok: true } | { ok: false; code: DrainGateCode };

/** Saf karar (ağ/yazma yok): açma anahtarı ve saklanan son sağlık kaydından. */
export function computeDrainGate(
  input: {
    active: boolean;
    delivery: Pick<
      NonNullable<SettingValue<"mail.unsubscribeEndpoint">["delivery"]>,
      "ok" | "checkedAt"
    > | null;
  },
  now: number,
): DrainGate {
  if (!input.active) return { ok: false, code: "drain_disabled" };
  const d = input.delivery;
  // Gelecekteki (saat kayması) kayıt da taze sayılmaz.
  if (!d || now - d.checkedAt > DELIVERY_FRESH_MS || d.checkedAt > now + 5 * 60_000) {
    return { ok: false, code: "drain_stale" };
  }
  return d.ok ? { ok: true } : { ok: false, code: "drain_unhealthy" };
}

/**
 * Canlı KAMPANYA gönderiminden önce (kendine test gönderimi bu kapıya tabi DEĞİLDİR): çekme işi açık olmalı VE son
 * 24 saat içinde başarılı bir çekme/sağlık kaydı bulunmalı. Aksi halde çıkış talepleri aktarıcıda birikirken kampanya
 * göndermeye devam ederdi. SALT OKUNUR; ağ yok.
 */
export async function evaluateDrainGate(
  db: DbExecutor,
  opts: { env?: Env; now?: number } = {},
): Promise<DrainGate> {
  const now = opts.now ?? Date.now();
  const active = await isUnsubscribeDrainActive(db, opts.env ?? process.env);
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  return computeDrainGate({ active, delivery: cfg.delivery }, now);
}
