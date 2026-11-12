"use client";

import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { APIProvider, Map, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { pinClassName, readCamera, regionFromDrag, writeCamera, type Camera } from "./map-math";
import { LABEL_COLORS, type MapPoint, type MapViewProps } from "./map-types";

const SHAPE_STYLE = {
  strokeColor: "#14705a",
  strokeOpacity: 0.95,
  strokeWeight: 2,
  fillColor: "#14705a",
  fillOpacity: 0.08,
} as const;

interface PinRef {
  marker: google.maps.marker.AdvancedMarkerElement;
  el: HTMLElement;
}

/**
 * İşaretçiler. Google belgelerine göre `AdvancedMarkerElement` tıklamaları yalnızca `gmpClickable: true` iken ve
 * `gmp-click` olayıyla (addEventListener) alınır; `addListener("click")` kullanımdan kalkmıştır.
 * İçerik öğelerine kendi referanslarımızdan erişiriz (marker.content özelliği kullanımdan kalkmıştır).
 */
const NOVELTY_KEYS = [
  "novelty.future_opening",
  "novelty.high",
  "novelty.likely",
  "novelty.low",
] as const;
const CONTACT_KEYS = [null, "map.legend.sent", "map.legend.replied", "map.legend.stopped"] as const;

/** Ekran okuyucu için işaretçi adı: yenilik etiketi ve (varsa) temas durumu. */
function markerTitle(p: MapPoint): string {
  const novelty = t(NOVELTY_KEYS[p[3] ?? 3] ?? "novelty.low");
  const contact = CONTACT_KEYS[p[4] ?? 0];
  return contact
    ? t("map.marker.labelContact", { novelty, contact: t(contact) })
    : t("map.marker.label", { novelty });
}

function Markers({
  points,
  selectedId,
  checkedIds,
  onSelect,
}: Pick<MapViewProps, "points" | "selectedId" | "checkedIds" | "onSelect">) {
  const map = useMap();
  const markerLib = useMapsLibrary("marker");
  const byId = useRef(new globalThis.Map<number, PinRef>());
  const selectRef = useRef(onSelect);
  const prevSelected = useRef<number | null>(null);
  const checkedRef = useRef(checkedIds);
  const prevChecked = useRef<ReadonlySet<number>>(new Set());
  selectRef.current = onSelect;
  checkedRef.current = checkedIds;

  useEffect(() => {
    if (!map || !markerLib) return;
    const index = byId.current;
    const markers = points.map((p: MapPoint) => {
      const el = document.createElement("div");
      el.className = pinClassName(p[4], checkedRef.current.has(p[0]!));
      el.style.background = LABEL_COLORS[p[3] ?? 3] ?? LABEL_COLORS[3];
      const marker = new markerLib.AdvancedMarkerElement({
        position: { lat: p[1]!, lng: p[2]! },
        content: el,
        gmpClickable: true,
        title: markerTitle(p),
      });
      marker.addEventListener("gmp-click", () => selectRef.current(p[0]!));
      index.set(p[0]!, { marker, el });
      return marker;
    });
    const clusterer = new MarkerClusterer({
      map,
      markers,
      renderer: {
        render: ({ count, position }) => {
          const el = document.createElement("div");
          const size = Math.round(26 + Math.min(18, Math.log10(count) * 8));
          el.className = "um-cluster";
          el.style.width = el.style.height = `${size}px`;
          el.textContent = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
          // Küme tıklaması (yakınlaştırma) için işaretçinin tıklanabilir olması gerekir.
          return new markerLib.AdvancedMarkerElement({
            position,
            content: el,
            zIndex: 1000 + count,
            gmpClickable: true,
            title: t("map.cluster", { n: count }),
          });
        },
      },
    });
    return () => {
      clusterer.clearMarkers();
      clusterer.setMap(null);
      index.clear();
      prevSelected.current = null;
      prevChecked.current = checkedRef.current;
    };
  }, [map, markerLib, points]);

  // Toplu seçim: yalnızca değişen işaretçilere dokunulur (binlerce işaretçide de ucuz).
  useEffect(() => {
    const index = byId.current;
    const prev = prevChecked.current;
    for (const id of prev)
      if (!checkedIds.has(id)) index.get(id)?.el.classList.remove("um-pin--checked");
    for (const id of checkedIds)
      if (!prev.has(id)) index.get(id)?.el.classList.add("um-pin--checked");
    prevChecked.current = checkedIds;
  }, [checkedIds, points]);

  useEffect(() => {
    const index = byId.current;
    const prev = prevSelected.current !== null ? index.get(prevSelected.current) : undefined;
    if (prev) {
      prev.el.classList.remove("um-pin--selected");
      prev.marker.zIndex = null;
    }
    const cur = selectedId !== null ? index.get(selectedId) : undefined;
    if (cur) {
      cur.el.classList.add("um-pin--selected");
      cur.marker.zIndex = 9999;
    }
    prevSelected.current = selectedId;
  }, [selectedId, points]);

  return null;
}

function bboxOfBounds(b: google.maps.LatLngBounds) {
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  return { south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() };
}

function ViewReporter({ onBoundsChange }: Pick<MapViewProps, "onBoundsChange">) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const b = map.getBounds(); // harita hazır olana kadar undefined olabilir
      if (b) onBoundsChange(bboxOfBounds(b));
      // Kamera hatırlanır (yeniden açılışta aynı yerden başlar); sık yazmamak için gecikmeli.
      clearTimeout(timer);
      timer = setTimeout(() => {
        const c = map.getCenter();
        const z = map.getZoom();
        if (c && z !== undefined) writeCamera({ lat: c.lat(), lng: c.lng(), zoom: z });
      }, 500);
    };
    const l = map.addListener("idle", report);
    report();
    return () => {
      clearTimeout(timer);
      l.remove();
    };
  }, [map, onBoundsChange]);
  return null;
}

