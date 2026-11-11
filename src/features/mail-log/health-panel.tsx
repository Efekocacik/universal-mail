"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { api } from "@/lib/client/api";
import { useMailboxes, useTemplates } from "@/lib/client/campaigns";
import { countryLabel } from "@/lib/client/format";
import { mailOpsApi, mk, useAutoStop, type DnsReport } from "@/lib/client/mail-ops";
import { queryRetryDelay, shouldRetryQuery } from "@/lib/client/retry";
import type { LeadRow } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { MailboxHealthCard, ReadinessCard } from "./mailbox-health-card";
import { bpToPercent, dnsCodeLabel, dnsStatusLabel, dnsStatusVariant, percentToBp } from "./model";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/* Otomatik durdurma eşikleri ------------------------------------------------------------------------ */

function AutoStopCard() {
  const q = useAutoStop();
  const [recipients, setRecipients] = useState("");
  const [rate, setRate] = useState("");
  useEffect(() => {
    if (q.data) {
      setRecipients(String(q.data.config.minRecipients));
      setRate(bpToPercent(q.data.config.minRateBp));
    }
  }, [q.data]);
  const save = useSafeMutation(
    () => {
      const input: { minRecipients?: number; minRateBp?: number } = {};
      const r = Number(recipients);
      const bp = percentToBp(rate);
      if (Number.isInteger(r)) input.minRecipients = r;
      if (bp !== null) input.minRateBp = bp;
      return mailOpsApi.tightenAutoStop(input);
    },
    {
      invalidate: [mk.autoStop],
      successMessage: t("health.autostop.saved"),
      conflictMessage: t("health.autostop.error.loosening"),
    },
  );
  if (q.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const { config, floors } = q.data;
  return (
    <section aria-labelledby="autostop-title" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="autostop-title" className="text-sm font-semibold">
        {t("health.autostop.title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t("health.autostop.help")}</p>
      <p className="text-[13px]" data-testid="autostop-current">
        {t("health.autostop.current", {
          recipients: config.minRecipients,
          bounces: config.minBounces,
          rate: bpToPercent(config.minRateBp),
        })}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="autostop-recipients">{t("health.autostop.recipients")}</Label>
          <Input
            id="autostop-recipients"
            inputMode="numeric"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="autostop-rate">{t("health.autostop.rate")}</Label>
          <Input
            id="autostop-rate"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <Button type="submit" loading={save.isPending}>
          {t("health.autostop.save")}
        </Button>
      </form>
      <FieldHint>
        {t("health.autostop.hint", {
          recipients: floors.minRecipients,
          rate: bpToPercent(floors.minRateBp),
        })}
      </FieldHint>
    </section>
  );
}

/* DNS denetimi -------------------------------------------------------------------------------------- */

function DnsResult({ report }: { report: DnsReport }) {
  if (report.mode === "demo") return <Notice>{t("health.dns.demo")}</Notice>;
  const rows = [
    { key: "health.dns.spf", item: report.spf },
    { key: "health.dns.dkim", item: report.dkim },
    { key: "health.dns.dmarc", item: report.dmarc },
  ] as const;
  return (
    <ul className="divide-y rounded-lg border" aria-label={t("health.dns.title")}>
      {rows.map(({ key, item }) => (
        <li key={key} className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
          <span className="w-16 font-medium">{t(key)}</span>
          {item ? (
            <>
              <Badge variant={dnsStatusVariant(item.status)}>{dnsStatusLabel(item.status)}</Badge>
              <span className="text-muted-foreground">
                {item.codes.map((c) => dnsCodeLabel(c)).join(" ")}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{t("health.dns.dkim.skipped")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function DnsCard({ mailboxId }: { mailboxId: number }) {
  const [selector, setSelector] = useState("");
  const [report, setReport] = useState<DnsReport | null>(null);
  const [error, setError] = useState(false);
  const check = useSafeMutation(
    () =>
      mailOpsApi.dnsCheck(mailboxId, {
        ...(selector.trim() ? { selector: selector.trim() } : {}),
      }),
    {
      onSuccess: (r) => {
        setError(false);
        setReport(r);
      },
      onError: () => setError(true),
    },
  );
  return (
    <section aria-labelledby="dns-title" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="dns-title" className="text-sm font-semibold">
        {t("health.dns.title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t("health.dns.help")}</p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          check.mutate(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="dns-selector">{t("health.dns.selector")}</Label>
          <Input
            id="dns-selector"
            value={selector}
            placeholder="google"
            onChange={(e) => setSelector(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" loading={check.isPending}>
          {t("health.dns.check")}
        </Button>
      </form>
      {error && <Notice tone="danger">{t("health.dns.error")}</Notice>}
      {report && <DnsResult report={report} />}
    </section>
  );
}

/* Kendime test gönder -------------------------------------------------------------------------------- */

/** Sunucunun satır içinde gösterilen (bildirim yerine) test gönderimi hata kodları. */
const TEST_SEND_INLINE_CODES = [
  "SEND_SCOPE_MISSING",
  "PROFILE_INCOMPLETE",
  "MAILBOX_NOT_READY",
  "IN_PROGRESS",
  "BUILD_FAILED",
  "LIVE_SCOPE",
] as const;

type TestSendFeedback =
  | { kind: "not_sendable" }
  | { kind: "error"; code: (typeof TEST_SEND_INLINE_CODES)[number] }
  | { kind: "sent"; listUnsubscribe: boolean }
  | { kind: "failed"; code: string }
  | { kind: "unknown" };

/**
 * Kendime test gönder. Demo kutusunda örnek ileti demo sağlayıcısına gider; GERÇEK (Gmail) kutuda gerçek bir e-posta
 * yalnızca kutunun kendi adresine gider (alıcı seçilemez) ve gönderimden önce onay istenir.
 */
function TestSendCard({
  mailbox,
}: {
  mailbox: { id: number; address: string | null; scope: "demo" | "live" };
}) {
  const live = mailbox.scope === "live";
  const address = mailbox.address ?? "";
  const ids = `test-${mailbox.id}`;
  const templates = useTemplates();
  const [templateId, setTemplateId] = useState("");
  const [search, setSearch] = useState("");
  const [leadId, setLeadId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const leads = useQuery({
    queryKey: ["mail-ops", "lead-options", q],
    queryFn: () =>
      api<{ rows: LeadRow[] }>(`/api/leads?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(
        (r) => r.rows,
      ),
    placeholderData: keepPreviousData,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
  const rows = useMemo(() => leads.data ?? [], [leads.data]);
  const tpls = useMemo(() => (templates.data ?? []).filter((x) => !x.archived), [templates.data]);
  useEffect(() => {
    if (!leadId && rows.length > 0) setLeadId(String(rows[0]!.leadId));
  }, [rows, leadId]);
  useEffect(() => {
    if (!templateId && tpls.length > 0) setTemplateId(String(tpls[0]!.id));
  }, [tpls, templateId]);
  const [feedback, setFeedback] = useState<TestSendFeedback | null>(null);
  const send = useSafeMutation(
    () =>
      mailOpsApi.testSend(mailbox.id, { templateId: Number(templateId), leadId: Number(leadId) }),
    {
      invalidate: [mk.all],
      ...(live ? {} : { successMessage: t("health.test.sent") }),
      silentCodes: live ? TEST_SEND_INLINE_CODES : [],
      onSuccess: (r) => {
        if (!live) return setFeedback(null);
        if (r.outcome === "sent") setFeedback({ kind: "sent", listUnsubscribe: r.listUnsubscribe });
        else if (r.outcome === "failed") setFeedback({ kind: "failed", code: r.code ?? "" });
        else setFeedback({ kind: "unknown" });
      },
      onError: (info) => {
        if (info.code === "NOT_SENDABLE") return setFeedback({ kind: "not_sendable" });
        const inline = TEST_SEND_INLINE_CODES.find((c) => c === info.code);
        setFeedback(live && inline ? { kind: "error", code: inline } : null);
      },
    },
  );
  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id={`${ids}-title`} className="text-sm font-semibold">
        {live ? t("health.test.liveTitle") : t("health.test.title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {live ? t("health.test.liveHelp", { address }) : t("health.test.help")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-template`}>{t("health.test.template")}</Label>
          <Select
            id={`${ids}-template`}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {tpls.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.language.toUpperCase()})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-search`}>{t("health.test.search")}</Label>
          <Input id={`${ids}-search`} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${ids}-lead`}>{t("health.test.lead")}</Label>
          <Select id={`${ids}-lead`} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            {rows.length === 0 && <option value="">{t("health.test.noLeads")}</option>}
            {rows.map((l) => (
              <option key={l.leadId} value={l.leadId}>
                {[l.displayName?.trim() || `#${l.leadId}`, l.city, countryLabel(l.countryCode)]
                  .filter(Boolean)
                  .join(" · ")}
              </option>
            ))}
          </Select>
          {live && <FieldHint>{t("health.test.liveLeadHint")}</FieldHint>}
        </div>
      </div>
      {feedback?.kind === "not_sendable" && (
        <Notice tone="warning">{t("health.test.notSendable")}</Notice>
      )}
      {feedback?.kind === "error" && (
        <Notice tone="warning">{t(`health.test.error.${feedback.code}`)}</Notice>
      )}
      {feedback?.kind === "sent" && (
        <Notice>
          {t("health.test.liveSent", { address })}
          {!feedback.listUnsubscribe && <> {t("health.test.liveNoUnsubscribe")}</>}
        </Notice>
      )}
      {feedback?.kind === "failed" && (
        <Notice tone="danger">{t("health.test.liveFailed", { code: feedback.code })}</Notice>
      )}
      {feedback?.kind === "unknown" && (
        <Notice tone="warning">{t("health.test.liveUnknown")}</Notice>
      )}
      <Button
        variant={live ? "success" : "default"}
        loading={send.isPending}
        disabled={!templateId || !leadId}
        onClick={() => (live ? setConfirmOpen(true) : send.mutate(undefined))}
      >
        {live ? t("health.test.liveSend") : t("health.test.send")}
      </Button>
      {live && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone="success"
          title={t("health.test.liveConfirmTitle")}
          description={t("health.test.liveConfirmBody", { address })}
          confirmLabel={t("health.test.liveConfirm")}
          pending={send.isPending}
          onConfirm={async () => {
            setFeedback(null);
            await send.mutateAsync(undefined).catch(() => undefined);
          }}
        />
      )}
    </section>
  );
}

/** Gönderim sağlığı: otomatik durdurma eşikleri, alan adı denetimi ve kendime test gönder. */
export function HealthPanel() {
  const boxes = useMailboxes();
  const demo = (boxes.data ?? []).find((m) => m.scope === "demo" && m.status === "connected");
  // Gerçek kendine test (C11): bağlı Gmail kutuları (gönderim izni sunucuda denetlenir).
  const gmail = (boxes.data ?? []).filter(
    (m) => m.scope === "live" && m.provider === "gmail" && m.status === "connected" && m.address,
  );
  return (
    <div className="space-y-4">
      <Notice>{t("health.demoNote")}</Notice>
      {demo && <MailboxHealthCard mailboxId={demo.id} />}
      <AutoStopCard />
      {demo && <DnsCard mailboxId={demo.id} />}
      {demo && <TestSendCard mailbox={demo} />}
      {gmail.map((m) => (
        <TestSendCard key={m.id} mailbox={m} />
      ))}
      <ReadinessCard />
    </div>
  );
}
