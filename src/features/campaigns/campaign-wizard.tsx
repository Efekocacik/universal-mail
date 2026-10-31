"use client";

import { ArrowLeft, Check, Compass, Loader2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import {
  campaignApi,
  useCampaign,
  useMailboxes,
  useTemplates,
  type CampaignDetail,
  type SendWindow,
  type StepInput,
} from "@/lib/client/campaigns";
import { fmtNumber } from "@/lib/client/format";
import type { MutationErrorInfo } from "@/lib/client/retry";
import { t } from "@/lib/i18n";
import {
  dayLabel,
  DEFAULT_WINDOW,
  isValidWindow,
  progressOf,
  WINDOW_DAYS,
  WINDOW_TIMES,
} from "./model";
import { DemoBadge, LoadError, Notice } from "./parts";
import { PreflightPanel } from "./preflight-panel";
import { QueueTable } from "./queue-table";
import { useSafeMutation } from "./use-safe-mutation";

/**
 * Kampanya sihirbazı (FR-CMP-01, 4 adım): temel ayarlar → adımlar → hedef lead'ler → özet ve başlat.
 * Yalnızca `draft` kampanya düzenlenir; `ready` kampanya önce taslağa döndürülür. Her kayıt güncel iyimser kilit
 * belirtecini (`updatedAt`) taşır; çakışmada güncel veri yüklenir ve kullanıcı yeniden karar verir.
 */

const STEPS = ["basics", "steps", "leads", "review"] as const;
type Step = (typeof STEPS)[number];

function FieldIssues({ info, path }: { info: MutationErrorInfo | null; path: string }) {
  const list = info?.issues?.filter((i) => i.path === path || i.path.startsWith(`${path}.`)) ?? [];
  if (list.length === 0) return null;
  return (
    <p className="text-[12px] text-destructive" role="alert">
      {list.map((i) => i.message).join(" ")}
    </p>
  );
}

/* 1. Temel ayarlar ------------------------------------------------------------------------------ */

function BasicsStep({
  campaign,
  onCreated,
}: {
  campaign?: CampaignDetail;
  onCreated: (id: number) => void;
}) {
  const mailboxes = useMailboxes();
  const [name, setName] = useState(campaign?.name ?? "");
  const [mailboxId, setMailboxId] = useState<number | null>(campaign?.mailboxId ?? null);
  const [win, setWin] = useState<SendWindow>(campaign?.sendWindow ?? DEFAULT_WINDOW);
  const [dailyCap, setDailyCap] = useState(campaign?.dailyCap ?? 20);
  const [minGapS, setMinGap] = useState(campaign?.minGapS ?? 90);
  const [maxGapS, setMaxGap] = useState(campaign?.maxGapS ?? 240);
  const [issues, setIssues] = useState<MutationErrorInfo | null>(null);

  // Varsayılan: tek uygun (demo) posta kutusu.
  useEffect(() => {
    if (mailboxId === null && mailboxes.data) {
      const demo = mailboxes.data.find((m) => m.sendable);
      if (demo) setMailboxId(demo.id);
    }
  }, [mailboxes.data, mailboxId]);

  const save = useSafeMutation(
    async () => {
      const input = { name, mailboxId, sendWindow: win, dailyCap, minGapS, maxGapS };
      if (!campaign) return { id: (await campaignApi.create(input)).id };
      await campaignApi.update(campaign.id, campaign.updatedAt, input);
      return { id: campaign.id };
    },
    {
      successMessage: t("common.saved"),
      onSuccess: (r) => {
        setIssues(null);
        onCreated(r.id);
      },
      onError: (info) => setIssues(info),
    },
  );

  const windowOk = isValidWindow(win);
  const valid =
    name.trim().length > 0 &&
    name.length <= 120 &&
    windowOk &&
    dailyCap >= 1 &&
    dailyCap <= 80 &&
    minGapS >= 90 &&
    maxGapS >= minGapS &&
    maxGapS <= 3600;
  const readOnly = campaign !== undefined && campaign.status !== "draft";

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !readOnly) save.mutate(undefined);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="cw-name">{t("wizard.name")}</Label>
        <Input
          id="cw-name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          aria-invalid={name.trim().length === 0 ? undefined : name.length > 120}
        />
        <FieldIssues info={issues} path="name" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cw-mailbox">{t("wizard.mailbox")}</Label>
        {mailboxes.isLoading ? (
          <Skeleton className="h-9" />
        ) : (
          <Select
            id="cw-mailbox"
            value={mailboxId ?? ""}
            onChange={(e) => setMailboxId(e.target.value ? Number(e.target.value) : null)}
            disabled={readOnly}
          >
            <option value="">{t("wizard.mailbox.none")}</option>
            {mailboxes.data?.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.sendable}>
                {m.label}
                {m.address ? ` · ${m.address}` : ""}
                {m.sendable ? "" : ` (${t("wizard.mailbox.disabled")})`}
              </option>
            ))}
          </Select>
        )}
        <p className="text-[12px] text-muted-foreground">{t("wizard.mailbox.note")}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">{t("wizard.window")}</legend>
        <div className="flex flex-wrap gap-3">
          {WINDOW_DAYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-[13px]">
              <Checkbox
                checked={win.days.includes(d)}
                disabled={readOnly}
                onCheckedChange={(v) =>
                  setWin({
                    ...win,
                    days: v === true ? [...win.days, d].sort() : win.days.filter((x) => x !== d),
                  })
                }
              />
              {dayLabel(d)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Label htmlFor="cw-start" className="sr-only">
            {t("wizard.window.start")}
          </Label>
          <Select
            id="cw-start"
            value={win.start}
            onChange={(e) => setWin({ ...win, start: e.target.value })}
            className="w-28"
            disabled={readOnly}
          >
            {WINDOW_TIMES.slice(0, -1).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
          <span aria-hidden>–</span>
          <Label htmlFor="cw-end" className="sr-only">
            {t("wizard.window.end")}
          </Label>
          <Select
            id="cw-end"
            value={win.end}
            onChange={(e) => setWin({ ...win, end: e.target.value })}
            className="w-28"
            disabled={readOnly}
          >
            {WINDOW_TIMES.slice(1).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
          <span className="text-muted-foreground">{t("wizard.window.local")}</span>
        </div>
        {!windowOk && <p className="text-[12px] text-destructive">{t("wizard.window.invalid")}</p>}
        <p className="text-[12px] text-muted-foreground">{t("wizard.window.note")}</p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="cw-cap">{t("wizard.dailyCap")}</Label>
          <Input
            id="cw-cap"
            type="number"
            min={1}
            max={80}
            value={dailyCap}
            onChange={(e) => setDailyCap(Number(e.target.value))}
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cw-min">{t("wizard.gap.min")}</Label>
          <Input
            id="cw-min"
            type="number"
            min={90}
            max={3600}
            value={minGapS}
            onChange={(e) => setMinGap(Number(e.target.value))}
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cw-max">{t("wizard.gap.max")}</Label>
          <Input
            id="cw-max"
            type="number"
            min={90}
            max={3600}
            value={maxGapS}
            onChange={(e) => setMaxGap(Number(e.target.value))}
            disabled={readOnly}
          />
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">{t("wizard.limits.note")}</p>

      {!readOnly && (
        <Button type="submit" disabled={!valid || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}{" "}
          {campaign ? t("common.save") : t("wizard.create")}
        </Button>
      )}
    </form>
  );
}

/* 2. Adımlar ------------------------------------------------------------------------------------ */

function StepsStep({ campaign, onSaved }: { campaign: CampaignDetail; onSaved: () => void }) {
  const templates = useTemplates();
  const initial = useMemo(
    () => (templates.data ?? []).filter((x) => x.kind === "initial"),
    [templates.data],
  );
  const followup = useMemo(
    () => (templates.data ?? []).filter((x) => x.kind === "followup"),
    [templates.data],
  );
  const languages = useMemo(() => [...new Set(initial.map((x) => x.language))].sort(), [initial]);

  const existing = campaign.steps;
  const [selected, setSelected] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      existing.filter((s) => s.stepIndex === 0).map((s) => [s.language, s.templateId]),
    ),
  );
  const [followups, setFollowups] = useState<Record<string, number[]>>(() => {
    const out: Record<string, number[]> = {};
    for (const s of existing.filter((x) => x.stepIndex > 0))
      (out[s.language] ??= [])[s.stepIndex - 1] = s.templateId;
    return out;
  });
  const [extra, setExtra] = useState(() => Math.max(0, ...existing.map((s) => s.stepIndex)));
  const [delays, setDelays] = useState<number[]>(() => [
    existing.find((s) => s.stepIndex === 1)?.delayDays ?? 5,
    existing.find((s) => s.stepIndex === 2)?.delayDays ?? 5,
  ]);
  const [issues, setIssues] = useState<MutationErrorInfo | null>(null);
  const readOnly = campaign.status !== "draft";

  const langs = Object.keys(selected).filter((l) => selected[l]);
  const steps: StepInput[] = langs.flatMap((l) => [
    { stepIndex: 0, language: l, templateId: selected[l]!, delayDays: 0 },
    ...Array.from({ length: extra }, (_, i) => ({
      stepIndex: i + 1,
      language: l,
      templateId: followups[l]?.[i] ?? 0,
      delayDays: delays[i] ?? 5,
    })),
  ]);
  const valid =
    steps.length > 0 &&
    steps.every((s) => s.templateId > 0) &&
    delays.slice(0, extra).every((d) => d >= 5 && d <= 90);

  const save = useSafeMutation(() => campaignApi.setSteps(campaign.id, campaign.updatedAt, steps), {
    successMessage: t("common.saved"),
    onSuccess: () => {
      setIssues(null);
      onSaved();
    },
    onError: setIssues,
  });

  if (templates.isLoading) return <Skeleton className="h-40" />;
  if (templates.isError)
    return <LoadError error={templates.error} onRetry={() => void templates.refetch()} />;

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium">{t("wizard.steps.initial")}</legend>
        {languages.map((l) => (
          <div key={l} className="grid items-center gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
            <label className="flex items-center gap-1.5 text-[13px]">
              <Checkbox
                checked={!!selected[l]}
                disabled={readOnly}
                onCheckedChange={(v) =>
                  setSelected((s) => {
                    const next = { ...s };
                    if (v === true) next[l] = initial.find((x) => x.language === l)!.id;
                    else delete next[l];
                    return next;
                  })
                }
              />
              {l.toUpperCase()}
            </label>
            <Select
              aria-label={t("wizard.steps.template", { lang: l.toUpperCase() })}
              value={selected[l] ?? ""}
              disabled={readOnly || !selected[l]}
              onChange={(e) => setSelected((s) => ({ ...s, [l]: Number(e.target.value) }))}
            >
              {initial
                .filter((x) => x.language === l)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
          </div>
        ))}
        <p className="text-[12px] text-muted-foreground">{t("wizard.steps.langNote")}</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium">{t("wizard.steps.followups")}</legend>
        {followup.length === 0 ? (
          <Notice>{t("wizard.steps.noFollowup")}</Notice>
        ) : (
          <>
            <Select
              aria-label={t("wizard.steps.followupCount")}
              value={extra}
              onChange={(e) => setExtra(Number(e.target.value))}
              disabled={readOnly}
              className="w-48"
            >
              {[0, 1, 2].map((n) => (
                <option key={n} value={n}>
                  {t("wizard.steps.followupN", { n })}
                </option>
              ))}
            </Select>
            {Array.from({ length: extra }, (_, i) => (
              <div key={i} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium">{t("queue.step", { n: i + 2 })}</span>
                  <Label htmlFor={`cw-delay-${i}`}>{t("wizard.delay")}</Label>
                  <Input
                    id={`cw-delay-${i}`}
                    type="number"
                    min={5}
                    max={90}
                    className="w-20"
                    value={delays[i] ?? 5}
                    disabled={readOnly}
                    onChange={(e) =>
                      setDelays((d) => d.map((x, j) => (j === i ? Number(e.target.value) : x)))
                    }
                  />
                </div>
                {langs.map((l) => (
                  <Select
                    key={l}
                    aria-label={t("wizard.steps.followupTemplate", {
                      lang: l.toUpperCase(),
                      n: i + 2,
                    })}
                    value={followups[l]?.[i] ?? ""}
                    disabled={readOnly}
                    onChange={(e) =>
                      setFollowups((f) => {
                        const list = [...(f[l] ?? [])];
                        list[i] = Number(e.target.value);
                        return { ...f, [l]: list };
                      })
                    }
                  >
                    <option value="">
                      {l.toUpperCase()} · {t("wizard.steps.choose")}
                    </option>
                    {followup
                      .filter((x) => x.language === l)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {l.toUpperCase()} · {x.name}
                        </option>
                      ))}
                  </Select>
                ))}
              </div>
            ))}
            <p className="text-[12px] text-muted-foreground">{t("wizard.steps.limitNote")}</p>
          </>
        )}
      </fieldset>
      {issues?.kind === "validation" && <Notice tone="danger">{issues.message}</Notice>}
      {!readOnly && (
        <Button onClick={() => save.mutate(undefined)} disabled={!valid || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} {t("common.save")}
        </Button>
      )}
    </div>
  );
}

