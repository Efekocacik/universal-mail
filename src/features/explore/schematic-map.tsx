"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { LABEL_COLORS, type MapViewProps } from "./map-types";

/**
 * Şematik demo görünümü: arka plan haritası olmayan, koordinatları düzlemde gösteren basit görünüm.
 * YALNIZCA demo (yapay) veriler için kullanılır; Google Places verisi Google dışı bir haritada/çizimde
 * GÖSTERİLMEZ (Google şartları). Anahtarsız deneme ve test amaçlıdır.
 */
interface View {
  cx: number;
  cy: number;
  scale: number; // derece / piksel
}

const DEFAULT_VIEW: View = { cx: 10, cy: -50, scale: 0.05 };

export function SchematicMapView({
  points,
  selectedId,
  onSelect,
  draft,
  onBoundsChange,
  focus,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [fitted, setFitted] = useState(false);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(
    null,
  );

  const refLat = useMemo(() => {
    if (points.length === 0) return draft ? (draft.bbox.south + draft.bbox.north) / 2 : 50;
    return points.reduce((a, p) => a + p[1]!, 0) / points.length;
  }, [points, draft]);
  const kx = Math.cos((refLat * Math.PI) / 180);
  const toWorld = useCallback((lat: number, lng: number) => ({ x: lng * kx, y: -lat }), [kx]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }),
    );
    ro.observe(el);
    setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    return () => ro.disconnect();
  }, []);

  const fitTo = useCallback(
    (b: { south: number; west: number; north: number; east: number }) => {
      const a = toWorld(b.north, b.west);
      const c = toWorld(b.south, b.east);
      const w = Math.max(1e-4, Math.abs(c.x - a.x));
      const h = Math.max(1e-4, Math.abs(c.y - a.y));
      setView({
        cx: (a.x + c.x) / 2,
        cy: (a.y + c.y) / 2,
        scale: Math.max(w / (size.w * 0.9), h / (size.h * 0.9)),
      });
    },
    [toWorld, size.w, size.h],
  );

  // İlk anlamlı veri geldiğinde sığdır.
  useEffect(() => {
    if (fitted || size.w < 50) return;
    if (points.length > 0) {
      const lats = points.map((p) => p[1]!);
      const lngs = points.map((p) => p[2]!);
      fitTo({
        south: Math.min(...lats),
        north: Math.max(...lats),
        west: Math.min(...lngs),
        east: Math.max(...lngs),
      });
      setFitted(true);
    } else if (draft) {
      fitTo(draft.bbox);
      setFitted(true);
    }
  }, [points, draft, fitted, fitTo, size.w]);

  useEffect(() => {
    if (!focus) return;
    if (focus.fit) fitTo(focus.fit);
    else if (focus.lat !== undefined && focus.lng !== undefined) {
      const w = toWorld(focus.lat, focus.lng);
      setView((v) => ({ cx: w.x, cy: w.y, scale: Math.min(v.scale, 0.0035) }));
    }
  }, [focus, fitTo, toWorld]);

  // Görünür alanı üst bileşene bildir (gecikmeli).
  useEffect(() => {
    const id = setTimeout(() => {
      const halfW = (size.w / 2) * view.scale;
      const halfH = (size.h / 2) * view.scale;
      onBoundsChange({
        west: (view.cx - halfW) / kx,
        east: (view.cx + halfW) / kx,
        north: -(view.cy - halfH),
        south: -(view.cy + halfH),
      });
    }, 200);
    return () => clearTimeout(id);
  }, [view, size, kx, onBoundsChange]);

  const sx = (x: number) => (x - view.cx) / view.scale + size.w / 2;
  const sy = (y: number) => (y - view.cy) / view.scale + size.h / 2;

  const visible = useMemo(() => {
    const out: { id: number; x: number; y: number; color: string; contacted: boolean }[] = [];
    for (const p of points) {
      const w = toWorld(p[1]!, p[2]!);
      const x = sx(w.x);
      const y = sy(w.y);
      if (x < -10 || y < -10 || x > size.w + 10 || y > size.h + 10) continue;
      out.push({
        id: p[0]!,
        x,
        y,
        color: LABEL_COLORS[p[3] ?? 3] ?? LABEL_COLORS[3],
        contacted: p[4] !== 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, view, size, toWorld]);

  const region = useMemo(() => {
    if (!draft) return null;
    const a = toWorld(draft.bbox.north, draft.bbox.west);
    const b = toWorld(draft.bbox.south, draft.bbox.east);
    return { x: sx(a.x), y: sy(a.y), w: (b.x - a.x) / view.scale, h: (b.y - a.y) / view.scale };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, view, size, toWorld]);

  return (
    <div
      ref={ref}
      className="relative size-full cursor-grab touch-none select-none overflow-hidden bg-[#eef1ec] active:cursor-grabbing"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.moved) setView((v) => ({ ...v, cx: d.cx - dx * v.scale, cy: d.cy - dy * v.scale }));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && (e.target as HTMLElement).dataset.pin !== "1") onSelect(null);
      }}
      onWheel={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        setView((v) => {
          const wx = v.cx + (px - size.w / 2) * v.scale;
          const wy = v.cy + (py - size.h / 2) * v.scale;
          const scale = Math.min(0.5, Math.max(0.00005, v.scale * factor));
          return { scale, cx: wx - (px - size.w / 2) * scale, cy: wy - (py - size.h / 2) * scale };
        });
      }}
      role="application"
      aria-label={t("map.schematic.label")}
    >
      <svg width={size.w} height={size.h} className="absolute inset-0">
        {region && (
          <rect
            x={region.x}
            y={region.y}
            width={region.w}
            height={region.h}
            fill="rgba(20,112,90,0.08)"
            stroke="#14705a"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        )}
        {visible.map((p) => (
          <circle
            key={p.id}
            data-pin="1"
            cx={p.x}
            cy={p.y}
            r={selectedId === p.id ? 9 : 5}
            fill={p.color}
            stroke={selectedId === p.id ? "#0d4d3d" : p.contacted ? "#2563eb" : "#fff"}
            strokeWidth={selectedId === p.id ? 3 : 1.5}
            className="cursor-pointer"
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!drag.current?.moved) onSelect(p.id);
              drag.current = null;
            }}
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-card/90 px-2.5 py-1.5 text-[12px] text-muted-foreground shadow-xs ring-1 ring-border">
        {t("map.schematic.banner")}
      </div>
    </div>
  );
}
