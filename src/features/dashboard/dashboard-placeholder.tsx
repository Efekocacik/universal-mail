"use client";

import { LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { t } from "@/lib/i18n";

/** Gösterge paneli yer tutucusu (Faz 4 P0): gezinme öğesi çalışsın diye. Paket E bu dosyayı gerçek panelle değiştirir. */
export function DashboardPlaceholder() {
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <PageHeader title={t("dash.title")} description={t("dash.desc")} />
        <EmptyState
          icon={LayoutDashboard}
          title={t("dash.title")}
          body={t("dash.placeholder")}
          action={
            <Button asChild>
              <Link href="/">{t("dash.cta.explore")}</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
