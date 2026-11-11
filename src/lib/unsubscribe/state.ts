import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import type { Db } from "@/lib/db/client";
import { getSetting } from "@/lib/settings";
import { isUnsubscribeDrainEnabled } from "./drain-job";
import { VERIFICATION_TTL_MS, evaluateDelivery, isOneClickEndpointVerified } from "./endpoint";

/**
 * Çıkış altyapısının GENEL durum görünümü (TB-3; Ayarlar ekranı). Yalnızca veritabanını okur, ağ isteği yapmaz.
 * Anahtar kimlikleri (kid), zaman damgaları, temel adres ve kanıt durumu döner; özel anahtar, gizli depo içeriği,
 * genel anahtar baytları ve bekleyen/doğrulanmış sınamanın `jti` değeri ASLA dönmez.
 */

export interface UnsubscribeKeyView {
  kid: string;
  createdAt: number;
  retiredAt: number | null;
  revokedAt: number | null;
}

export interface UnsubscribeStateView {
  baseUrl: string | null;
  signing: { current: string | null; keys: UnsubscribeKeyView[] };
  channel: { current: string | null; keys: UnsubscribeKeyView[] };
  verification: {
    /** Saklanan uçtan uca kanıttan: uç nokta ŞU AN doğrulanmış mı? */
    verified: boolean;
    verifiedAt: number | null;
    expiresAt: number | null;
    /** Kanıtın bağlı olduğu imza anahtarı artık etkin değilse (döndürme/iptal sonrası) true. */
    staleKey: boolean;
    lastAttempt: { at: number; ok: boolean; code: string; detail: string | null } | null;
  };
  delivery: {
    status: "ok" | "blocked" | "unknown";
    last: {
      checkedAt: number;
      ok: boolean;
      depth: number;
      oldestAgeMs: number | null;
      corrupt: number;
      code: string;
    } | null;
  };
  drain: { enabled: boolean; envForced: boolean; active: boolean };
  /** Genel HTTPS çıkış uç noktası için hukuki/işletim onayı (kodda sabit; bu ekrandan değişmez). */
  legalApproved: boolean;
  /** Anahtar dosyası indirilebilir mi (etkin imza ve kanal anahtarı ile temel adres var mı)? */
  keyFileReady: boolean;
}

export async function buildUnsubscribeState(
  db: Db,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  now = Date.now(),
): Promise<UnsubscribeStateView> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  const signing = await getSetting(db, "mail.unsubscribeKeys");
  const channel = await getSetting(db, "mail.unsubscribeChannel");
  const drain = await getSetting(db, "mail.unsubscribeDrain");
  const signingCurrent =
    signing.keys.find((k) => k.kid === signing.current && k.revokedAt === null)?.kid ?? null;
  const channelCurrent =
    channel.keys.find((k) => k.kid === channel.current && k.revokedAt === null)?.kid ?? null;
  const verified = await isOneClickEndpointVerified(db, now);
  const proof = cfg.verified !== null && cfg.verified.baseUrl === cfg.baseUrl ? cfg.verified : null;
  const envForced = isUnsubscribeDrainEnabled(env);
  return {
    baseUrl: cfg.baseUrl,
    signing: {
      current: signingCurrent,
      keys: signing.keys.map((k) => ({
        kid: k.kid,
        createdAt: k.createdAt,
        retiredAt: k.retiredAt,
        revokedAt: k.revokedAt,
      })),
    },
    channel: {
      current: channelCurrent,
      keys: channel.keys.map((k) => ({
        kid: k.kid,
        createdAt: k.createdAt,
        retiredAt: null,
        revokedAt: k.revokedAt,
      })),
    },
    verification: {
      verified,
      verifiedAt: proof?.verifiedAt ?? null,
      expiresAt: proof ? proof.verifiedAt + VERIFICATION_TTL_MS : null,
      staleKey: proof !== null && proof.kid !== signingCurrent,
      lastAttempt: cfg.lastAttempt
        ? {
            at: cfg.lastAttempt.at,
            ok: cfg.lastAttempt.ok,
            code: cfg.lastAttempt.code,
            detail: cfg.lastAttempt.detail ?? null,
          }
        : null,
    },
    delivery: {
      status: await evaluateDelivery(db, channelCurrent !== null, now),
      last: cfg.delivery,
    },
    drain: { enabled: drain.enabled, envForced, active: drain.enabled || envForced },
    legalApproved: LEGAL_APPROVALS.httpsUnsubscribeEndpoint,
    keyFileReady: signingCurrent !== null && channelCurrent !== null && cfg.baseUrl !== null,
  };
}
