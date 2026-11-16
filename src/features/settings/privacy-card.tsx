import { Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpTip } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { privacyServiceRows } from "@/lib/net/privacy-view";

const POINTS = [
  "security.point.local",
  "security.point.secrets",
  "security.point.demo",
  "security.point.noTelemetry",
] as const;

/**
 * Ayarlar: "Güvenlik ve gizlilik" kartı (Faz 6, paket G, NFR-01/02). Uygulamanın verileri nerede tuttuğunu ve hangi dış
 * hizmete NE ZAMAN bağlanabileceğini teknik olmayan bir dille gösterir. Durumsuzdur (sorgu yok); liste
 * `src/lib/net/egress-allowlist.ts`'den gelir, böylece kod, test ve belge ile aynı kalır. Ayarlar sayfasında `#security`
 * bölümü olarak gösterilir (diğer bölümlerle aynı kart düzeni, "Bu nedir?" balonuyla).
 */
export function PrivacyCard() {
  const rows = privacyServiceRows();
  return (
    <Card
      className="um-enter"
      role="region"
      aria-labelledby="privacy-card-title"
      data-testid="privacy-card"
    >
      <CardHeader>
        <CardTitle id="privacy-card-title" className="flex items-center gap-1.5 text-base">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          {t("security.title")}
          <HelpTip>{t("security.help")}</HelpTip>
        </CardTitle>
        <CardDescription>{t("security.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        <ul className="list-disc space-y-1 pl-5 text-[12px]">
          {POINTS.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <div>
          <p className="text-[12px] font-medium">{t("security.services.title")}</p>
          <p className="text-[12px] text-muted-foreground">{t("security.services.desc")}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="sr-only">{t("security.services.title")}</caption>
            <thead className="text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("security.col.service")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("security.col.when")}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t("security.col.hosts")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.service} className="border-t align-top" data-service={r.service}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium whitespace-nowrap">
                    {t(r.nameKey)}
                  </th>
                  <td className="py-1.5 pr-3">{t(r.whenKey)}</td>
                  <td className="py-1.5 font-mono text-[11px] text-muted-foreground">
                    {r.hosts.map((h) => (
                      <div key={h}>{h}</div>
                    ))}
                    {r.moreHosts > 0 && <div>{t("security.hosts.more", { n: r.moreHosts })}</div>}
                    {r.dynamic && (
                      <div className="font-sans italic">{t("security.hosts.dynamic")}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
