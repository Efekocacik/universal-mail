"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Globe, Loader2, Mail, Search, SearchX, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NOVELTY_DOT } from "@/components/novelty-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { countryLabel, fmtNumber, fmtOpeningDate, typeLabel } from "@/lib/client/format";
import { useEnrichmentStatus, useFacets, useLeadsInfinite } from "@/lib/client/queries";
import type { LeadRow } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { toSearchParams } from "@/lib/client/api";
import { FindEmailsButton } from "./find-emails-button";
import { GoogleLoadButton } from "./google-load-button";
import { useExplore } from "./state";

const ROW_HEIGHT = 78;

/** Satırdaki e-posta durumu rozeti: bulunduysa yeşil, sürüyorsa dönen simge, engelliyse uyarı; aksi halde görünmez. */
function EmailBadge({ row }: { row: LeadRow }) {
  const st = row.emailState;
  if (st === "found_verified" || st === "generic" || st === "found_unverified")
    return (
      <Badge
        variant={st === "found_unverified" ? "outline" : "high"}
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

function Row({ row, selected, onClick }: { row: LeadRow; selected: boolean; onClick: () => void }) {
  const contacted = row.leadStatus !== "new" && row.leadStatus !== "enriched";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected}
      className={cn(
        "flex h-full w-full flex-col justify-center gap-1 border-b px-4 text-left transition-colors hover:bg-accent/60",
        selected && "bg-accent",
        row.notFound && "opacity-70",
      )}
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
            "min-w-0 flex-1 truncate text-sm font-semibold",
            !row.name && "font-normal italic text-muted-foreground",
          )}
        >
          {row.name ?? t("list.unnamed")}
        </span>
        <span
          className="tabular shrink-0 text-[12px] text-muted-foreground"
          title={t("list.score")}
        >
          {row.noveltyScore}
        </span>
      </div>
      <div className="truncate pl-[18px] text-[12px] text-muted-foreground">
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
          <Badge variant="outline">
            <Globe className="size-3" /> {t("list.website")}
          </Badge>
        )}
        <EmailBadge row={row} />
        {row.source === "demo" && <Badge variant="outline">DEMO</Badge>}
        {contacted && <Badge variant="contacted">{t(`leadStatus.${row.leadStatus}`)}</Badge>}
      </div>
    </button>
  );
}

export function LeadList() {
  const ex = useExplore();
  const [sort, setSort] = useState<"novelty" | "name" | "recent">("novelty");
  const q = useLeadsInfinite(ex.apiFilters, sort);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const parentRef = useRef<HTMLDivElement>(null);
  const hasMore = q.hasNextPage;

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

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const cur = rows.findIndex((r) => r.leadId === ex.selectedId);
      const next = Math.min(rows.length - 1, Math.max(0, cur < 0 ? 0 : cur + delta));
      const r = rows[next]!;
      ex.select(r.leadId, { focus: true, lat: r.lat ?? undefined, lng: r.lng ?? undefined });
    },
    [rows, ex],
  );

  // Klavye: J/K ile liste gezinme (FR-UI-05). Metin alanlarında devre dışı. Esc, ExplorePage'deki GlobalKeys'te işlenir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        move(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, ex]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <p className="tabular text-[13px] text-muted-foreground" aria-live="polite">
          {q.isLoading ? t("common.loading") : t("list.count", { n: fmtNumber(total) })}
        </p>
        <div className="flex items-center gap-2">
          {total > 0 && (
            <FindEmailsButton target={{ filtersQuery: toSearchParams(ex.apiFilters).toString() }} />
          )}
          <Select
            aria-label={t("list.sort")}
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="h-8 w-auto py-0 pr-7 text-[13px]"
          >
            <option value="novelty">{t("list.sort.novelty")}</option>
            <option value="recent">{t("list.sort.recent")}</option>
            <option value="name">{t("list.sort.name")}</option>
          </Select>
        </div>
      </div>

      <EmailProgress />
      <UncachedBanner />

      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        {q.isLoading ? (
          <div className="space-y-px p-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyList />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {items.map((v) => {
              const row = rows[v.index];
              return (
                <div
                  key={v.key}
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
                      {t("common.loading")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        {filtered ? (
          <SearchX className="size-5 text-muted-foreground" />
        ) : (
          <Search className="size-5 text-muted-foreground" />
        )}
      </div>
      <div>
        <p className="text-sm font-semibold">
          {filtered ? t("list.empty.filtered.title") : t("list.empty.title")}
        </p>
        <p className="mt-1 max-w-64 text-[13px] text-muted-foreground">
          {filtered ? t("list.empty.filtered.body") : t("list.empty.body")}
        </p>
      </div>
      {filtered ? (
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
      ) : (
        <Button size="sm" onClick={() => ex.setTab("scan")}>
          {t("list.empty.cta")}
        </Button>
      )}
    </div>
  );
}
