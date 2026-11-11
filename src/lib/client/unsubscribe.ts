"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import type { VerifyOutcome } from "@/lib/unsubscribe/endpoint";
import type { UnsubscribeStateView } from "@/lib/unsubscribe/state";
import { api, ApiError } from "./api";
import { mk } from "./mail-ops";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/**
 * Çıkış altyapısı istemcisi (TB-3): anahtarlar, temel adres, anahtar dosyası, uçtan uca doğrulama, kuyruk sağlığı,
 * çekme anahtarı ve ARF sağlayıcıları. Durum sorgusu yalnızca veritabanını okur; aktarıcıya giden istekler (doğrulama,
 * sağlık) YALNIZCA kullanıcı düğmeye bastığında yapılır. Her değişiklikten sonra canlı hazırlık sorgusu da yenilenir.
 */

export type UnsubscribeState = UnsubscribeStateView;
export type { VerifyOutcome };

export const uk = {
  all: ["unsubscribe-infra"] as const,
  state: ["unsubscribe-infra", "state"] as const,
  arf: ["unsubscribe-infra", "arf-reporters"] as const,
};

/** Çıkış teslimat uyarı bandının sorgu anahtarı (kampanya ve uyum sayfaları). */
export const DELIVERY_ALERTS_KEY = ["compliance", "delivery-alerts"] as const;

/** Değişiklik sonrası yenilenecek sorgular: çıkış altyapısı + canlı gönderime hazırlık + teslimat uyarı bandı. */
export const UNSUBSCRIBE_INVALIDATE: readonly QueryKey[] = [
  uk.all,
  mk.readiness,
  DELIVERY_ALERTS_KEY,
];

const getOpts = { retry: shouldRetryQuery, retryDelay: queryRetryDelay } as const;

export const useUnsubscribeState = () =>
  useQuery({
    queryKey: uk.state,
    queryFn: () => api<UnsubscribeState>("/api/compliance/unsubscribe"),
    ...getOpts,
  });

export const useArfReporters = () =>
  useQuery({
    queryKey: uk.arf,
    queryFn: () =>
      api<{ domains: string[] }>("/api/compliance/arf-reporters").then((r) => r.domains),
    ...getOpts,
  });

const BASE = "/api/compliance/unsubscribe";

/** Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. */
export const unsubscribeApi = {
  signingKey: (action: "ensure" | "rotate") =>
    api<{ kid: string; rotated: boolean }>(`${BASE}/keys/signing`, {
      method: "POST",
      json: { action },
    }),
  revokeSigningKey: (kid: string) =>
    api<{ revoked: true }>(`${BASE}/keys/signing/${encodeURIComponent(kid)}/revoke`, {
      method: "POST",
      json: { confirm: true },
    }),
  channelKey: (action: "ensure" | "rotate") =>
    api<{ kid: string; rotated: boolean }>(`${BASE}/keys/channel`, {
      method: "POST",
      json: { action },
    }),
  revokeChannelKey: (kid: string) =>
    api<{ revoked: true }>(`${BASE}/keys/channel/${encodeURIComponent(kid)}/revoke`, {
      method: "POST",
      json: { confirm: true },
    }),
  setBaseUrl: (baseUrl: string | null) =>
    api<{ ok: true; drainScheduled: boolean }>(`${BASE}/base-url`, {
      method: "PUT",
      json: { baseUrl },
    }),
  verify: () => api<{ outcome: VerifyOutcome }>(`${BASE}/verify`, { method: "POST" }),
  health: () => api<{ ok: boolean; code: string }>(`${BASE}/health`, { method: "POST" }),
  setDrain: (enabled: boolean) =>
    api<{ enabled: boolean; active: boolean; scheduled: boolean }>(`${BASE}/drain`, {
      method: "PUT",
      json: { enabled },
    }),
  setArfReporters: (domains: string[]) =>
    api<{ domains: string[] }>("/api/compliance/arf-reporters", {
      method: "PUT",
      json: { domains },
    }),
  /**
   * Aktarıcı anahtar dosyasını indirir (yalnızca GENEL anahtarlar). Hata gövdesi (409) `ApiError` olarak döner;
   * başarıda dosya tarayıcı indirmesi olarak kaydedilir.
   */
  downloadRelayKeys: async (): Promise<void> => {
    const res = await fetch(`${BASE}/relay-keys`, { cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* gövde yok */
      }
      throw new ApiError(
        typeof body.error === "string" ? body.error : `İstek başarısız (${res.status}).`,
        res.status,
        typeof body.code === "string" ? body.code : undefined,
        body,
      );
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = "relay-keys.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};

/** Doğrulama/son deneme kodunun arayüz anahtarı (bilinmeyen kodlar "other"). */
export function verifyCodeKey(code: string, detail: string | null): string {
  if (code === "channel_failed") {
    if (detail === "http_error_401") return "channel_failed_401";
    if (detail === "timeout" || detail === "network") return "channel_failed_network";
    return "channel_failed";
  }
  return VERIFY_CODES.includes(code) ? code : "other";
}

const VERIFY_CODES = [
  "verified",
  "not_configured",
  "no_key",
  "no_channel_key",
  "post_failed",
  "bad_status",
  "not_delivered",
];

/** Sağlık kodunun arayüz anahtarı. */
export function healthCodeKey(code: string): string {
  return HEALTH_CODES.includes(code) ? code : "other";
}

const HEALTH_CODES = [
  "ok",
  "corrupt_events",
  "queue_deep",
  "events_stale",
  "unreachable",
  "no_channel_key",
];

/** Kalan gün sayısı (yukarı yuvarlanmış; geçmişse 0). */
export function daysUntil(ms: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((ms - now) / 86_400_000));
}

/** ARF alan adı metnini (satır/virgül/boşluk ayrımlı) listeye çevirir; boşlar atılır, tekrarlar birleşir. */
export function parseDomainList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase();
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}
