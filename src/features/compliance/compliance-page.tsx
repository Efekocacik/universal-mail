"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CampaignsSubnav } from "@/features/campaigns/subnav";
import { t } from "@/lib/i18n";
import { PolicyPanel } from "./policy-panel";
import { SuppressionPanel } from "./suppression-panel";

/** Uyum: ülke politikası ve engel listesi (suppression). Gönderim kuralları her zaman sunucuda uygulanır. */
export function CompliancePage({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab === "suppression" ? "suppression" : "policy");
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <CampaignsSubnav />
        <PageHeader title={t("compliance.title")} description={t("compliance.subtitle")} />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="policy">{t("compliance.tab.policy")}</TabsTrigger>
            <TabsTrigger value="suppression">{t("compliance.tab.suppression")}</TabsTrigger>
          </TabsList>
          <TabsContent value="policy" className="pt-4">
            <PolicyPanel />
          </TabsContent>
          <TabsContent value="suppression" className="pt-4">
            <SuppressionPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
