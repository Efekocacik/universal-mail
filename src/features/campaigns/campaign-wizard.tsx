"use client";

import { ArrowLeft, ArrowRight, Check, Compass, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError, Input, Label, Select } from "@/components/ui/input";
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
  const [nameTouched, setNameTouched] = useState(false);

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
  const nameOk = name.trim().length > 0 && name.length <= 120;
  const capOk = dailyCap >= 1 && dailyCap <= 80;
  const gapMinOk = minGapS >= 90;
  const gapMaxOk = maxGapS >= minGapS && maxGapS <= 3600;
  const valid = nameOk && windowOk && capOk && gapMinOk && gapMaxOk;
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
          onBlur={() => setNameTouched(true)}
          disabled={readOnly}
          aria-invalid={(nameTouched && !nameOk) || name.length > 120 ? true : undefined}
        />
        {nameTouched && !nameOk && <FieldError>{t("wizard.err.name")}</FieldError>}
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
        {!windowOk && <FieldError>{t("wizard.window.invalid")}</FieldError>}
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
            aria-invalid={capOk ? undefined : true}
          />
          {!capOk && <FieldError>{t("wizard.err.cap")}</FieldError>}
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
            aria-invalid={gapMinOk ? undefined : true}
          />
          {!gapMinOk && <FieldError>{t("wizard.err.gapMin")}</FieldError>}
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
            aria-invalid={gapMaxOk ? undefined : true}
          />
          {!gapMaxOk && <FieldError>{t("wizard.err.gapMax")}</FieldError>}
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">{t("wizard.limits.note")}</p>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!valid} loading={save.isPending}>
            {campaign ? t("common.save") : t("wizard.create")}
          </Button>
          {!campaign && (
            <Button variant="outline" asChild>
              <Link href="/campaigns">{t("wizard.cancelNew")}</Link>
            </Button>
          )}
          {!valid && (
            <span className="text-[12px] text-muted-foreground">{t("wizard.invalid")}</span>
          )}
        </div>
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
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => save.mutate(undefined)} disabled={!valid} loading={save.isPending}>
            {t("common.save")}
          </Button>
          {!valid && (
            <span className="text-[12px] text-muted-foreground">{t("wizard.steps.invalid")}</span>
          )}
        </div>
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
          <Button size="sm" variant="outline" asChild>
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

/* Özet paneli ------------------------------------------------------------------------------------ */

