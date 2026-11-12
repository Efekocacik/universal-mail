"use client";

import { ArrowLeft, Check, CircleAlert, ExternalLink, Globe, MapPin, Phone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NoveltyBadge } from "@/components/novelty-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/misc";
import { HelpTip } from "@/components/ui/tooltip";
import {
  countryLabel,
  fmtDate,
  fmtNumber,
  fmtOpeningDate,
  fmtRelativeDays,
  typeLabel,
} from "@/lib/client/format";
import { useLead, usePatchLead } from "@/lib/client/queries";
import type { LeadDetailResponse } from "@/lib/client/types";
import { t, type TrKey } from "@/lib/i18n";
import { signalText } from "@/lib/novelty/signal-text";
import { GoogleLoadButton } from "./google-load-button";
import { LeadCampaigns } from "./lead-campaigns";
import { LeadEmails } from "./lead-emails";
import { useExplore } from "./state";

const LEAD_STATUSES = [
  "new",
  "enriched",
  "queued",
  "sent",
  "replied",
  "not_interested",
  "customer",
  "do_not_contact",
] as const;

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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Alan adı yaşı satırı: kayıt tarihi ve yaklaşık yaş; tarih yoksa sade durum metni. */
function domainAgeText(d: NonNullable<LeadDetailResponse["domainAge"]>): string {
  if (d.status === "ok" && d.registeredAt !== null) {
    const months = Math.max(0, Math.round((Date.now() - d.registeredAt) / (30.44 * 86_400_000)));
    return t("detail.domainAge.value", { date: fmtDate(d.registeredAt), months });
  }
  return t(`detail.domainAge.${d.status === "ok" ? "pending" : d.status}` as TrKey);
}

export function LeadDetail({ id }: { id: number }) {
  const ex = useExplore();
  const { data, isLoading, error } = useLead(id);

  return (
    <div className="um-scroll flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/30">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-2">
        <Button variant="outline" size="sm" onClick={() => ex.select(null)}>
          <ArrowLeft /> {t("detail.back")}
        </Button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          <Kbd>Esc</Kbd>
        </span>
      </div>
      {isLoading && (
        <div className="space-y-3 p-4" role="status" aria-busy="true">
          <Skeleton className="h-[148px] w-full" />
          <Skeleton className="h-[120px] w-full" />
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[260px] w-full" />
        </div>
      )}
      {error && (
        <div className="m-4 space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">{(error as Error).message}</p>
          <p className="text-[13px] text-muted-foreground">{t("detail.loadError")}</p>
        </div>
      )}
      {data && <DetailBody data={data} />}
    </div>
  );
}

