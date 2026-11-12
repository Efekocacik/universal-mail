"use client";

import { List, Map as MapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { AddToCampaignButton } from "@/features/campaigns/add-to-campaign-button";
import { cn } from "@/lib/cn";
import { useLeadsInfinite } from "@/lib/client/queries";
import { useShortcuts } from "@/lib/client/shortcuts";
import { t } from "@/lib/i18n";
import { FindEmailsButton } from "./find-emails-button";
import { LeadDetail } from "./lead-detail";
import { LeadFilters } from "./lead-filters";
import { LeadList } from "./lead-list";
import { MapPanel } from "./map-panel";
import { ScanBuilder } from "./scan-builder";
import { ScanStrip } from "./scan-strip";
import { findEmailsTarget, isEmpty, selectionCount } from "./selection";
import { ExploreProvider, SEARCH_INPUT_ID, useExplore, type InitialExploreState } from "./state";

const MIN_W = 340;
const MAX_W = 760;
const TABS = ["list", "scan"] as const;
const STORAGE_KEY = "um.explore.panelWidth";

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

function usePanelWidth(): [number, (w: number) => void] {
  const [width, setWidth] = useState(440);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (saved >= MIN_W && saved <= MAX_W) setWidth(saved);
    } catch {
      /* depolama kapalı olabilir */
    }
  }, []);
  const set = useCallback((w: number) => {
    const v = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
    setWidth(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* yoksay */
    }
  }, []);
  return [width, set];
}

/**
 * Sayfa düzeyinde klavye kısayolları (kayıt: `lib/client/shortcuts.ts`; `?` hepsini listeler). Liste ekrandan kalksa
 * (ayrıntı açıkken) bile çalışır: J/K satırları listeyle AYNI önbellekli sorgudan okur. Eskiden J/K listenin içindeydi
 * ve bir işletme açılınca liste kalktığı için ikinci basışta çalışmıyordu.
 * Esc sırası: çizim modu → toplu seçim → açık ayrıntı. Metin alanları ve diyaloglar etkilenmez.
 */
function GlobalKeys() {
  const ex = useExplore();
  const onList = ex.tab === "list";
  const q = useLeadsInfinite(ex.apiFilters, ex.sort, onList);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);

  const move = (delta: number) => {
    if (!onList || rows.length === 0) return;
    const cur = rows.findIndex((r) => r.leadId === ex.selectedId);
    const next = Math.min(rows.length - 1, Math.max(0, cur < 0 ? 0 : cur + delta));
    // Yüklü satırların sonuna gelindiyse sonraki sayfa istenir; bir sonraki basış oraya geçer.
    if (next >= rows.length - 2 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    const r = rows[next]!;
    ex.select(r.leadId, { focus: true, lat: r.lat ?? undefined, lng: r.lng ?? undefined });
  };

  const openDialog = (d: "campaign" | "findEmails") => {
    if (!onList) return;
    const hasTarget =
      !isEmpty(ex.selection) || ex.selectedId !== null || (q.data?.pages[0]?.total ?? 0) > 0;
    if (hasTarget) ex.openDialog(d);
  };

  useShortcuts({
    help: () => ex.setShortcutsOpen(true),
    next: () => move(1),
    prev: () => move(-1),
    search: () => {
      ex.setTab("list");
      ex.select(null);
      // Liste ve süzgeçler bir sonraki çizimde yerleşir; odak ondan sonra verilir.
      requestAnimationFrame(() => document.getElementById(SEARCH_INPUT_ID)?.focus());
    },
    select: () => {
      if (onList && ex.selectedId !== null) ex.toggleSelect(ex.selectedId);
    },
    findEmails: () => openDialog("findEmails"),
    addToCampaign: () => openDialog("campaign"),
    fit: () => ex.requestFit(),
    onlyInView: () => ex.setOnlyInView(!ex.onlyInView),
    escape: () => {
      if (ex.drawMode) ex.setDrawMode(null);
      else if (!isEmpty(ex.selection)) ex.clearSelection();
      else if (ex.selectedId !== null) ex.select(null);
    },
  });
  return null;
}

/**
 * Kısayolla ve seçim çubuğuyla açılan pencereler. Sayfa düzeyindedir; liste ile ayrıntı arasında geçilse de kapanmaz.
 * Hedef: toplu seçim varsa o; yoksa açık ayrıntıdaki işletme; o da yoksa listedeki süzgece uyanların tümü.
 */
