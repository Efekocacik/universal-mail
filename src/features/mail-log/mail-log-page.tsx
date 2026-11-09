"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CampaignsSubnav } from "@/features/campaigns/subnav";
import { t } from "@/lib/i18n";
import { AuditPanel } from "./audit-panel";
import { HealthPanel } from "./health-panel";
import { ReviewPanel } from "./review-panel";
import { SendLogPanel } from "./send-log-panel";

const TABS = ["send", "review", "audit", "health"] as const;

/** Günlük: gönderim günlüğü, inceleme kuyruğu, işlem kaydı ve gönderim sağlığı. */
export function MailLogPage({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState(
    (TABS as readonly string[]).includes(initialTab ?? "") ? initialTab! : "send",
  );
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <CampaignsSubnav />
        <PageHeader title={t("mlog.title")} description={t("mlog.subtitle")} />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="send">{t("mlog.tab.send")}</TabsTrigger>
            <TabsTrigger value="review">{t("mlog.tab.review")}</TabsTrigger>
            <TabsTrigger value="audit">{t("mlog.tab.audit")}</TabsTrigger>
            <TabsTrigger value="health">{t("mlog.tab.health")}</TabsTrigger>
          </TabsList>
          <TabsContent value="send" className="pt-4">
            <SendLogPanel />
          </TabsContent>
          <TabsContent value="review" className="pt-4">
            <ReviewPanel />
          </TabsContent>
          <TabsContent value="audit" className="pt-4">
            <AuditPanel />
          </TabsContent>
          <TabsContent value="health" className="pt-4">
            <HealthPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
