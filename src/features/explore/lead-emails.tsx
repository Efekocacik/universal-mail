"use client";

import {
  CircleAlert,
  Copy,
  ExternalLink,
  Loader2,
  ShieldCheck,
  ShieldX,
  Star,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label } from "@/components/ui/input";
import { HelpTip, Tip } from "@/components/ui/tooltip";
import { fmtDate } from "@/lib/client/format";
import { useAddEmail, useEmailAction } from "@/lib/client/queries";
import type { LeadDetailResponse, LeadEmailRow } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { FindEmailsButton } from "./find-emails-button";
import { useExplore } from "./state";

function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="um-enter mx-4 my-3 space-y-3 rounded-xl border bg-card p-4 shadow-xs">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
        {title}
        {hint}
      </h3>
      {children}
    </section>
  );
}

const VERIFY_VARIANT = { verified: "high", unverified: "outline", invalid: "warning" } as const;

function EmailItem({ row, leadId }: { row: LeadEmailRow; leadId: number }) {
  const act = useEmailAction(leadId);
  const run = (action: Parameters<typeof act.mutate>[0]["action"]) =>
    act.mutate({ emailId: row.id, action }, { onError: (e: Error) => toast.error(e.message) });
  const source = safeHttpUrl(row.sourceUrl);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = async () => {
    try {
      await act.mutateAsync({ emailId: row.id, action: "delete" });
      toast.success(t("detail.emails.removed"));
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    }
  };
  return (
    <li className="space-y-2 rounded-lg border bg-background p-3 transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 break-all text-[13px] font-medium">{row.email}</span>
        {row.isPrimary && (
          <Badge variant="warning">
            <Star className="size-3 fill-current" aria-hidden /> {t("detail.emails.primary")}
          </Badge>
        )}
        <Tip content={t("common.copy")}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.copy")}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(row.email)
                .then(() => toast.success(t("common.copied")))
            }
          >
            <Copy />
          </Button>
        </Tip>
        <Tip content={t("detail.emails.remove")}>
          <Button
            variant="dangerGhost"
            size="icon"
            aria-label={t("detail.emails.remove")}
            onClick={() => setConfirmOpen(true)}
            disabled={act.isPending}
          >
            <Trash2 />
          </Button>
        </Tip>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title={t("detail.emails.removeTitle")}
        description={t("detail.emails.removeBody")}
        confirmLabel={t("detail.emails.remove")}
        onConfirm={remove}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{t(`emailKind.${row.kind}`)}</Badge>
        <Badge
          variant={VERIFY_VARIANT[row.verifyStatus]}
          title={row.verifyReason ? t(`emailReason.${row.verifyReason}` as never) : undefined}
        >
          {row.verifyStatus === "verified" && <ShieldCheck className="size-3" aria-hidden />}
          {t(`emailVerify.${row.verifyStatus}`)}
          {row.verifyReason && row.verifyStatus !== "verified"
            ? ` · ${t(`emailReason.${row.verifyReason}` as never)}`
            : ""}
        </Badge>
        {!row.siteMatch && <Badge variant="warning">{t("detail.emails.otherDomain")}</Badge>}
        <span className="text-xs text-muted-foreground">
          {t(`emailSource.${row.sourceType}`)} · {fmtDate(row.foundAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {source && (
          <Button asChild variant="ghost" size="sm">
            <a href={source} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> {t("detail.emails.source")}
            </a>
          </Button>
        )}
        {!row.isPrimary && row.verifyStatus !== "invalid" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run("primary")}
            disabled={act.isPending}
            loading={act.isPending && act.variables?.action === "primary"}
          >
            <Star /> {t("detail.emails.makePrimary")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run("reverify")}
          disabled={act.isPending}
          loading={act.isPending && act.variables?.action === "reverify"}
        >
          <RefreshCw /> {t("detail.emails.reverify")}
        </Button>
        {row.verifyStatus === "invalid" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run("valid")}
            disabled={act.isPending}
            loading={act.isPending && act.variables?.action === "valid"}
          >
            <ShieldCheck /> {t("detail.emails.markValid")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run("invalid")}
            disabled={act.isPending}
            loading={act.isPending && act.variables?.action === "invalid"}
          >
            <ShieldX /> {t("detail.emails.markInvalid")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Faz 2: e-posta adresleri, sosyal bağlantılar ve yinelenen kayıtlar (hepsi işletmenin kendi sitesinden; bizim verimiz). */
export function LeadEmails({ data }: { data: LeadDetailResponse }) {
  const ex = useExplore();
  const { lead, emails, contacts, enrichment, duplicates, google } = data;
  const add = useAddEmail(lead.id);
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      setFieldError(t("detail.emails.invalidFormat"));
      return;
    }
    setFieldError(null);
    add.mutate(v, {
      onSuccess: () => {
        setValue("");
        toast.success(t("detail.emails.added"));
      },
      onError: (e: Error) => toast.error(e.message),
    });
  };
  const state = enrichment ? (enrichment.emailStatus ?? enrichment.status) : "unchecked";
  const busy = enrichment?.status === "queued" || enrichment?.status === "running";
  const error = enrichment?.lastError ? t(`enrichError.${enrichment.lastError}` as never) : null;
  const settled = !!enrichment && ["done", "blocked", "no_website"].includes(enrichment.status);

  return (
    <>
      <Section title={t("detail.emails")} hint={<HelpTip>{t("detail.emails.help")}</HelpTip>}>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{t("detail.emails.state")}:</span>
          <Badge variant={busy ? "outline" : "default"}>
            {busy && <Loader2 className="size-3 animate-spin" />}{" "}
            {t(`emailState.${state}` as never)}
          </Badge>
          {enrichment?.nextRetryAt && (
            <span className="text-[12px] text-muted-foreground">
              {t("detail.emails.retry", { when: fmtDate(enrichment.nextRetryAt) })}
            </span>
          )}
        </div>
        {error && enrichment?.status !== "done" && (
          <p className="flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {error}
          </p>
        )}
        {error && enrichment?.status === "done" && (
          <p className="text-[12px] text-muted-foreground">{error}</p>
        )}
        {!google && emails.length === 0 && (
          <p className="text-[12px] text-muted-foreground">{t("detail.emails.needsGoogle")}</p>
        )}

        {emails.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">
            {t("detail.emails.none")}
          </p>
        ) : (
          <ul className="space-y-2">
            {emails.map((e) => (
              <EmailItem key={e.id} row={e} leadId={lead.id} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <FindEmailsButton
            target={{ leadIds: [lead.id] }}
            label={settled ? t("detail.emails.again") : t("detail.emails.find")}
            initialForce={settled}
            variant={emails.length === 0 && !busy && google ? "default" : "outline"}
          />
        </div>

        <div className="space-y-1.5 pt-1">
          <Label htmlFor="add-email">{t("detail.emails.addLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id="add-email"
              type="email"
              value={value}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "add-email-error" : undefined}
              placeholder={t("detail.emails.addPlaceholder")}
              onChange={(e) => {
                setValue(e.target.value);
                if (fieldError) setFieldError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={254}
            />
            <Button onClick={submit} loading={add.isPending} disabled={!value.trim()}>
              {t("detail.emails.add")}
            </Button>
          </div>
          <p
            id="add-email-error"
            role={fieldError ? "alert" : undefined}
            className={`min-h-4 text-[12px] ${fieldError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {fieldError ?? t("detail.emails.addHint")}
          </p>
        </div>
      </Section>

      {contacts.length > 0 && (
        <Section title={t("detail.contacts")}>
          <ul className="flex flex-wrap gap-2">
            {contacts.map((c) => {
              const href = safeHttpUrl(c.url);
              return href ? (
                <li key={c.id}>
                  <Button asChild variant="outline" size="sm">
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                      <ExternalLink /> {t(`contactType.${c.type}`)}
                    </a>
                  </Button>
                </li>
              ) : null;
            })}
          </ul>
        </Section>
      )}

      {duplicates.length > 0 && (
        <Section title={t("detail.duplicates")}>
          <ul className="space-y-1.5">
            {duplicates.map((d) => (
              <li key={d.leadId} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0">
                  <span className="font-medium">
                    {d.displayName ?? `#${d.leadId}`}
                    {d.city ? ` · ${d.city}` : ""}
                  </span>
                  <span className="block text-[12px] text-muted-foreground">
                    {t(`detail.duplicates.${d.reason}`, { value: d.value })}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => ex.select(d.leadId, { focus: true })}
                >
                  {t("detail.duplicates.open")}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
