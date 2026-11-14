"use client";

import { FileSpreadsheet } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { ScansSubnav } from "@/features/scans/scans-subnav";
import { t } from "@/lib/i18n";

/**
 * `/scans/import`: dosya seçimi, önizleme ve sütun eşleme, kaynak notu + kullanım onayı, içe aktarma, sonuç ve geçmiş.
 * P0 yer tutucusu (alt gezinme + boş durum); sahibi: paket I.
 */
export function ImportPage() {
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <ScansSubnav />
        <PageHeader title={t("imports.title")} description={t("imports.subtitle")} />
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={FileSpreadsheet}
            title={t("faz5.preparing.title")}
            body={t("faz5.preparing.body")}
          />
        </div>
      </div>
    </div>
  );
}
