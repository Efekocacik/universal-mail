"use client";

import { CheckSquare, ChevronDown, Crosshair, Info, KeyRound, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { api, toSearchParams } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { useConfig, usePoints } from "@/lib/client/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { boundsOfPoints, pointsInBounds } from "./map-math";
import { LABEL_COLORS } from "./map-types";
import { MAX_SELECTION } from "./selection";
import { useExplore, type DraftRegion } from "./state";

const GoogleMapView = dynamic(() => import("./google-map").then((m) => m.GoogleMapView), {
  ssr: false,
  loading: () => <MapLoading />,
});
const SchematicMapView = dynamic(() => import("./schematic-map").then((m) => m.SchematicMapView), {
  ssr: false,
  loading: () => <MapLoading />,
});

const LEGEND_KEY = "um.explore.legendOpen";

function MapLoading() {
  return (
    <div
      className="flex size-full items-center justify-center gap-2 bg-muted text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t("map.loading")}
    </div>
  );
}

function useLegendOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(LEGEND_KEY) === "0") setOpen(false);
    } catch {
      /* depolama kapalı olabilir */
    }
  }, []);
  const set = useCallback((v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(LEGEND_KEY, v ? "1" : "0");
    } catch {
      /* yoksay */
    }
  }, []);
  return [open, set];
}

/**
 * Harita göstergesi. Google haritasında sol alt köşe Google logosu ve atıf içindir (Maps şartları: görünür kalmalı),
 * bu yüzden gösterge logonun ÜSTÜNE yerleşir. Katlanabilir; tercih tarayıcıda hatırlanır.
 */
