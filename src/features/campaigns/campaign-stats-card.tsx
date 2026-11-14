"use client";

import { Eye, Split } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/misc";
import { useCampaignStats, type CampaignStats, type VariantStats } from "@/lib/client/campaigns";
import { fmtNumber } from "@/lib/client/format";
import { getLocale, intlLocale, t } from "@/lib/i18n";
import { LoadError } from "./parts";

/**
 * Kampanya ayrıntısı → Genel bakış: A/B konu denemesi tablosu ve açılma özeti (Faz 5). Sayılar sunucudan; açılma
 * verisinin kesin olmadığı her zaman yazılır. Renk tek başına anlam taşımaz (tablo + metin).
 */

/** Yanıt oranı (etkin dilde yüzde, tam sayı: "%40" / "40%"); gönderim yoksa "–". */
export function replyRate(v: VariantStats): string {
  if (v.sent <= 0) return "–";
  return new Intl.NumberFormat(intlLocale(getLocale()), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(v.replied / v.sent);
}

/** Gösterilecek A/B satırları: veri varsa o, yoksa (şablonda B konusu olan kampanya) sıfırlar; ikisi de yoksa null. */
export function abRows(
  stats: Pick<CampaignStats, "ab">,
  abConfigured: boolean,
): { a: VariantStats; b: VariantStats } | null {
  if (stats.ab) return stats.ab;
  if (!abConfigured) return null;
  const zero = { sent: 0, replied: 0, opened: 0 };
  return { a: zero, b: zero };
}

export function CampaignStatsCard({
  campaignId,
  running,
  abConfigured,
}: {
  campaignId: number;
  running: boolean;
  /** Adım 0 şablonlarından birinde B konusu var mı (henüz gönderim yokken de tabloyu göstermek için)? */
  abConfigured: boolean;
}) {
  const q = useCampaignStats(campaignId, running);
  if (q.isLoading) return <Skeleton className="h-32 rounded-lg" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const rows = abRows(s, abConfigured);
  return (
    <section
      aria-labelledby="campaign-stats-title"
      className="space-y-4 rounded-lg border bg-card p-4"
      data-testid="campaign-stats"
    >
      <h2 id="campaign-stats-title" className="text-sm font-semibold">
        {t("campaignStats.title")}
      </h2>

      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <Split className="size-3.5" aria-hidden /> {t("campaignStats.ab.title")}
        </h3>
        {rows ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="campaign-stats-ab">
              <thead>
                <tr className="text-left text-[12px] text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("campaignStats.col.variant")}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t("campaignStats.col.sent")}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t("campaignStats.col.replied")}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t("campaignStats.col.replyRate")}
                  </th>
                  {s.opens.enabled && (
                    <th scope="col" className="py-1 text-right font-medium">
                      {t("campaignStats.col.opened")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="tabular">
                {(["a", "b"] as const).map((v) => (
                  <tr key={v} className="border-t">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                      {t(`campaignStats.variant.${v}`)}
                    </th>
                    <td className="py-1.5 pr-3 text-right">{fmtNumber(rows[v].sent)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmtNumber(rows[v].replied)}</td>
                    <td className="py-1.5 pr-3 text-right">{replyRate(rows[v])}</td>
                    {s.opens.enabled && (
                      <td className="py-1.5 text-right">{fmtNumber(rows[v].opened)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t("campaignStats.ab.none")}</p>
        )}
      </div>

      <div className="space-y-1.5" data-testid="campaign-stats-opens">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <Eye className="size-3.5" aria-hidden /> {t("campaignStats.opens.title")}
        </h3>
        {s.opens.enabled ? (
          <p className="tabular text-[14px] font-medium">
            {t("campaignStats.opens.value", {
              opened: fmtNumber(s.opens.opened),
              sent: fmtNumber(s.opens.sent),
            })}
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {t("campaignStats.opens.off")}{" "}
            <Link href="/settings#tracking" className="underline">
              {t("campaignStats.openSettings")}
            </Link>
          </p>
        )}
        <p className="text-[12px] text-muted-foreground">{t("campaignStats.opens.disclaimer")}</p>
        {!s.opens.liveSupported && (
          <p className="text-[12px] text-muted-foreground">{t("campaignStats.opens.demoOnly")}</p>
        )}
      </div>
    </section>
  );
}