function Focuser({ focus }: Pick<MapViewProps, "focus">) {
  const map = useMap();
  useEffect(() => {
    if (!map || !focus) return;
    if (focus.fit) {
      map.fitBounds(
        {
          south: focus.fit.south,
          west: focus.fit.west,
          north: focus.fit.north,
          east: focus.fit.east,
        },
        48,
      );
    } else if (focus.lat !== undefined && focus.lng !== undefined) {
      map.panTo({ lat: focus.lat, lng: focus.lng });
      if (focus.zoom && (map.getZoom() ?? 0) < focus.zoom) map.setZoom(focus.zoom);
    }
  }, [map, focus]);
  return null;
}

/** Taslak bölgeyi çizer; kullanıcı tutamaçlardan sürükleyerek düzenleyebilir (Rectangle/Circle `editable`). */
function RegionShape({ draft, onDraftChange }: Pick<MapViewProps, "draft" | "onDraftChange">) {
  const map = useMap();
  const shapeRef = useRef<google.maps.Rectangle | google.maps.Circle | null>(null);
  const draftRef = useRef(draft);
  const changeRef = useRef(onDraftChange);
  draftRef.current = draft;
  changeRef.current = onDraftChange;

  const kind = draft ? (draft.kind === "circle" && draft.circle ? "circle" : "rect") : null;
  const editable = draft?.kind === "bbox" || draft?.kind === "circle";

  useEffect(() => {
    if (!map || !kind) return;
    const d = draftRef.current!;
    const listeners: google.maps.MapsEventListener[] = [];
    if (kind === "circle" && d.circle) {
      const circle = new google.maps.Circle({
        ...SHAPE_STYLE,
        map,
        center: { lat: d.circle.lat, lng: d.circle.lng },
        radius: d.circle.radiusM,
        editable,
        clickable: false,
      });
      const push = () => {
        const c = circle.getCenter();
        const cur = draftRef.current;
        const b = circle.getBounds();
        if (!c || !cur || !b) return;
        changeRef.current({
          ...cur,
          kind: "circle",
          circle: { lat: c.lat(), lng: c.lng(), radiusM: Math.round(circle.getRadius()) },
          bbox: bboxOfBounds(b),
        });
      };
      listeners.push(
        circle.addListener("radius_changed", push),
        circle.addListener("center_changed", push),
      );
      shapeRef.current = circle;
    } else {
      const rect = new google.maps.Rectangle({
        ...SHAPE_STYLE,
        map,
        bounds: { south: d.bbox.south, west: d.bbox.west, north: d.bbox.north, east: d.bbox.east },
        editable,
        clickable: false,
      });
      listeners.push(
        rect.addListener("bounds_changed", () => {
          const b = rect.getBounds();
          const cur = draftRef.current;
          if (b && cur) changeRef.current({ ...cur, bbox: bboxOfBounds(b) });
        }),
      );
      shapeRef.current = rect;
    }
    return () => {
      listeners.forEach((l) => l.remove());
      shapeRef.current?.setMap(null);
      shapeRef.current = null;
    };
  }, [map, kind, editable]);

  // Dışarıdan gelen değişiklikleri (yarıçap kaydırıcısı vb.) şekle yansıt.
  useEffect(() => {
    const shape = shapeRef.current;
    if (!shape || !draft) return;
    if (shape instanceof google.maps.Rectangle) {
      const cur = shape.getBounds();
      const ne = cur?.getNorthEast();
      const sw = cur?.getSouthWest();
      const same =
        ne &&
        sw &&
        Math.abs(ne.lat() - draft.bbox.north) < 1e-6 &&
        Math.abs(sw.lat() - draft.bbox.south) < 1e-6 &&
        Math.abs(ne.lng() - draft.bbox.east) < 1e-6 &&
        Math.abs(sw.lng() - draft.bbox.west) < 1e-6;
      if (!same)
        shape.setBounds({
          south: draft.bbox.south,
          west: draft.bbox.west,
          north: draft.bbox.north,
          east: draft.bbox.east,
        });
    } else if (draft.circle) {
      if (Math.abs(shape.getRadius() - draft.circle.radiusM) > 1)
        shape.setRadius(draft.circle.radiusM);
      const c = shape.getCenter();
      if (
        !c ||
        Math.abs(c.lat() - draft.circle.lat) > 1e-6 ||
        Math.abs(c.lng() - draft.circle.lng) > 1e-6
      )
        shape.setCenter({ lat: draft.circle.lat, lng: draft.circle.lng });
    }
  }, [draft]);

  return null;
}