function Legend({ google }: { google: boolean }) {
  const [open, setOpen] = useLegendOpen();
  const novelty = [
    { color: LABEL_COLORS[0], label: t("novelty.future_opening") },
    { color: LABEL_COLORS[1], label: t("novelty.high") },
    { color: LABEL_COLORS[2], label: t("novelty.likely") },
    { color: LABEL_COLORS[3], label: t("novelty.low") },
  ];
  const contact = [
    { cls: "um-legend-ring um-legend-ring--contacted", label: t("map.legend.sent") },
    { cls: "um-legend-ring um-legend-ring--replied", label: t("map.legend.replied") },
    { cls: "um-legend-ring um-legend-ring--stopped", label: t("map.legend.stopped") },
    { cls: "um-legend-ring um-legend-ring--checked", label: t("map.legend.selected") },
  ];
  return (
    <section
      className={cn(
        "absolute left-2 z-[5] rounded-lg bg-card/95 text-[12px] shadow-sm ring-1 ring-border backdrop-blur-sm",
        google ? "bottom-8" : "bottom-3",
      )}
      aria-label={t("map.legend")}
      data-testid="map-legend"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="map-legend-items"
        className="flex min-h-8 w-full items-center justify-between gap-2 rounded-lg px-3 py-1.5 font-medium transition-colors hover:bg-accent"
      >
        {t("map.legend")}
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden
        />
        <span className="sr-only">{open ? t("map.legend.hide") : t("map.legend.show")}</span>
      </button>
      {open && (
        <ul id="map-legend-items" className="flex flex-col gap-1 px-3 pb-2">
          {novelty.map((i) => (
            <li key={i.label} className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full ring-2 ring-white"
                style={{ background: i.color }}
                aria-hidden
              />
              {i.label}
            </li>
          ))}
          {contact.map((i) => (
            <li key={i.label} className="flex items-center gap-2">
              <span className={i.cls} aria-hidden />
              {i.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "Görünümdekileri seç": haritada görünen alandaki işletmeleri seçer. Nokta listesi tam ise sayım tarayıcıda yapılır;
 * 20.000 nokta sınırı aşıldıysa (eksik liste) veya 2000'den fazla işletme varsa seçim, alanın süzgeç sorgusu olur ve
 * sayıyı sunucu verir.
 */
function useSelectInView(points: number[][], truncated: boolean) {
  const ex = useExplore();
  const inView = useMemo(
    () => (ex.viewBounds ? pointsInBounds(points, ex.viewBounds) : []),
    [points, ex.viewBounds],
  );
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    const b = ex.viewBounds;
    if (!b) return;
    if (!truncated && inView.length <= MAX_SELECTION) {
      ex.selectIds(inView);
      return;
    }
    const bbox = [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(",");
    const q = toSearchParams({ ...ex.mapFilters, bbox }).toString();
    let count = inView.length;
    if (truncated) {
      setBusy(true);
      try {
        count = (await api<{ total: number }>(`/api/leads?${q}&limit=1`)).total;
      } catch (e) {
        toast.error((e as Error).message);
        return;
      } finally {
        setBusy(false);
      }
    }
    ex.selectQuery(q, count, "view");
  }, [ex, inView, truncated]);
  return { count: inView.length, approximate: truncated, run, busy };
}

export function MapPanel() {
  const ex = useExplore();
  const { data: config } = useConfig();
  // Harita alanı (bbox) HARİÇ süzgeçler: kaydırınca işaretçiler kaybolmaz, gereksiz yeniden sorgu olmaz.
  const { data: pointData, isFetching } = usePoints(ex.mapFilters);
  const points = useMemo(() => pointData?.points ?? [], [pointData]);
  const truncated = pointData?.truncated === true;
  const selectInView = useSelectInView(points, truncated);
  const checkedIds = useMemo(
    () => (ex.selection.mode === "ids" ? ex.selection.ids : new Set<number>()),
    [ex.selection],
  );

  const onDrawn = useCallback(
    (r: DraftRegion) => {
      ex.setDraft(r);
      ex.setDrawMode(null);
      ex.setTab("scan");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const fitResults = useCallback(() => {
    const fit = boundsOfPoints(points);
    if (fit) ex.requestFocus({ fit });
  }, [points, ex]);

  // Klavye kısayolu (F) bu paneli doğrudan çağıramaz; sayaç değişince sığdırılır.
  const fitRef = useRef(fitResults);
  fitRef.current = fitResults;
  useEffect(() => {
    if (ex.fitNonce > 0) fitRef.current();
  }, [ex.fitNonce]);

  if (!config) return <MapLoading />;

  const common = {
    points,
    selectedId: ex.selectedId,
    checkedIds,
    onSelect: (id: number | null) => ex.select(id),
    draft: ex.draft,
    onDraftChange: ex.setDraft,
    drawMode: ex.drawMode,
    onDrawn,
    onBoundsChange: ex.setViewBounds,
    focus: ex.focus,
  };

  const google = !!config.mapsKey;
  const schematic = !google && config.provider === "mock";
  let body: React.ReactNode;
  if (google) {
    body = <GoogleMapView {...common} apiKey={config.mapsKey!} mapId={config.mapId} />;
  } else if (schematic) {
    body = <SchematicMapView {...common} />;
  } else {
    body = (
      <div className="flex size-full items-center justify-center p-8">
        <div className="um-enter max-w-sm rounded-xl border bg-card p-6 text-center shadow-xs">
          <KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-semibold">{t("map.noKey.title")}</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">{t("map.noKey.body")}</p>
          <Button asChild size="sm" className="mt-4">
            <Link href="/settings">{t("map.noKey.cta")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const noPoints = !isFetching && pointData && points.length === 0 && !ex.drawMode;

  return (
    <div className="relative size-full bg-muted">
      {body}
      {(google || schematic) && (
        <>
          <Legend google={google} />
          {/*
           * Tek kaplama düzeni: üst satırda solda bilgi (şematik görünüm notu), sağda harita düğmeleri; durum notları
           * (sonuç yok, çizim ipucu) her zaman bunların ALTINDA ortalanır. Böylece dar ekranda bile üst üste binmezler.
           */}
          <div className="pointer-events-none absolute inset-x-3 top-3 z-[5] flex flex-col items-center gap-2">
            <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
              <div className="min-w-0">
                {schematic && (
                  <p
                    className="pointer-events-auto inline-flex max-w-[min(28rem,100%)] items-start gap-1.5 rounded-md bg-card/90 px-2.5 py-1.5 text-[12px] text-muted-foreground shadow-xs ring-1 ring-border"
                    data-testid="schematic-banner"
                  >
                    <span className="font-medium text-foreground">{t("map.schematic.badge")}</span>
                    <span className="hidden sm:inline" aria-hidden>
                      ·
                    </span>
                    <span className="hidden sm:inline">{t("map.schematic.hint")}</span>
                    <Tip content={t("map.schematic.hint")}>
                      <button
                        type="button"
                        className="rounded p-0.5 sm:hidden"
                        aria-label={t("map.schematic.hint")}
                      >
                        <Info className="size-3.5" aria-hidden />
                      </button>
                    </Tip>
                  </p>
                )}
              </div>
              <div className="pointer-events-auto flex flex-col items-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fitResults}
                  disabled={points.length === 0}
                  className="shadow-xs"
                  title={`${t("map.fit")} (F)`}
                >
                  <Crosshair /> {t("map.fit")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void selectInView.run()}
                  disabled={
                    !ex.viewBounds ||
                    !!ex.drawMode ||
                    (selectInView.count === 0 && !selectInView.approximate)
                  }
                  loading={selectInView.busy}
                  className="shadow-xs"
                  title={t("map.selectInView.hint")}
                >
                  <CheckSquare />
                  {t("map.selectInView", {
                    n: fmtNumber(selectInView.count) + (selectInView.approximate ? "+" : ""),
                  })}
                </Button>
                <label className="flex cursor-pointer items-center gap-2 rounded-md bg-card/95 px-2.5 py-1.5 text-[12px] shadow-xs ring-1 ring-border">
                  <Switch
                    checked={ex.onlyInView}
                    onCheckedChange={ex.setOnlyInView}
                    aria-label={t("map.onlyThisArea")}
                  />
                  {t("map.onlyThisArea")}
                </label>
                {isFetching && (
                  <span
                    className="inline-flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs ring-1 ring-border"
                    role="status"
                  >
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    {t("common.updating")}
                  </span>
                )}
                {truncated && (
                  <span className="max-w-56 rounded-md bg-card/95 px-2.5 py-1.5 text-right text-[11px] text-muted-foreground shadow-xs ring-1 ring-border">
                    {t("map.truncated")}
                  </span>
                )}
              </div>
            </div>
            {noPoints && (
              <div
                className="um-enter w-fit max-w-[min(32rem,100%)] rounded-full bg-card/95 px-4 py-2 text-center text-[13px] text-muted-foreground shadow-sm ring-1 ring-border"
                role="status"
                data-testid="map-empty"
              >
                {t("map.noPoints")}
              </div>
            )}
            {ex.drawMode && (
              <div className="w-fit rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background shadow-lg">
                {ex.drawMode === "rect" ? t("map.draw.rect") : t("map.draw.circle")}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
