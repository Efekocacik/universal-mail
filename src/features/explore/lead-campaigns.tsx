"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CampaignStatusBadge, ReasonList, SequenceStatusBadge } from "@/features/campaigns/parts";
import { reasonLabel } from "@/features/campaigns/model";
import { HelpTip } from "@/components/ui/tooltip";
import { api } from "@/lib/client/api";
import { ck } from "@/lib/client/campaigns";
import { queryRetryDelay, shouldRetryQuery } from "@/lib/client/retry";
import type { LeadCampaignItem } from "@/lib/campaigns/lead-campaigns";
import { t } from "@/lib/i18n";

/**
 * Lead'in kampanyalardaki durumu ve hariç tutulma gerekçeleri (SRS Bölüm 13, madde 12). Salt okunur; kampanyası
 * olmayan lead'de bölüm hiç görünmez.
 */
export function LeadCampaigns({ leadId }: { leadId: number }) {
  const q = useQuery({
    queryKey: [...ck.all, "lead", leadId],
    queryFn: () =>
      api<{ items: LeadCampaignItem[] }>(`/api/leads/${leadId}/campaigns`).then((r) => r.items),
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby={`lead-campaigns-${leadId}`}
      className="um-enter mx-4 my-3 space-y-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <h3
        id={`lead-campaigns-${leadId}`}
        className="flex items-center gap-1.5 text-[13px] font-semibold"
      >
        {t("leadCampaigns.title")}
        <HelpTip>{t("leadCampaigns.help")}</HelpTip>
      </h3>
      <ul className="divide-y">
        {items.map((c) => (
          <li key={c.sequenceId} className="space-y-1.5 py-2 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/campaigns/${c.campaignId}`}
                className="text-[13px] font-medium hover:underline"
              >
                {c.campaignName}
              </Link>
              <CampaignStatusBadge status={c.campaignStatus} />
              <SequenceStatusBadge status={c.sequenceStatus} />
            </div>
            {c.exclusionReasons.length > 0 && (
              <div className="space-y-1">
                <p className="text-[12px] text-muted-foreground">{t("leadCampaigns.excluded")}</p>
                <ReasonList codes={c.exclusionReasons} />
              </div>
            )}
            {c.exclusionReasons.length === 0 && c.lastError && (
              <p className="text-[12px] text-muted-foreground">{reasonLabel(c.lastError)}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
