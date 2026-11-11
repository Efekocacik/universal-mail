"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/campaigns/parts";
import { useMailboxes } from "@/lib/client/campaigns";
import { t } from "@/lib/i18n";

/**
 * Gmail yetkisi geçersiz/iptal edilmiş (ör. `invalid_grant`: izin Google hesabından kaldırıldı ya da "Testing"
 * durumundaki OAuth projesinin 7 günlük yenileme belirteci doldu) gönderen kutular için uyarı bandı. Bu kutuların
 * kampanya gönderimleri yeniden bağlanana kadar ERTELENİR (dizi başarısız sayılmaz). Yalnızca yerel kutu listesini
 * okur; dış servise istek atmaz. Uyarı yoksa veya liste okunamazsa hiçbir şey göstermez.
 */
export function MailboxReauthBanner() {
  const q = useMailboxes();
  const boxes = (q.data ?? []).filter((m) => m.reauthorizationRequired);
  if (boxes.length === 0) return null;
  return (
    <div className="um-enter" data-testid="mailbox-reauth-banner">
      <Notice tone="danger">
        <p className="font-medium">{t("mbx.reauthBanner.title")}</p>
        <p className="text-[12px]">
          {t("mbx.reauthBanner.body", {
            list: boxes.map((m) => m.address ?? m.label).join(", "),
          })}
        </p>
        <Button className="mt-2" size="sm" asChild>
          <Link href="/settings#mailbox">{t("mbx.oauth.reconnect")}</Link>
        </Button>
      </Notice>
    </div>
  );
}
