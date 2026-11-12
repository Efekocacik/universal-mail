"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Globe, Keyboard, Loader2, Mail, SearchX, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { NOVELTY_DOT } from "@/components/novelty-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { countryLabel, fmtNumber, fmtOpeningDate, typeLabel } from "@/lib/client/format";
import { useEnrichmentStatus, useFacets, useLeadsInfinite } from "@/lib/client/queries";
import type { LeadRow } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { toSearchParams } from "@/lib/client/api";
import { shortcutHint } from "@/lib/client/shortcuts";
import { BulkBar } from "./bulk-bar";
import { ExportLeadsButton } from "./export-leads-button";
import { GoogleLoadButton } from "./google-load-button";
import { headerCheckState, isEmpty, isSelected, MAX_SELECTION } from "./selection";
import { useExplore, type LeadSort } from "./state";

const ROW_HEIGHT = 84;

/** Satırdaki e-posta durumu rozeti: bulunduysa yeşil, sürüyorsa dönen simge, engelliyse uyarı; aksi halde görünmez. */
function EmailBadge({ row }: { row: LeadRow }) {
  const st = row.emailState;
  if (st === "found_verified" || st === "generic" || st === "found_unverified")
    return (
      <Badge
        variant={st === "found_unverified" ? "outline" : "success"}
        title={row.primaryEmail ?? undefined}
      >
        <Mail className="size-3" /> {t(`list.email.${st}`)}
      </Badge>
    );
  if (st === "running" || st === "queued")
    return (
      <Badge variant="outline">
        <Loader2 className="size-3 animate-spin" /> {t(`list.email.${st}`)}
      </Badge>
    );
  if (st === "blocked") return <Badge variant="warning">{t("list.email.blocked")}</Badge>;
  return null;
}

function Row({
  row,
  selected,
  checked,
  onClick,
  onCheck,
}: {
  row: LeadRow;
  selected: boolean;
  checked: boolean;
  onClick: () => void;
  onCheck: (shift: boolean) => void;
}) {
  const contacted = row.leadStatus !== "new" && row.leadStatus !== "enriched";
  return (
    <div
      className={cn(
        "flex h-full w-full border-b border-l-2 border-l-transparent transition-colors duration-150",
        selected && "border-l-primary bg-accent",
        checked && !selected && "bg-accent/40",
      )}
    >
      <div className="flex shrink-0 items-start pl-3 pt-[18px]">
        <Checkbox
          checked={checked}
          aria-label={t("list.row.select", { name: row.name ?? t("list.unnamed") })}
          data-lead-check
          onClick={(e) => {
            // Durum seçim modelinde tutulur; Shift+tıklama aralık seçer.
            e.preventDefault();
            onCheck(e.shiftKey);
          }}
        />
      </div>
      <button
        type="button"
        onClick={onClick}
        data-lead-row
        aria-current={selected ? "true" : undefined}
        className="flex h-full min-w-0 flex-1 flex-col justify-center gap-1 pl-3 pr-4 text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full ring-2 ring-card",
              NOVELTY_DOT[row.noveltyLabel],
              contacted && "ring-contacted",
            )}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[15px] font-semibold",
              !row.name && "font-normal italic text-muted-foreground",
            )}
          >
            {row.name ?? t("list.unnamed")}
          </span>
          <span
            className="tabular shrink-0 text-[12px] text-muted-foreground"
            title={t("list.score")}
          >
            <span className="sr-only">{t("list.score")}: </span>
            {row.noveltyScore}
          </span>
        </div>
        <div className="truncate pl-[18px] text-[13px] text-muted-foreground">
          {[typeLabel(row.primaryType), row.city, countryLabel(row.countryCode)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="flex items-center gap-1.5 overflow-hidden pl-[18px]">
          {row.businessStatus === "FUTURE_OPENING" ? (
            <Badge variant="future">
              {t("list.opens")} {fmtOpeningDate(row.openingDate) || t("list.soon")}
            </Badge>
          ) : row.openedDetectedAt ? (
            <Badge variant="high">
              <Sparkles className="size-3" /> {t("list.justOpened")}
            </Badge>
          ) : row.newDetectedAt ? (
            <Badge variant="high">
              <Sparkles className="size-3" /> {t("list.newDetected")}
            </Badge>
          ) : null}
          {row.notFound && <Badge variant="warning">{t("list.notFound")}</Badge>}
          {row.website && (
            <Badge variant="outline" title={t("list.website")} aria-label={t("list.website")}>
              <Globe className="size-3" />
            </Badge>
          )}
          <EmailBadge row={row} />
          {row.source === "demo" && <Badge variant="outline">DEMO</Badge>}
          {contacted && <Badge variant="info">{t(`leadStatus.${row.leadStatus}`)}</Badge>}
        </div>
      </button>
    </div>
  );
}

