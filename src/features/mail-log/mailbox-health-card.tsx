"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { HelpTip } from "@/components/ui/tooltip";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import {
  mailOpsApi,
  mk,
  useLiveReadiness,
  useMailboxHealth,
  type LiveReadiness,
} from "@/lib/client/mail-ops";
import type { TrKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { bpToPercent, percentToBp } from "./model";

/** Posta kutusu düzeyi gönderim sağlığı (SRS 5.6.1): oran, durum, durdurma ve eşik sıkılaştırma. */
export function MailboxHealthCard({ mailboxId }: { mailboxId: number }) {
  const q = useMailboxHealth(mailboxId);
  const [reenableOpen, setReenableOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [bounce, setBounce] = useState("");
  const [recipients, setRecipients] = useState("");
  const [guard, setGuard] = useState("");
  useEffect(() => {
    if (q.data) {
      setBounce(bpToPercent(q.data.limits.bounceBp));
      setRecipients(String(q.data.limits.minRecipients));
      setGuard(String(q.data.limits.guardBounces));
    }
  }, [q.data]);

  const reenable = useSafeMutation(() => mailOpsApi.reenableMailbox(mailboxId, why.trim()), {
    invalidate: [mk.health(mailboxId)],
    successMessage: t("health.mb.reenable.done"),
  });
  const tighten = useSafeMutation(
    () => {
      const input: { bounceBp?: number; minRecipients?: number; guardBounces?: number } = {};
      const bp = percentToBp(bounce);
      if (bp !== null) input.bounceBp = bp;
      if (Number.isInteger(Number(recipients))) input.minRecipients = Number(recipients);
      if (Number.isInteger(Number(guard))) input.guardBounces = Number(guard);
      return mailOpsApi.tightenMailboxLimits(input);
    },
    { invalidate: [mk.health(mailboxId)], successMessage: t("health.mb.limits.saved") },
  );

  if (q.isLoading) return <Skeleton className="h-48 rounded-xl" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const h = q.data;
  const { evaluation: ev } = h;
  const stateText =
    ev.state === "exceeded"
      ? t(`health.mb.state.exceeded.${ev.reason ?? "rate"}` as TrKey)
      : ev.state === "ok"
        ? t("health.mb.state.ok")
        : t("health.mb.state.insufficient", {
            recipients: h.stats.recipients,
            min: h.limits.minRecipients,
            guard: h.limits.guardBounces,
          });
  return (
    <section aria-labelledby="mbh-title" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="mbh-title" className="flex items-center gap-1.5 text-sm font-semibold">
        {t("health.mb.title")}
        <HelpTip>{t("help.bounceRate")}</HelpTip>
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("health.mb.help", { days: h.windowDays, rate: bpToPercent(h.limits.bounceBp) })}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="mbh-rate">
        <Badge
          variant={ev.state === "exceeded" ? "danger" : ev.state === "ok" ? "success" : "warning"}
        >
          {stateText}
        </Badge>
        <span>
          {t("health.mb.rate", {
            bounced: h.stats.bounced,
            recipients: h.stats.recipients,
            pct: bpToPercent(h.rateBp),
          })}
        </span>
      </p>
      {h.halted && (
        <Notice tone="danger">
          <p>{t("health.mb.halted")}</p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => setReenableOpen(true)}
          >
            {t("health.mb.reenable")}
          </Button>
        </Notice>
      )}
      <p className="text-[12px] text-muted-foreground">
        {t("health.mb.complaint", {
          n: h.complaint.manualRecords,
          arf: h.complaint.arf.verifiedRecipients,
          pending: h.complaint.arf.pendingReview,
          days: h.complaint.arf.windowDays,
        })}
      </p>

      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          tighten.mutate(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="mbl-bounce">{t("health.mb.limits.bounce")}</Label>
          <Input
            id="mbl-bounce"
            inputMode="decimal"
            value={bounce}
            onChange={(e) => setBounce(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mbl-recipients">{t("health.mb.limits.recipients")}</Label>
          <Input
            id="mbl-recipients"
            inputMode="numeric"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mbl-guard">{t("health.mb.limits.guard")}</Label>
          <Input
            id="mbl-guard"
            inputMode="numeric"
            value={guard}
            onChange={(e) => setGuard(e.target.value)}
          />
        </div>
        <Button type="submit" loading={tighten.isPending}>
          {t("health.mb.limits.save")}
        </Button>
      </form>
      <FieldHint>
        {t("health.mb.limits.hint", {
          rate: bpToPercent(h.floors.bounceBp),
          recipients: h.floors.minRecipients,
          guard: h.floors.guardBounces,
        })}
      </FieldHint>

      <ConfirmDialog
        open={reenableOpen}
        onOpenChange={setReenableOpen}
        tone="danger"
        title={t("health.mb.reenable.title")}
        description={t("health.mb.reenable.body")}
        confirmLabel={t("health.mb.reenable")}
        onConfirm={async () => {
          if (why.trim().length < 10) return;
          try {
            await reenable.mutateAsync(undefined);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="mbh-why">{t("health.mb.reenable.justification")}</Label>
          <Textarea id="mbh-why" value={why} onChange={(e) => setWhy(e.target.value)} />
        </div>
      </ConfirmDialog>
    </section>
  );
}

/** Canlı gönderime hazırlık: salt okunur; gerçek gönderimi AÇMAZ. */
export function ReadinessCard() {
  const q = useLiveReadiness();
  if (q.isLoading) return <Skeleton className="h-48 rounded-xl" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const r: LiveReadiness = q.data;
  return (
    <section aria-labelledby="ready-title" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="ready-title" className="text-sm font-semibold">
        {t("ready.title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t("ready.help")}</p>
      <p className="text-[13px] font-medium" data-testid="ready-summary">
        {t("ready.summary", { blocked: r.blockedCount, unknown: r.unknownCount })}
      </p>
      <ul className="divide-y rounded-lg border" aria-label={t("ready.title")}>
        {r.items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
            <Badge
              variant={
                i.status === "ok" ? "success" : i.status === "blocked" ? "danger" : "warning"
              }
            >
              {t(`ready.status.${i.status}` as TrKey)}
            </Badge>
            <span className="min-w-0 flex-1">
              {t(`ready.item.${i.key}` as TrKey)}
              {i.detail && (
                <span
                  className="block text-[12px] text-muted-foreground"
                  data-testid={`ready-detail-${i.key}`}
                >
                  {t(`ready.detail.${i.detail}` as TrKey)}
                </span>
              )}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {t(`ready.owner.${i.owner}` as TrKey)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