/** Her adımda görünen "ne gönderilecek" özeti: kullanıcı hiçbir şeyi hatırlamak zorunda kalmaz. */
function WizardSummary({ campaign }: { campaign: CampaignDetail }) {
  const mailboxes = useMailboxes();
  const p = progressOf(campaign.counts);
  const mailbox = mailboxes.data?.find((m) => m.id === campaign.mailboxId);
  const langs = [...new Set(campaign.steps.map((x) => x.language.toUpperCase()))];
  const emailCount = campaign.steps.length
    ? Math.max(...campaign.steps.map((x) => x.stepIndex)) + 1
    : 0;
  const missing = (v: string) => <span className="text-[#8a6700]">{v}</span>;
  const rows: [string, React.ReactNode][] = [
    [
      t("wizard.summary.recipients"),
      p.active > 0 ? (
        <>
          <span className="tabular font-semibold">{fmtNumber(p.active)}</span>
          {p.excluded > 0 && (
            <span className="block text-[12px] font-normal text-muted-foreground">
              {t("wizard.summary.recipientsExcluded", { n: fmtNumber(p.excluded) })}
            </span>
          )}
        </>
      ) : (
        missing(t("wizard.summary.none"))
      ),
    ],
    [
      t("wizard.summary.sender"),
      mailbox ? (
        <>
          {mailbox.label}
          {mailbox.address && (
            <span className="block truncate text-[12px] text-muted-foreground">
              {mailbox.address}
            </span>
          )}
        </>
      ) : campaign.mailboxId ? (
        "…"
      ) : (
        missing(t("wizard.summary.missing"))
      ),
    ],
    [
      t("wizard.summary.languages"),
      langs.length > 0 ? langs.join(", ") : missing(t("wizard.summary.missing")),
    ],
    [
      t("wizard.summary.emails"),
      emailCount > 0
        ? t("wizard.summary.emailsValue", { n: emailCount })
        : missing(t("wizard.summary.missing")),
    ],
    [
      t("wizard.summary.cap"),
      <span key="cap" className="tabular">
        {t("wizard.summary.capValue", { n: fmtNumber(campaign.dailyCap) })}
      </span>,
    ],
    [
      t("wizard.summary.window"),
      <span key="win" className="tabular">
        {campaign.sendWindow.days.map(dayLabel).join(", ")} · {campaign.sendWindow.start}–
        {campaign.sendWindow.end}
      </span>,
    ],
  ];
  return (
    <aside
      aria-label={t("wizard.summary.title")}
      className="um-enter rounded-xl border bg-card p-4 shadow-xs lg:sticky lg:top-4 lg:self-start"
    >
      <h2 className="text-sm font-semibold">{t("wizard.summary.title")}</h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">{t("wizard.summary.hint")}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3 lg:grid-cols-1">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t pt-2 text-[12px] text-muted-foreground">
        {t("wizard.summary.demo")}
      </p>
    </aside>
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
  const back = useSafeMutation(() => campaignApi.control(id!, "draft"), {
    successMessage: t("preflight.backToDraft.done"),
  });

  if (enabled && q.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-12" />
        <Skeleton className="h-72" />
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
  const stepIndex = STEPS.indexOf(step);
  const done: Record<Step, boolean> = {
    basics: !!campaign,
    steps: (campaign?.steps.length ?? 0) > 0,
    leads: campaign ? progressOf(campaign.counts).active > 0 : false,
    review: !!campaign && !["draft", "ready"].includes(campaign.status),
  };

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <Link
          href={campaign ? `/campaigns/${campaign.id}` : "/campaigns"}
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
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
              const isDone = done[s] && !current;
              return (
                <li key={s}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-current={current ? "step" : undefined}
                    onClick={() => go(s)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors duration-150 disabled:opacity-50",
                      current
                        ? "border-primary bg-accent font-medium"
                        : "bg-card hover:bg-accent/60",
                    )}
                  >
                    <span
                      className={cn(
                        "tabular flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] transition-colors duration-150",
                        isDone
                          ? "bg-success text-success-foreground"
                          : current
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted",
                      )}
                    >
                      {isDone ? <Check className="size-3" aria-hidden /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      {t(`wizard.step.${s}`)}
                      {isDone && <span className="sr-only"> ({t("wizard.stepDone")})</span>}
                    </span>
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
              loading={back.isPending}
            >
              {!back.isPending && <Undo2 />} {t("preflight.backToDraft")}
            </Button>
          </Notice>
        )}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0 space-y-4">
            <section key={step} className="um-enter rounded-xl border bg-card p-4 sm:p-5">
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
                <StepsStep
                  key={campaign.updatedAt}
                  campaign={campaign}
                  onSaved={() => go("leads")}
                />
              )}
              {step === "leads" && campaign && <LeadsStep campaign={campaign} />}
              {step === "review" && campaign && <PreflightPanel campaign={campaign} />}
            </section>

            {campaign && (
              <div className="flex items-center justify-between gap-2">
                {stepIndex > 0 ? (
                  <Button variant="outline" onClick={() => go(STEPS[stepIndex - 1]!)}>
                    <ArrowLeft /> {t("wizard.back")}
                  </Button>
                ) : (
                  <span />
                )}
                {step !== "review" && (
                  <Button
                    variant={step === "leads" ? "default" : "outline"}
                    onClick={() => go(STEPS[stepIndex + 1] ?? "review")}
                  >
                    {t("wizard.next")} <ArrowRight />
                  </Button>
                )}
              </div>
            )}
          </div>
          {campaign && <WizardSummary campaign={campaign} />}
        </div>
      </div>
    </div>
  );
}