/**
 * Fare ile dikdörtgen veya daire çizme (FR-UI-03). Google'ın `Map` nesnesi fare basma/bırakma olayı vermediğinden
 * (olay listesinde yok) ve `DrawingManager` kullanımdan kaldırıldığından, haritanın üstüne saydam bir katman konur.
 * Önizleme piksel tabanlı SVG'dir; bırakınca pikseller `map.getBounds()` üzerinden koordinata çevrilir (map-math.ts).
 * Harita 2B kalır (eğim/yön etkileşimi kapalı), bu yüzden dönüşüm kesindir.
 */
function DrawOverlay({ drawMode, onDrawn }: Pick<MapViewProps, "drawMode" | "onDrawn">) {
  const map = useMap();
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  if (!drawMode) return null;

  const rel = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div
      ref={ref}
      data-testid="draw-overlay"
      className="absolute inset-0 z-10 cursor-crosshair touch-none select-none"
      onPointerDown={(e) => {
        const p = rel(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = rel(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        if (!drag || !map) return setDrag(null);
        const p = rel(e);
        const bounds = map.getBounds();
        const el = ref.current!;
        setDrag(null);
        if (!bounds) return;
        const region = regionFromDrag(
          drawMode,
          { x: drag.x0, y: drag.y0 },
          p,
          { w: el.clientWidth, h: el.clientHeight },
          bboxOfBounds(bounds),
        );
        if (region) onDrawn(region);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {drag && (
        <svg className="pointer-events-none absolute inset-0 size-full">
          {drawMode === "rect" ? (
            <rect
              x={Math.min(drag.x0, drag.x1)}
              y={Math.min(drag.y0, drag.y1)}
              width={Math.abs(drag.x1 - drag.x0)}
              height={Math.abs(drag.y1 - drag.y0)}
              fill="rgba(20,112,90,0.12)"
              stroke="#14705a"
              strokeWidth={2}
            />
          ) : (
            <circle
              cx={drag.x0}
              cy={drag.y0}
              r={Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0)}
              fill="rgba(20,112,90,0.12)"
              stroke="#14705a"
              strokeWidth={2}
            />
          )}
        </svg>
      )}
    </div>
  );
}

const DEFAULT_CAMERA: Camera = { lat: 50, lng: 10, zoom: 4 };

export function GoogleMapView(props: MapViewProps & { apiKey: string; mapId: string }) {
  const [authError, setAuthError] = useState(false);
  // Hatırlanan kamera yalnızca ilk açılışta okunur (harita "denetimsiz": sonrası kullanıcının hareketidir).
  const [camera] = useState<Camera>(() => readCamera() ?? DEFAULT_CAMERA);

  useEffect(() => {
    // Google, anahtar/faturalandırma/kısıt sorununda bu global işlevi çağırır.
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () =>
      setAuthError(true);
    return () => {
      delete (window as unknown as { gm_authFailure?: () => void }).gm_authFailure;
    };
  }, []);

  if (authError) {
    return (
      <div className="flex size-full items-center justify-center p-8">
        <div className="max-w-sm rounded-xl border bg-card p-5 text-center shadow-xs">
          <p className="text-sm font-semibold">{t("map.authError.title")}</p>
          <p className="mt-2 text-[13px] text-muted-foreground">{t("map.authError.body")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative size-full">
      <APIProvider apiKey={props.apiKey} language="tr">
        <Map
          mapId={props.mapId}
          defaultCenter={{ lat: camera.lat, lng: camera.lng }}
          defaultZoom={camera.zoom}
          gestureHandling="greedy"
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
          rotateControl={false}
          tiltInteractionEnabled={false}
          headingInteractionEnabled={false}
          clickableIcons={false}
          className="size-full"
          onClick={() => props.onSelect(null)}
        >
          <Markers
            points={props.points}
            selectedId={props.selectedId}
            checkedIds={props.checkedIds}
            onSelect={props.onSelect}
          />
          <RegionShape draft={props.draft} onDraftChange={props.onDraftChange} />
          <ViewReporter onBoundsChange={props.onBoundsChange} />
          <Focuser focus={props.focus} />
        </Map>
        <DrawOverlay drawMode={props.drawMode} onDrawn={props.onDrawn} />
      </APIProvider>
    </div>
  );
}