function ExploreDialogs() {
  const ex = useExplore();
  const q = useLeadsInfinite(ex.apiFilters, ex.sort, ex.dialog !== null);
  const total = q.data?.pages[0]?.total ?? 0;
  if (!ex.dialog) return null;
  const sel = ex.selection;
  const onClose = (v: boolean) => {
    if (!v) ex.openDialog(null);
  };
  const single = isEmpty(sel) && ex.selectedId !== null ? [ex.selectedId] : null;

  if (ex.dialog === "findEmails") {
    const target =
      findEmailsTarget(sel) ?? (single ? { leadIds: single } : { filtersQuery: ex.filterQuery });
    return <FindEmailsButton hideTrigger open onOpenChange={onClose} target={target} />;
  }
  const leadIds = sel.mode === "ids" && !isEmpty(sel) ? [...sel.ids] : (single ?? undefined);
  return (
    <AddToCampaignButton
      hideTrigger
      open
      onOpenChange={onClose}
      filterQuery={sel.mode === "query" ? sel.filterQuery : ex.filterQuery}
      total={isEmpty(sel) ? (single ? 1 : total) : selectionCount(sel)}
      leadIds={leadIds}
    />
  );
}

function ShortcutsHelp() {
  const ex = useExplore();
  return <ShortcutsDialog open={ex.shortcutsOpen} onOpenChange={ex.setShortcutsOpen} />;
}

function LeftPanel() {
  const ex = useExplore();
  const showDetail = ex.tab === "list" && ex.selectedId !== null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div
        className="flex shrink-0 gap-1 border-b px-3 pt-2"
        role="tablist"
        aria-label={t("explore.panel")}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            id={`explore-tab-${tab}`}
            role="tab"
            type="button"
            aria-selected={ex.tab === tab}
            aria-controls="explore-tabpanel"
            tabIndex={ex.tab === tab ? 0 : -1}
            onKeyDown={(e) => {
              const i = TABS.indexOf(tab);
              let next = -1;
              if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
              else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = TABS.length - 1;
              if (next < 0) return;
              e.preventDefault();
              ex.setTab(TABS[next]!);
              document.getElementById(`explore-tab-${TABS[next]}`)?.focus();
            }}
            onClick={() => ex.setTab(tab)}
            className={cn(
              "relative -mb-px min-h-10 rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors duration-150",
              ex.tab === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {t(`explore.tab.${tab}`)}
          </button>
        ))}
      </div>
      <ScanStrip />
      <div
        id="explore-tabpanel"
        role="tabpanel"
        aria-labelledby={`explore-tab-${ex.tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {ex.tab === "scan" ? (
          <ScanBuilder />
        ) : showDetail ? (
          <LeadDetail id={ex.selectedId!} />
        ) : (
          <>
            <LeadFilters />
            <LeadList />
          </>
        )}
      </div>
    </div>
  );
}

function Layout() {
  const [width, setWidth] = usePanelWidth();
  const narrow = useMediaQuery("(max-width: 900px)");
  const [pane, setPane] = useState<"list" | "map">("list");
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  if (narrow) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-2 gap-1 border-b bg-card p-1.5">
          {(["list", "map"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={pane === p}
              onClick={() => setPane(p)}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors duration-150",
                pane === p
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {p === "list" ? <List className="size-4" /> : <MapIcon className="size-4" />}
              {t(`explore.pane.${p}`)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">{pane === "list" ? <LeftPanel /> : <MapPanel />}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside style={{ width }} className="relative min-h-0 shrink-0 border-r">
        <LeftPanel />
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("explore.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        className="group relative z-10 -ml-1 w-3 shrink-0 cursor-col-resize touch-none"
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startW: width };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(drag.current.startW + (e.clientX - drag.current.startX));
        }}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          const step =
            e.key === "ArrowLeft"
              ? width - 24
              : e.key === "ArrowRight"
                ? width + 24
                : e.key === "Home"
                  ? MIN_W
                  : e.key === "End"
                    ? MAX_W
                    : null;
          if (step === null) return;
          e.preventDefault();
          setWidth(step);
        }}
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
      </div>
      <section className="min-h-0 min-w-0 flex-1" aria-label={t("explore.map")}>
        <MapPanel />
      </section>
    </div>
  );
}

export function ExplorePage({ initial }: { initial?: InitialExploreState }) {
  return (
    <ExploreProvider initial={initial}>
      <GlobalKeys />
      <Layout />
      <ExploreDialogs />
      <ShortcutsHelp />
    </ExploreProvider>
  );
}
