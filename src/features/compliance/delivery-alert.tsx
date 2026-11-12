"use client";

import { useQuery } from "@tanstack/react-query";
import { Notice } from "@/features/campaigns/parts";
import { api } from "@/lib/client/api";
import { DELIVERY_ALERTS_KEY } from "@/lib/client/unsubscribe";
import { queryRetryDelay, shouldRetryQuery } from "@/lib/client/retry";
import { t } from "@/lib/i18n";
import { deliveryAlertText, deliveryAlertTone, type DeliveryAlert } from "./delivery-alert-model";

/**
 * Çıkış teslimatı uyarı bandı (C14 / TB-4). Kampanya ve uyum sayfalarının üstünde gösterilir; yalnızca saklanan
 * son sağlık kaydı ve doğrulama kanıtı okunur (yerel, salt okunur uç). Aktarıcıya istek atılmaz, sağlık denetimi
 * başlatılmaz. Uyarı yoksa, yüklenirken veya okuma başarısızsa hiçbir şey gösterilmez (sayfanın asıl içeriğini
 * engellemeyen ikincil bilgi).
 */
export function DeliveryAlertBanner() {
  const q = useQuery({
    queryKey: DELIVERY_ALERTS_KEY,
    queryFn: () => api<{ alerts: DeliveryAlert[] }>("/api/compliance/delivery-alerts"),
    staleTime: 60_000,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
  const alerts = q.data?.alerts ?? [];
  const tone = deliveryAlertTone(alerts);
  if (!tone) return null;
  return (
    <div className="um-enter" data-testid="delivery-alert">
      <Notice tone={tone}>
        <p className="font-medium">{t("deliveryAlert.title")}</p>
        <ul className="mt-0.5 space-y-0.5">
          {alerts.map((a) => (
            <li key={a.kind}>{deliveryAlertText(a)}</li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}
