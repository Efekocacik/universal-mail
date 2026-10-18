"use client";

import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { APIProvider, Map, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { DraftRegion } from "./state";
import { LABEL_COLORS, type MapPoint, type MapViewProps } from "./map-types";

const SHAPE_STYLE = {
  strokeColor: "#14705a",
  strokeOpacity: 0.95,
  strokeWeight: 2,
  fillColor: "#14705a",
  fillOpacity: 0.08,
} as const;

function Markers({
  points,
  selectedId,
  onSelect,
}: Pick<MapViewProps, "points" | "selectedId" | "onSelect">) {
  const map = useMap();
  const markerLib = useMapsLibrary("marker");
  const byId = useRef(new globalThis.Map<number, google.maps.marker.AdvancedMarkerElement>());
  const selectRef = useRef(onSelect);
  const prevSelected = useRef<number | null>(null);
  selectRef.current = onSelect;

  useEffect(() => {
    if (!map || !markerLib) return;
    const index = byId.current;
    const markers = points.map((p: MapPoint) => {
      const el = document.createElement("div");
      el.className = `um-pin${p[4] !== 0 ? " um-pin--contacted" : ""}`;
      el.style.background = LABEL_COLORS[p[3] ?? 3] ?? LABEL_COLORS[3];
      const marker = new markerLib.AdvancedMarkerElement({
        position: { lat: p[1]!, lng: p[2]! },
        content: el,
      });
      marker.addListener("click", () => selectRef.current(p[0]!));
      index.set(p[0]!, marker);
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
          return new markerLib.AdvancedMarkerElement({
            position,
            content: el,
            zIndex: 1000 + count,
          });
        },
      },
    });
    return () => {
      clusterer.clearMarkers();
      clusterer.setMap(null);
      index.clear();
      prevSelected.current = null;
    };
  }, [map, markerLib, points]);

  useEffect(() => {
    const index = byId.current;
    const prev = prevSelected.current !== null ? index.get(prevSelected.current) : undefined;
    if (prev) {
      (prev.content as HTMLElement).classList.remove("um-pin--selected");
      prev.zIndex = null;
    }
    const cur = selectedId !== null ? index.get(selectedId) : undefined;
    if (cur) {
      (cur.content as HTMLElement).classList.add("um-pin--selected");
      cur.zIndex = 9999;
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
    const report = () => {
      const b = map.getBounds();
      if (b) onBoundsChange(bboxOfBounds(b));
    };
    const l = map.addListener("idle", report);
    report();
    return () => l.remove();
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

/** Taslak bölgeyi çizer; kullanıcı tutamaçlardan sürükleyerek düzenleyebilir. */
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
        if (!c || !cur) return;
        const radiusM = Math.round(circle.getRadius());
        const b = circle.getBounds();
        if (!b) return;
        changeRef.current({
          ...cur,
          kind: "circle",
          circle: { lat: c.lat(), lng: c.lng(), radiusM },
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

/** Fare ile dikdörtgen veya daire çizme (FR-UI-03). Google'ın kullanımdan kalkan DrawingManager'ı kullanılmaz. */
function Drawer({ drawMode, onDrawn }: Pick<MapViewProps, "drawMode" | "onDrawn">) {
  const map = useMap();
  const drawnRef = useRef(onDrawn);
  drawnRef.current = onDrawn;

  useEffect(() => {
    if (!map || !drawMode) return;
    map.setOptions({ draggable: false, draggableCursor: "crosshair", gestureHandling: "none" });
    let start: google.maps.LatLng | null = null;
    let shape: google.maps.Rectangle | google.maps.Circle | null = null;

    const bounds = (a: google.maps.LatLng, b: google.maps.LatLng) => ({
      south: Math.min(a.lat(), b.lat()),
      north: Math.max(a.lat(), b.lat()),
      west: Math.min(a.lng(), b.lng()),
      east: Math.max(a.lng(), b.lng()),
    });

    const down = map.addListener("mousedown", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      start = e.latLng;
      shape =
        drawMode === "rect"
          ? new google.maps.Rectangle({
              ...SHAPE_STYLE,
              map,
              bounds: bounds(start, start),
              clickable: false,
            })
          : new google.maps.Circle({
              ...SHAPE_STYLE,
              map,
              center: start,
              radius: 1,
              clickable: false,
            });
    });
    const move = map.addListener("mousemove", (e: google.maps.MapMouseEvent) => {
      if (!start || !shape || !e.latLng) return;
      if (shape instanceof google.maps.Rectangle) shape.setBounds(bounds(start, e.latLng));
      else
        shape.setRadius(
          google.maps.geometry?.spherical
            ? google.maps.geometry.spherical.computeDistanceBetween(start, e.latLng)
            : approxMeters(start, e.latLng),
        );
    });
    const up = map.addListener("mouseup", (e: google.maps.MapMouseEvent) => {
      if (!start || !shape || !e.latLng) return;
      const s = start;
      shape.setMap(null);
      shape = null;
      start = null;
      if (drawMode === "rect") {
        const b = bounds(s, e.latLng);
        if (b.north - b.south < 1e-4 || b.east - b.west < 1e-4) return;
        drawnRef.current({ kind: "bbox", name: "Çizilen alan", bbox: b });
      } else {
        const radiusM = Math.max(100, Math.min(50_000, Math.round(approxMeters(s, e.latLng))));
        const dLat = radiusM / 111_320;
        const dLng = radiusM / (111_320 * Math.cos((s.lat() * Math.PI) / 180));
        drawnRef.current({
          kind: "circle",
          name: "Çizilen daire",
          circle: { lat: s.lat(), lng: s.lng(), radiusM },
          bbox: {
            south: s.lat() - dLat,
            north: s.lat() + dLat,
            west: s.lng() - dLng,
            east: s.lng() + dLng,
          },
        });
      }
    });

    return () => {
      down.remove();
      move.remove();
      up.remove();
      shape?.setMap(null);
      map.setOptions({ draggable: true, draggableCursor: null, gestureHandling: "greedy" });
    };
  }, [map, drawMode]);

  return null;
}

function approxMeters(a: google.maps.LatLng, b: google.maps.LatLng): number {
  const R = 6_371_000;
  const dLat = ((b.lat() - a.lat()) * Math.PI) / 180;
  const dLng = ((b.lng() - a.lng()) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat() * Math.PI) / 180) *
      Math.cos((b.lat() * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function GoogleMapView(props: MapViewProps & { apiKey: string; mapId: string }) {
  const [authError, setAuthError] = useState(false);

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
    <APIProvider apiKey={props.apiKey} language="tr" libraries={["marker", "geometry"]}>
      <Map
        mapId={props.mapId}
        defaultCenter={{ lat: 50, lng: 10 }}
        defaultZoom={4}
        gestureHandling="greedy"
        mapTypeControl={false}
        streetViewControl={false}
        fullscreenControl={false}
        clickableIcons={false}
        className="size-full"
        onClick={() => props.onSelect(null)}
      >
        <Markers points={props.points} selectedId={props.selectedId} onSelect={props.onSelect} />
        <RegionShape draft={props.draft} onDraftChange={props.onDraftChange} />
        <Drawer drawMode={props.drawMode} onDrawn={props.onDrawn} />
        <ViewReporter onBoundsChange={props.onBoundsChange} />
        <Focuser focus={props.focus} />
      </Map>
    </APIProvider>
  );
}

export type { DraftRegion };