/* 3. Hedef lead'ler ----------------------------------------------------------------------------- */

function LeadsStep({ campaign }: { campaign: CampaignDetail }) {
  const p = progressOf(campaign.counts);
  const pending = campaign.counts.pending ?? 0;
  const canAdd = campaign.status === "draft" || campaign.status === "ready";
  return (
    <div className="space-y-4">
      <Notice>{t("wizard.leads.how")}</Notice>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span>
          {t("wizard.leads.counts", {
            pending: fmtNumber(pending),
            excluded: fmtNumber(p.excluded),
          })}
        </span>
        {canAdd && (
          <Button size="sm" asChild>
            <Link href={`/?campaign=${campaign.id}`}>
              <Compass /> {t("wizard.leads.fromExplore")}
            </Link>
          </Button>
        )}
      </div>
      <QueueTable campaignId={campaign.id} canRemove={canAdd} running={false} />
    </div>
  );
}

/* Sihirbaz -------------------------------------------------------------------------------------- */

export function CampaignWizard({ id, initialStep }: { id?: number; initialStep?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(
    (STEPS as readonly string[]).includes(initialStep ?? "") ? (initialStep as Step) : "basics",
  );
  const enabled = id !== undefined;
  const q = useCampaign(id ?? 0, enabled);
  const campaign = enabled ? q.data : undefined;
  const back = useSafeMutation(() => campaignApi.control(id!, "draft"));

  if (enabled && q.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (enabled && (q.isError || !campaign)) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  const closed = campaign && !["draft", "ready"].includes(campaign.status);
  const go = (s: Step) => {
    setStep(s);
    if (campaign) router.replace(`/campaigns/${campaign.id}/edit?step=${s}`);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <Link
          href={campaign ? `/campaigns/${campaign.id}` : "/campaigns"}
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {campaign ? campaign.name : t("campaigns.title")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {campaign ? t("wizard.editTitle") : t("wizard.newTitle")}
          </h1>
          <DemoBadge />
        </div>

        <nav aria-label={t("wizard.progress")}>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STEPS.map((s, i) => {
              const disabled = !campaign && s !== "basics";
              const current = s === step;
              return (
                <li key={s}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-current={current ? "step" : undefined}
                    onClick={() => go(s)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] disabled:opacity-50",
                      current
                        ? "border-primary bg-accent font-medium"
                        : "bg-card hover:bg-accent/60",
                    )}
                  >
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] tabular">
                      {i + 1}
                    </span>
                    {t(`wizard.step.${s}`)}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {closed && <Notice tone="warning">{t("wizard.closed")}</Notice>}
        {campaign?.status === "ready" && step !== "review" && (
          <Notice tone="warning">
            <p>{t("wizard.readyLocked")}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => back.mutate(undefined)}
              disabled={back.isPending}
            >
              <Undo2 /> {t("preflight.backToDraft")}
            </Button>
          </Notice>
        )}

        <section className="rounded-xl border bg-card p-4 sm:p-5">
          {step === "basics" && (
            <BasicsStep
              key={campaign?.updatedAt ?? "new"}
              campaign={campaign}
              onCreated={(newId) => {
                if (!campaign) router.replace(`/campaigns/${newId}/edit?step=steps`);
                else go("steps");
              }}
            />
          )}
          {step === "steps" && campaign && (
            <StepsStep key={campaign.updatedAt} campaign={campaign} onSaved={() => go("leads")} />
          )}
          {step === "leads" && campaign && <LeadsStep campaign={campaign} />}
          {step === "review" && campaign && <PreflightPanel campaign={campaign} />}
        </section>

        {campaign && step !== "review" && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => go(STEPS[STEPS.indexOf(step) + 1] ?? "review")}
            >
              <Check /> {t("wizard.next")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
