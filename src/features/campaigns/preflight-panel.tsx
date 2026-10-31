"use client";

import { Loader2, Play, RefreshCw, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { campaignApi, usePreflight, type CampaignDetail } from "@/lib/client/campaigns";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { EmailPreview } from "./email-preview";
import { blockerLabel, reasonLabel } from "./model";
import { LoadError, Notice, Stat } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

/**
 * Başlatma öncesi özet ve açık onay (FR-CMP-04). Başlat düğmesi ancak engel yokken ve kullanıcı onay kutusunu
 * işaretlediğinde açılır; istek özetin `confirmToken`'ını taşır. Özet eskidiyse (sunucu `PREFLIGHT_STALE`) özet
 * yenilenir ve onay sıfırlanır. Başlatma isteği hiçbir durumda otomatik yeniden gönderilmez.
 */
export function PreflightPanel({ campaign }: { campaign: CampaignDetail }) {
  const router = useRouter();
  const enabled = campaign.status === "ready";
  const pf = usePreflight(campaign.id, enabled);
  const [confirmed, setConfirmed] = useState(false);

  // Özet değişirse (yeni belirteç) onay yeniden verilmeli.
  const token = pf.data?.confirmToken;
  useEffect(() => setConfirmed(false), [token]);

  const prepare = useSafeMutation(() => campaignApi.control(campaign.id, "ready"));
  const back = useSafeMutation(() => campaignApi.control(campaign.id, "draft"));
  const start = useSafeMutation(
    (confirmToken: string) => campaignApi.control(campaign.id, "start", confirmToken),
    {
      successMessage: t("preflight.started"),
      onSuccess: () => router.push(`/campaigns/${campaign.id}`),
      onError: () => {
        setConfirmed(false);
        void pf.refetch();
      },
    },
  );

  if (campaign.status === "draft") {
    return (
      <div className="space-y-3">
        <Notice>{t("preflight.draft")}</Notice>
        {prepare.error && <BlockerList codes={blockersFrom(prepare.error)} />}
        <Button onClick={() => prepare.mutate(undefined)} disabled={prepare.isPending}>
          {prepare.isPending && <Loader2 className="animate-spin" />} {t("preflight.prepare")}
        </Button>
      </div>
    );
  }
  if (!enabled) return <Notice>{t("preflight.notApplicable")}</Notice>;
  if (pf.isLoading) return <Skeleton className="h-48" />;
  if (pf.isError) return <LoadError error={pf.error} onRetry={() => void pf.refetch()} />;
  const r = pf.data!;

  return (
    <div className="space-y-4">
      {r.blockers.length > 0 ? (
        <BlockerList codes={r.blockers} />
      ) : (
        <Notice>{t("preflight.noBlockers")}</Notice>
      )}

      <div className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-4">
        <Stat label={t("preflight.eligible")} value={fmtNumber(r.counts.eligible)} />
        <Stat label={t("preflight.ineligible")} value={fmtNumber(r.counts.ineligible)} />
        <Stat label={t("preflight.perDay")} value={fmtNumber(r.estimate.perDay)} />
        <Stat
          label={t("preflight.days")}
          value={fmtNumber(r.estimate.days)}
          hint={t("preflight.days.hint")}
        />
      </div>
      {r.estimate.earliestSendAt && (
        <p className="text-[13px] text-muted-foreground">
          {t("preflight.earliest", { at: fmtDateTime(r.estimate.earliestSendAt) })}
        </p>
      )}
      {Object.keys(r.exclusions).length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold">{t("preflight.exclusions")}</h3>
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {Object.entries(r.exclusions).map(([code, n]) => (
              <li key={code} className="flex justify-between gap-4">
                <span>{reasonLabel(code)}</span>
                <span className="tabular">{fmtNumber(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.previews.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-semibold">
            {t("preflight.previews", { n: r.previews.length })}
          </h3>
          <Tabs defaultValue={String(r.previews[0]!.campaignLeadId)}>
            <TabsList className="flex-wrap">
              {r.previews.map((p, i) => (
                <TabsTrigger key={p.campaignLeadId} value={String(p.campaignLeadId)}>
                  {i + 1}. {p.recipientMasked ?? p.language}
                </TabsTrigger>
              ))}
            </TabsList>
            {r.previews.map((p) => (
              <TabsContent
                key={p.campaignLeadId}
                value={String(p.campaignLeadId)}
                className="space-y-2"
              >
                {p.missing.length > 0 && (
                  <Notice tone="warning">
                    {t("preflight.missing", { vars: p.missing.join(", ") })}
                  </Notice>
                )}
                <EmailPreview subject={p.subject} html={p.html} />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      )}

      <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
        <label className="flex items-start gap-2 text-[13px]">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            disabled={!r.ready}
            aria-describedby="preflight-confirm-note"
          />
          <span>{t("preflight.confirm")}</span>
        </label>
        <p id="preflight-confirm-note" className="text-[12px] text-muted-foreground">
          {t("preflight.confirm.note")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => start.mutate(r.confirmToken)}
            disabled={!r.ready || !confirmed || start.isPending}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}{" "}
            {t("preflight.start")}
          </Button>
          <Button variant="outline" onClick={() => void pf.refetch()} disabled={pf.isFetching}>
            <RefreshCw /> {t("preflight.refresh")}
          </Button>
          <Button variant="ghost" onClick={() => back.mutate(undefined)} disabled={back.isPending}>
            <Undo2 /> {t("preflight.backToDraft")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function blockersFrom(error: unknown): string[] {
  const body = (error as { body?: { blockers?: unknown } })?.body;
  return Array.isArray(body?.blockers) ? (body.blockers as string[]) : [];
}

function BlockerList({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null;
  return (
    <Notice tone="warning">
      <p className="font-medium">{t("preflight.blockers")}</p>
      <ul className="mt-1 list-disc pl-4">
        {codes.map((c) => (
          <li key={c}>{blockerLabel(c)}</li>
        ))}
      </ul>
    </Notice>
  );
}
