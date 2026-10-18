"use client";

import { ArrowLeft, CircleAlert, ExternalLink, Globe, MapPin, Phone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NoveltyBadge } from "@/components/novelty-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
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
import { t } from "@/lib/i18n";
import { GoogleLoadButton } from "./google-load-button";
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
    <section className="space-y-2 border-b px-4 py-4">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
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

export function LeadDetail({ id }: { id: number }) {
  const ex = useExplore();
  const { data, isLoading, error } = useLead(id);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => ex.select(null)}>
          <ArrowLeft /> {t("detail.back")}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Esc</span>
      </div>
      {isLoading && (
        <div className="space-y-3 p-4">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      )}
      {error && <p className="p-4 text-sm text-destructive">{(error as Error).message}</p>}
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

  useEffect(() => {
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.notes]);
  useEffect(() => {
    setDisplayName(lead.displayName ?? "");
  }, [lead.id, lead.displayName]);

  const commitDisplayName = () => {
    const v = displayName.trim();
    if ((lead.displayName ?? "") === v) return;
    patch.mutate({ displayName: v === "" ? null : v });
  };

  const commitNotes = () => {
    if ((lead.notes ?? "") === notes) return;
    patch.mutate(
      { notes: notes.trim() === "" ? null : notes },
      { onSuccess: () => setSaved(true) },
    );
  };
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(id);
  }, [saved]);

  const addTag = () => {
    const v = tag.trim();
    if (!v || lead.tags.includes(v)) return setTag("");
    patch.mutate({ tags: [...lead.tags, v] });
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
      <div className="space-y-2 border-b px-4 py-4">
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
                <span>{s.reason}</span>
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
        </dl>
        {place.lat === null && (
          <p className="flex items-start gap-1.5 rounded-md bg-nov-likely/15 px-2.5 py-2 text-[12px] text-[#6b5200]">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t("detail.coordsExpired")}
          </p>
        )}
      </Section>

      <Section title={t("detail.manage")}>
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
            <Label htmlFor="lead-status">{t("detail.status")}</Label>
            <Select
              id="lead-status"
              value={lead.status}
              onChange={(e) => patch.mutate({ status: e.target.value })}
            >
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`leadStatus.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-tag">{t("detail.tags")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {lead.tags.map((x) => (
                <Badge key={x} variant="default" className="gap-1 pr-1">
                  {x}
                  <button
                    type="button"
                    aria-label={t("detail.removeTag", { tag: x })}
                    onClick={() => patch.mutate({ tags: lead.tags.filter((y) => y !== x) })}
                    className="rounded-full p-0.5 hover:bg-black/10"
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
            <div className="flex items-center justify-between">
              <Label htmlFor="lead-notes">{t("detail.notes")}</Label>
              <span className="text-[12px] text-primary" aria-live="polite">
                {saved ? t("common.saved") : ""}
              </span>
            </div>
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
