"use client";

import { Landmark } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { ScansSubnav } from "@/features/scans/scans-subnav";
import { t } from "@/lib/i18n";

/**
 * `/scans/registry`: resmî sicil çalıştırma formu, çalışma listesi, "haritada eşleşti" ve "sicilde var, haritada eşleşmedi"
 * sekmeleri. P0 yer tutucusu (alt gezinme + boş durum); sahibi: paket R.
 */
export function RegistryPage() {
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <ScansSubnav />
        <PageHeader title={t("registry.title")} description={t("registry.subtitle")} />
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Landmark}
            title={t("faz5.preparing.title")}
            body={t("faz5.preparing.body")}
          />
        </div>
      </div>
    </div>
  );
}