function DetailBody({ data }: { data: LeadDetailResponse }) {
  const { lead, place } = data;
  const patch = usePatchLead(lead.id);
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [displayName, setDisplayName] = useState(lead.displayName ?? "");
  const [tag, setTag] = useState("");
  const [saved, setSaved] = useState(false);
  // Faz 4 (paket C): "İletişime geçme" işaretini kaldırmak açık onay ister (sunucu `confirmUnblock` olmadan 409 verir).
  const [unblockTo, setUnblockTo] = useState<string | null>(null);

  useEffect(() => {
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.notes]);
  useEffect(() => {
    setDisplayName(lead.displayName ?? "");
  }, [lead.id, lead.displayName]);

  const save = (vars: Parameters<typeof patch.mutate>[0]) =>
    patch.mutate(vars, {
      onSuccess: () => setSaved(true),
      onError: (e: Error) => toast.error(e.message),
    });

  const commitDisplayName = () => {
    const v = displayName.trim();
    if ((lead.displayName ?? "") === v) return;
    save({ displayName: v === "" ? null : v });
  };

  const commitNotes = () => {
    if ((lead.notes ?? "") === notes) return;
    save({ notes: notes.trim() === "" ? null : notes });
  };
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(id);
  }, [saved]);

  const addTag = () => {
    const v = tag.trim();
    if (!v || lead.tags.includes(v)) return setTag("");
    save({ tags: [...lead.tags, v] });
    setTag("");
  };

  if (!place) return <p className="p-4 text-sm text-muted-foreground">{t("detail.noPlace")}</p>;

  const g = data.google;
  const mapsUrl = safeHttpUrl(place.mapsUrl) ?? "https://www.google.com/maps";
  const website = safeHttpUrl(g?.website);
  const status =
    g?.businessStatus ??
    (place.isClosed ? "CLOSED_PERMANENTLY" : place.wasFuture ? "FUTURE_OPENING" : "OPERATIONAL");
  const isFuture = status === "FUTURE_OPENING";
  const title = g?.name ?? lead.displayName;

  return (
    <>
      <div className="um-enter mx-4 mt-4 space-y-2 rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex items-start gap-2">
          <h2
            className={`min-w-0 flex-1 text-lg font-semibold leading-snug ${title ? "" : "text-muted-foreground"}`}
          >
            {title ?? t("detail.unnamed")}
          </h2>
          {place.source === "demo" && <Badge variant="outline">DEMO</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <NoveltyBadge label={lead.noveltyLabel} score={lead.noveltyScore} showScore />
          {g?.primaryType && <Badge variant="outline">{typeLabel(g.primaryType)}</Badge>}
          {isFuture && (
            <Badge variant="future">
              {t("list.opens")} {fmtOpeningDate(g?.openingDate) || t("list.soon")}
            </Badge>
          )}
          {place.notFoundInScanId !== null && <Badge variant="warning">{t("list.notFound")}</Badge>}
          {place.goneAt != null && (
            <Badge variant="warning" title={t("detail.gone.hint")}>
              {t("detail.gone")}
            </Badge>
          )}
        </div>
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {[g?.formattedAddress, lead.city, countryLabel(lead.countryCode)]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild variant="outline" size="sm">
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> {t("detail.openMaps")}
            </a>
          </Button>
          {g ? (
            <GoogleLoadButton
              target={{ leadIds: [lead.id] }}
              mode="enrich"
              label={g.enrichedAt ? t("detail.enrich.again") : t("detail.enrich")}
            />
          ) : (
            <GoogleLoadButton
              target={{ leadIds: [lead.id] }}
              mode="refresh"
              label={t("detail.refresh")}
              variant="default"
            />
          )}
        </div>
        {!g && (
          <p className="flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t("detail.noGoogle")}
          </p>
        )}
      </div>

      <Section title={t("detail.why")} hint={<HelpTip>{t("detail.why.help")}</HelpTip>}>
        {lead.noveltySignals.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("detail.why.none")}</p>
        ) : (
          <ul className="space-y-2">
            {lead.noveltySignals.map((s) => (
              <li key={s.id} className="flex gap-2 text-[13px]">
                <span className="tabular mt-0.5 inline-flex h-5 min-w-8 items-center justify-center rounded bg-secondary px-1 text-[11px] font-semibold">
                  +{s.points}
                </span>
                <span>{signalText(s)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-muted-foreground">{t("detail.why.disclaimer")}</p>
      </Section>

      <Section title={t("detail.info")}>
        <dl>
          <Fact label={t("detail.businessStatus")}>{t(`businessStatus.${status}` as never)}</Fact>
          <Fact label={t("detail.website")}>
            {website ? (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Globe className="size-3.5" /> {new URL(website).hostname}
              </a>
            ) : (
              <span className="text-muted-foreground">
                {!g
                  ? t("detail.notLoaded")
                  : g.enrichedAt
                    ? t("detail.none")
                    : t("detail.notFetched")}
              </span>
            )}
          </Fact>
          <Fact label={t("detail.phone")}>
            {g?.phone || g?.intlPhone ? (
              <span className="inline-flex items-center gap-1">
                <Phone className="size-3.5" /> {g.intlPhone ?? g.phone}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {!g
                  ? t("detail.notLoaded")
                  : g.enrichedAt
                    ? t("detail.none")
                    : t("detail.notFetched")}
              </span>
            )}
          </Fact>
          <Fact label={t("detail.ratings")}>
            {g?.userRatingCount != null ? (
              fmtNumber(g.userRatingCount)
            ) : (
              <span className="text-muted-foreground">
                {g ? t("detail.notFetched") : t("detail.notLoaded")}
              </span>
            )}
          </Fact>
          {data.domainAge && (
            <Fact label={t("detail.domainAge")}>
              <span title={data.domainAge.domain}>{domainAgeText(data.domainAge)}</span>
            </Fact>
          )}
        </dl>
        {place.lat === null && (
          <p className="flex items-start gap-1.5 rounded-md bg-nov-likely/15 px-2.5 py-2 text-[12px] text-caution-text">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t("detail.coordsExpired")}
          </p>
        )}
      </Section>

      <LeadEmails data={data} />

      <LeadCampaigns leadId={lead.id} />

      <Section
        title={t("detail.manage")}
        hint={
          <span
            className="ml-auto flex items-center gap-1 text-[12px] font-medium text-success"
            aria-live="polite"
          >
            {saved && (
              <span className="um-enter inline-flex items-center gap-1">
                <Check className="size-3.5" aria-hidden /> {t("common.saved")}
              </span>
            )}
          </span>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lead-display-name" className="flex items-center gap-1">
              {t("detail.displayName")}
              <HelpTip>{t("detail.displayName.help")}</HelpTip>
            </Label>
            <Input
              id="lead-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={commitDisplayName}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              maxLength={200}
              placeholder={t("detail.displayName.placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="lead-status">{t("detail.status")}</Label>
              <HelpTip>{t("help.leadStatus")}</HelpTip>
            </div>
            <Select
              id="lead-status"
              value={lead.status}
              onChange={(e) =>
                lead.status === "do_not_contact" && e.target.value !== "do_not_contact"
                  ? setUnblockTo(e.target.value)
                  : save({ status: e.target.value })
              }
            >
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`leadStatus.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <ConfirmDialog
            open={unblockTo !== null}
            onOpenChange={(v) => !v && setUnblockTo(null)}
            tone="warning"
            title={t("detail.unblock.title")}
            description={t("detail.unblock.body")}
            confirmLabel={t("detail.unblock.confirm")}
            onConfirm={() => {
              if (unblockTo) save({ status: unblockTo, confirmUnblock: true });
            }}
          />
          <div className="space-y-1.5">
            <Label htmlFor="lead-tag">{t("detail.tags")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {lead.tags.map((x) => (
                <Badge key={x} variant="default" className="gap-1 pr-1">
                  {x}
                  <button
                    type="button"
                    aria-label={t("detail.removeTag", { tag: x })}
                    onClick={() => save({ tags: lead.tags.filter((y) => y !== x) })}
                    className="rounded-full p-0.5 transition-colors hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <Input
              id="lead-tag"
              value={tag}
              placeholder={t("detail.tagPlaceholder")}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              maxLength={40}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-notes">{t("detail.notes")}</Label>
            <Textarea
              id="lead-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={commitNotes}
              maxLength={5000}
              placeholder={t("detail.notesPlaceholder")}
            />
          </div>
        </div>
      </Section>

      <Section title={t("detail.timeline")}>
        <ol className="space-y-2 border-l pl-4">
          {[
            { at: place.firstSeenAt, label: t("detail.tl.detected") },
            { at: place.newDetectedAt, label: t("detail.tl.new") },
            { at: place.openedDetectedAt, label: t("detail.tl.opened") },
            { at: g?.enrichedAt ?? null, label: t("detail.tl.enriched") },
            {
              at: data.emails.length > 0 ? Math.min(...data.emails.map((e) => e.foundAt)) : null,
              label: t("detail.tl.emailFound"),
            },
          ]
            .filter((e) => e.at)
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
            .map((e) => (
              <li key={e.label} className="relative text-[13px]">
                <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary ring-2 ring-card" />
                <span className="font-medium">{e.label}</span>
                <span className="ml-2 text-muted-foreground">
                  {fmtDate(e.at)} · {fmtRelativeDays(e.at!)}
                </span>
              </li>
            ))}
        </ol>
      </Section>
    </>
  );
}
