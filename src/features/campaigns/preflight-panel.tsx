"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Play,
  RefreshCw,
  Undo2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  campaignApi,
  useMailboxes,
  usePreflight,
  type CampaignDetail,
} from "@/lib/client/campaigns";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { EmailPreview } from "./email-preview";
import { blockerHint, blockerLabel, dayLabel, reasonLabel } from "./model";
import { LoadError, Notice, Stat } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

type CheckTone = "ok" | "warn" | "block";

const CHECK_STYLE: Record<CheckTone, { icon: LucideIcon; cls: string }> = {
  ok: { icon: CheckCircle2, cls: "text-success" },
  warn: { icon: AlertTriangle, cls: "text-[#8a6700]" },
  block: { icon: XCircle, cls: "text-destructive" },
};

/** Kontrol listesi satırı: simge (yeşil onay / sarı uyarı / kırmızı engel) + tek cümle + varsa "ne yapmalı". */
function CheckRow({ tone, text, hint }: { tone: CheckTone; text: string; hint?: string | null }) {
  const { icon: Icon, cls } = CHECK_STYLE[tone];
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5 text-[13px]">
      <Icon className={`mt-0.5 size-4 shrink-0 ${cls}`} aria-hidden />
      <div className="min-w-0">
        <p className={tone === "block" ? "font-medium text-destructive" : "font-medium"}>
          <span className="sr-only">{t(`preflight.state.${tone}`)}: </span>
          {text}
        </p>
        {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
      </div>
    </li>
  );
}

/**
 * Başlatma öncesi özet ve açık onay (FR-CMP-04). Başlat düğmesi ancak engel yokken ve kullanıcı onay kutusunu
 * işaretlediğinde açılır; tıklayınca özetleyen bir onay penceresi çıkar ve istek özetin `confirmToken`'ını taşır.
 * Özet eskidiyse (sunucu `PREFLIGHT_STALE`) özet yenilenir ve onay sıfırlanır. Başlatma isteği hiçbir durumda
 * otomatik yeniden gönderilmez.
 */