export function LeadList() {
  const ex = useExplore();
  const q = useLeadsInfinite(ex.apiFilters, ex.sort);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const loadedIds = useMemo(() => rows.map((r) => r.leadId), [rows]);
  const visibleIds = useMemo(() => new Set(loadedIds), [loadedIds]);
  const total = q.data?.pages[0]?.total ?? 0;
  const parentRef = useRef<HTMLDivElement>(null);
  const hasMore = q.hasNextPage;
  const hasSelection = !isEmpty(ex.selection);

  const virt = useVirtualizer({
    count: rows.length + (hasMore ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const items = virt.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !q.isFetchingNextPage && lastIndex >= rows.length - 1) void q.fetchNextPage();
  }, [hasMore, q, lastIndex, rows.length]);

  // Haritada seçilen işletme listede görünür alana kaydırılır.
  useEffect(() => {
    if (ex.selectedId === null) return;
    const i = rows.findIndex((r) => r.leadId === ex.selectedId);
    if (i >= 0) virt.scrollToIndex(i, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex.selectedId, rows.length]);

  // Tümünü seç: hepsi yüklüyse ve sınırın altındaysa kimliklerle (süzgeç değişse de korunur); değilse "süzgece uyan
  // tümü" sorgusuyla (süzgeç değişince temizlenir). Seçim varken kutu seçimi temizler.
  const headerState = headerCheckState(ex.selection, loadedIds, ex.filterQuery);
  const toggleAll = () => {
    if (hasSelection) return ex.clearSelection();
    if (total === 0) return;
    if (!hasMore && rows.length <= MAX_SELECTION) ex.selectIds(loadedIds);
    else ex.selectQuery(ex.filterQuery, total, "all");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ex.filters.archived && (
        <p
          className="border-b bg-warning/10 px-4 py-2 text-[12px] text-foreground"
          data-testid="archived-banner"
        >
          {t("list.archived.banner")}
        </p>
      )}
      {hasSelection ? (
        <div className="flex items-stretch">
          <div className="flex items-start border-b bg-accent/60 pl-4 pt-[17px]">
            <Checkbox
              checked={headerState}
              aria-label={t("selection.clear")}
              onClick={(e) => {
                e.preventDefault();
                toggleAll();
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <BulkBar visibleIds={visibleIds} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div className="flex items-center gap-3">
            {total > 0 && (
              <Checkbox
                checked={false}
                aria-label={t("selection.selectAll", { n: fmtNumber(total) })}
                title={t("selection.selectAll", { n: fmtNumber(total) })}
                data-testid="select-all"
                onClick={(e) => {
                  e.preventDefault();
                  toggleAll();
                }}
              />
            )}
            <p className="tabular text-[13px] font-medium text-foreground" aria-live="polite">
              {q.isLoading ? t("common.loading") : t("list.count", { n: fmtNumber(total) })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {total > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => ex.openDialog("findEmails")}
                title={`${t("findEmails.button")} (${shortcutHint("findEmails")})`}
              >
                <Mail /> {t("findEmails.button")}
              </Button>
            )}
            {total > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => ex.openDialog("campaign")}
                title={`${t("addToCampaign.button")} (${shortcutHint("addToCampaign")})`}
              >
                <Send /> {t("addToCampaign.button")}
              </Button>
            )}
            {total > 0 && <ExportLeadsButton filterQuery={ex.filterQuery} />}
            <Select
              aria-label={t("list.sort")}
              value={ex.sort}
              onChange={(e) => ex.setSort(e.target.value as LeadSort)}
              className="h-8 w-auto py-0 pr-7 text-[13px] transition-colors hover:bg-accent"
            >
              <option value="novelty">{t("list.sort.novelty")}</option>
              <option value="recent">{t("list.sort.recent")}</option>
              <option value="name">{t("list.sort.name")}</option>
            </Select>
          </div>
        </div>
      )}

      <EmailProgress />
      <UncachedBanner />

      <div
        ref={parentRef}
        className="um-scroll min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        aria-label={t("list.count", { n: fmtNumber(total) })}
      >
        {q.isLoading ? (
          <div className="space-y-2 px-4 py-2" aria-busy="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px]" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyList />
        ) : (
          <div role="list" style={{ height: virt.getTotalSize(), position: "relative" }}>
            {items.map((v) => {
              const row = rows[v.index];
              return (
                <div
                  key={v.key}
                  role="listitem"
                  aria-posinset={v.index + 1}
                  aria-setsize={Math.max(total, rows.length)}
                  data-index={v.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_HEIGHT,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {row ? (
                    <Row
                      row={row}
                      selected={row.leadId === ex.selectedId}
                      checked={isSelected(ex.selection, row.leadId)}
                      onCheck={(shift) =>
                        shift ? ex.selectRange(row.leadId, loadedIds) : ex.toggleSelect(row.leadId)
                      }
                      onClick={() =>
                        ex.select(row.leadId, {
                          focus: true,
                          lat: row.lat ?? undefined,
                          lng: row.lng ?? undefined,
                        })
                      }
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                      {t("list.loadMore")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex shrink-0 justify-end border-t px-4 py-1">
        <button
          type="button"
          onClick={() => ex.setShortcutsOpen(true)}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Keyboard className="size-3.5" aria-hidden /> {t("shortcuts.open")}
          <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">?</kbd>
        </button>
      </div>
    </div>
  );
}

/** E-posta araması sürerken ilerleme çubuğu (iş sayıları işçiden gelir). */
function EmailProgress() {
  const { data, active } = useEnrichmentStatus();
  if (!active || !data) return null;
  return (
    <p
      className="flex items-center gap-2 border-b bg-accent/50 px-4 py-1.5 text-[12px] text-muted-foreground"
      aria-live="polite"
    >
      <Loader2 className="size-3.5 animate-spin" />
      {t("findEmails.progress", {
        running: data.states.running ?? 0,
        queued: data.states.queued ?? 0,
      })}
    </p>
  );
}

/** Google verisi (ad, adres) önbellekte olmayan kayıtlar varsa, tek tıkla yükleme önerir. */
function UncachedBanner() {
  const ex = useExplore();
  const { data } = useFacets(ex.apiFilters);
  if (!data || data.uncached === 0) return null;
  return (
    <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2 text-[12px]">
      <p className="min-w-0 flex-1 text-muted-foreground">
        {t("list.uncached", { n: fmtNumber(data.uncached) })}
      </p>
      <GoogleLoadButton
        target={{ filtersQuery: toSearchParams(ex.apiFilters).toString() }}
        mode="refresh"
        label={t("list.uncached.load")}
        variant="default"
      />
    </div>
  );
}

function EmptyList() {
  const ex = useExplore();
  const filtered = ex.activeFilterCount > 0 || ex.onlyInView;
  if (!filtered)
    return (
      <div className="um-enter flex h-full flex-col items-center justify-center gap-5 p-6 text-center">
        <div>
          <p className="text-base font-semibold">{t("list.empty.title")}</p>
          <p className="mx-auto mt-1 max-w-72 text-[13px] text-muted-foreground">
            {t("list.empty.body")}
          </p>
        </div>
        <section
          aria-label={t("list.guide.title")}
          className="w-full max-w-sm rounded-xl border bg-card p-4 text-left shadow-xs"
        >
          <h3 className="mb-3 text-[13px] font-semibold">{t("list.guide.title")}</h3>
          <ol className="space-y-3">
            {([1, 2, 3, 4] as const).map((n) => (
              <li key={n} className="flex items-start gap-3">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
                    n === 2
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent text-accent-foreground",
                  )}
                  aria-hidden
                >
                  {n}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {n === 1 ? (
                      <Link
                        href="/settings"
                        className="underline-offset-4 hover:underline focus-visible:underline"
                      >
                        {t("list.guide.1")}
                      </Link>
                    ) : (
                      t(`list.guide.${n}`)
                    )}
                  </p>
                  <p className="text-[12px] text-muted-foreground">{t(`list.guide.${n}.hint`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <Button size="lg" onClick={() => ex.setTab("scan")}>
          {t("list.empty.cta")}
        </Button>
      </div>
    );
  return (
    <div className="um-enter flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <SearchX className="size-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-semibold">{t("list.empty.filtered.title")}</p>
        <p className="mt-1 max-w-64 text-[13px] text-muted-foreground">
          {t("list.empty.filtered.body")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          ex.resetFilters();
          ex.setOnlyInView(false);
        }}
      >
        {t("filters.clear")}
      </Button>
    </div>
  );
}
