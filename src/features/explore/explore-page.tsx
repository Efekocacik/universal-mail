"use client";

import { List, Map as MapIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { LeadDetail } from "./lead-detail";
import { LeadFilters } from "./lead-filters";
import { LeadList } from "./lead-list";
import { MapPanel } from "./map-panel";
import { ScanBuilder } from "./scan-builder";
import { ScanStrip } from "./scan-strip";
import { ExploreProvider, useExplore } from "./state";

const MIN_W = 340;
const MAX_W = 760;
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
 * Sayfa düzeyinde klavye kısayolları. Liste ekrandan kalksa (ayrıntı açıkken) bile çalışır.
 * Esc: önce çizim modunu kapatır, sonra seçili işletmeyi bırakır. Metin alanları ve diyaloglar etkilenmez.
 */
function GlobalKeys() {
  const ex = useExplore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (
        (e.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=listbox]",
        )
      )
        return;
      if (ex.drawMode) ex.setDrawMode(null);
      else if (ex.selectedId !== null) ex.select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ex]);
  return null;
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
        {(["list", "scan"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            type="button"
            aria-selected={ex.tab === tab}
            onClick={() => ex.setTab(tab)}
            className={cn(
              "relative -mb-px rounded-t-md px-3 py-2 text-[13px] font-medium transition-colors",
              ex.tab === tab
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`explore.tab.${tab}`)}
          </button>
        ))}
      </div>
      <ScanStrip />
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
              onClick={() => setPane(p)}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium",
                pane === p ? "bg-accent text-accent-foreground" : "text-muted-foreground",
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
        tabIndex={0}
        className="group relative z-10 -ml-1 w-2 shrink-0 cursor-col-resize touch-none"
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startW: width };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(drag.current.startW + (e.clientX - drag.current.startX));
        }}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth(width - 24);
          if (e.key === "ArrowRight") setWidth(width + 24);
        }}
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
      </div>
      <main className="min-h-0 min-w-0 flex-1" aria-label={t("explore.map")}>
        <MapPanel />
      </main>
    </div>
  );
}

export function ExplorePage({ initialScanId }: { initialScanId?: number }) {
  return (
    <ExploreProvider initialScanId={initialScanId}>
      <GlobalKeys />
      <Layout />
    </ExploreProvider>
  );
}