export function PreflightPanel({ campaign }: { campaign: CampaignDetail }) {
  const router = useRouter();
  const enabled = campaign.status === "ready";
  const pf = usePreflight(campaign.id, enabled);
  const mailboxes = useMailboxes();
  const [confirmed, setConfirmed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Özet değişirse (yeni belirteç) onay yeniden verilmeli.
  const token = pf.data?.confirmToken;
  useEffect(() => setConfirmed(false), [token]);

  const prepare = useSafeMutation(() => campaignApi.control(campaign.id, "ready"), {
    successMessage: t("preflight.prepare.done"),
  });
  const back = useSafeMutation(() => campaignApi.control(campaign.id, "draft"), {
    successMessage: t("preflight.backToDraft.done"),
  });
  const start = useSafeMutation(
    (confirmToken: string) => campaignApi.control(campaign.id, "start", confirmToken),
    {
      successMessage: t("preflight.started"),
      onSuccess: () => router.push(`/campaigns/${campaign.id}`),
      onError: () => {
        setConfirmed(false);
        setDialogOpen(false);
        void pf.refetch();
      },
    },
  );

  if (campaign.status === "draft") {
    return (
      <div className="um-enter space-y-3">
        <Notice>{t("preflight.draft")}</Notice>
        {prepare.error && <BlockerList codes={blockersFrom(prepare.error)} />}
        <Button onClick={() => prepare.mutate(undefined)} loading={prepare.isPending}>
          {t("preflight.prepare")}
        </Button>
      </div>
    );
  }
  if (!enabled) return <Notice>{t("preflight.notApplicable")}</Notice>;
  if (pf.isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-40" />
        <Skeleton className="h-20" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (pf.isError) return <LoadError error={pf.error} onRetry={() => void pf.refetch()} />;
  const r = pf.data!;

  const blocked = r.blockers.length > 0 || !r.ready;
  const missingVars = [...new Set(r.previews.flatMap((p) => p.missing))];
  const mailbox = mailboxes.data?.find((m) => m.id === campaign.mailboxId);
  const win = campaign.sendWindow;
  const disabledReason = blocked
    ? t("preflight.disabled.blockers")
    : !confirmed
      ? t("preflight.disabled.confirm")
      : null;

  return (
    <div className="um-enter space-y-4">
      <section aria-labelledby="pf-check-title" className="space-y-2">
        <h3 id="pf-check-title" className="text-sm font-semibold">
          {t("preflight.check.title")}
        </h3>
        <ul className="divide-y rounded-lg border bg-card">
          {r.blockers.map((c) => (
            <CheckRow key={c} tone="block" text={blockerLabel(c)} hint={blockerHint(c)} />
          ))}
          {r.blockers.length === 0 && <CheckRow tone="ok" text={t("preflight.check.ok")} />}
          {r.counts.eligible > 0 && (
            <CheckRow
              tone="ok"
              text={t("preflight.check.recipients", { n: fmtNumber(r.counts.eligible) })}
            />
          )}
          {r.counts.ineligible > 0 && (
            <CheckRow
              tone="warn"
              text={t("preflight.check.excluded", { n: fmtNumber(r.counts.ineligible) })}
            />
          )}
          {r.estimate.perDay > 0 && (
            <CheckRow
              tone="ok"
              text={t("preflight.check.rate", {
                perDay: fmtNumber(r.estimate.perDay),
                days: fmtNumber(r.estimate.days),
              })}
            />
          )}
          {missingVars.length > 0 && (
            <CheckRow
              tone="warn"
              text={t("preflight.check.missing", { vars: missingVars.join(", ") })}
            />
          )}
          {!blocked && (
            <CheckRow tone={confirmed ? "ok" : "warn"} text={t("preflight.check.review")} />
          )}
        </ul>
      </section>

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
      {r.advisories.map((a) => (
        <Notice key={a.code} tone="warning">
          {t(`preflight.advisory.${a.code}`, { n: a.count })}
        </Notice>
      ))}
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
            <TabsList className="h-auto flex-wrap">
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
                className="mt-2 space-y-2"
              >
                {p.missing.length > 0 && (
                  <Notice tone="warning">
                    {t("preflight.missing", { vars: p.missing.join(", ") })}
                  </Notice>
                )}
                <EmailPreview
                  subject={p.subject}
                  html={p.html}
                  from={
                    mailbox
                      ? `${mailbox.label}${mailbox.address ? ` <${mailbox.address}>` : ""}`
                      : null
                  }
                  to={p.recipientMasked}
                />
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={blocked || !confirmed || start.isPending}
            loading={start.isPending}
            aria-describedby={disabledReason ? "preflight-disabled-reason" : undefined}
          >
            {!start.isPending && <Play />} {t("preflight.start")}
          </Button>
          <Button variant="outline" onClick={() => void pf.refetch()} loading={pf.isFetching}>
            {!pf.isFetching && <RefreshCw />} {t("preflight.refresh")}
          </Button>
          <Button variant="outline" onClick={() => back.mutate(undefined)} loading={back.isPending}>
            {!back.isPending && <Undo2 />} {t("preflight.backToDraft")}
          </Button>
        </div>
        {disabledReason && (
          <p
            id="preflight-disabled-reason"
            className={`flex items-center gap-1.5 text-[12px] ${blocked ? "text-destructive" : "text-muted-foreground"}`}
          >
            {blocked && <XCircle className="size-3.5 shrink-0" aria-hidden />}
            {disabledReason}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        tone="success"
        title={t("preflight.dialog.title")}
        description={t("preflight.dialog.body", {
          n: fmtNumber(r.counts.eligible),
          from: win.start,
          to: win.end,
          cap: fmtNumber(campaign.dailyCap),
        })}
        confirmLabel={t("preflight.start")}
        onConfirm={async () => {
          await start.mutateAsync(r.confirmToken);
        }}
      >
        <p className="text-[12px] text-muted-foreground">
          {win.days.map(dayLabel).join(", ")} · {t("wizard.window.local")}
        </p>
      </ConfirmDialog>
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
    <ul className="divide-y rounded-lg border bg-card" aria-label={t("preflight.blockers")}>
      {codes.map((c) => (
        <CheckRow key={c} tone="block" text={blockerLabel(c)} hint={blockerHint(c)} />
      ))}
    </ul>
  );
}
