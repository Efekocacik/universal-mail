"use client";

import { Landmark } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { companyTitle, pickLeadRegistryCompany, useLeadRegistry } from "@/lib/client/registry";
import { t } from "@/lib/i18n";

/**
 * Lead ayrıntısında "Sicilde kayıtlı" rozeti: lead'in yeri bir sicil kaydıyla eşleştiyse veya lead sicilden
 * oluşturulduysa görünür. Ayrıntı (sicil adı, kuruluş tarihi) ipucunda ve ekran okuyucu metnindedir; renk tek başına
 * anlam taşımaz (simge + metin).
 */
export function RegistryMatchBadge({ leadId }: { leadId: number }) {
  const { data } = useLeadRegistry(leadId);
  const c = pickLeadRegistryCompany(data?.items, leadId);
  if (!c) return null;
  const detail = t("registry.matchBadge.detail", {
    name: companyTitle(c).primary,
    date: c.incorporatedOn,
  });
  const label = c.isDemo ? `${detail} · ${t("registry.matchBadge.demo")}` : detail;
  return (
    <Tip content={label}>
      <Badge variant="info" tabIndex={0} data-testid="registry-match-badge">
        <Landmark className="size-3" aria-hidden />
        {t("registry.matchBadge")}
        <span className="sr-only">. {label}</span>
      </Badge>
    </Tip>
  );
}
