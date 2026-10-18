"use client";

import { Crosshair, KeyRound } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useConfig, usePoints } from "@/lib/client/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { LABEL_COLORS } from "./map-types";
import { useExplore, type DraftRegion } from "./state";

const GoogleMapView = dynamic(() => import("./google-map").then((m) => m.GoogleMapView), {
  ssr: false,
  loading: () => <MapLoading />,
});
const SchematicMapView = dynamic(() => import("./schematic-map").then((m) => m.SchematicMapView), {
  ssr: false,
  loading: () => <MapLoading />,
});

function MapLoading() {
  return (
    <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
      {t("map.loading")}
    </div>
  );
}

function Legend() {
  const items = [
    { color: LABEL_COLORS[0], label: t("novelty.future_opening") },
    { color: LABEL_COLORS[1], label: t("novelty.high") },
    { color: LABEL_COLORS[2], label: t("novelty.likely") },
    { color: LABEL_COLORS[3], label: t("novelty.low") },
  ];
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-card/95 px-3 py-2 text-[12px] shadow-sm ring-1 ring-border"
      aria-label={t("map.legend")}
    >
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full ring-2 ring-white"
              style={{ background: i.color }}
            />
            {i.label}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-white ring-2 ring-contacted" />
          {t("map.legend.contacted")}
        </li>
      </ul>
    </div>
  );
}

export function MapPanel() {
  const ex = useExplore();
  const { data: config } = useConfig();
  const { data: pointData, isFetching } = usePoints(ex.apiFilters);
  const points = useMemo(() => pointData?.points ?? [], [pointData]);

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
    if (points.length === 0) return;
    const lats = points.map((p) => p[1]!);
    const lngs = points.map((p) => p[2]!);
    ex.requestFocus({
      fit: {
        south: Math.min(...lats),
        north: Math.max(...lats),
        west: Math.min(...lngs),
        east: Math.max(...lngs),
      },
    });
  }, [points, ex]);

  if (!config) return <MapLoading />;

  const common = {
    points,
    selectedId: ex.selectedId,
    onSelect: (id: number | null) => ex.select(id),
    draft: ex.draft,
    onDraftChange: ex.setDraft,
    drawMode: ex.drawMode,
    onDrawn,
    onBoundsChange: ex.setViewBounds,
    focus: ex.focus,
  };

  let body: React.ReactNode;
  if (config.mapsKey) {
    body = <GoogleMapView {...common} apiKey={config.mapsKey} mapId={config.mapId} />;
  } else if (config.provider === "mock") {
    body = <SchematicMapView {...common} />;
  } else {
    body = (
      <div className="flex size-full items-center justify-center p-8">
        <div className="max-w-sm rounded-xl border bg-card p-6 text-center shadow-xs">
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

  return (
    <div className="relative size-full bg-muted">
      {body}
      {(config.mapsKey || config.provider === "mock") && (
        <>
          <Legend />
          <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fitResults}
              disabled={points.length === 0}
              className="shadow-xs"
            >
              <Crosshair /> {t("map.fit")}
            </Button>
            {isFetching && (
              <span className="rounded-md bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs ring-1 ring-border">
                {t("common.updating")}
              </span>
            )}
            {pointData?.truncated && (
              <span
                className={cn(
                  "max-w-56 rounded-md bg-card/95 px-2.5 py-1.5 text-right text-[11px] text-muted-foreground shadow-xs ring-1 ring-border",
                )}
              >
                {t("map.truncated")}
              </span>
            )}
          </div>
          {ex.drawMode && (
            <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background shadow-lg">
              {ex.drawMode === "rect" ? t("map.draw.rect") : t("map.draw.circle")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
