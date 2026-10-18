import type { Page } from "@playwright/test";

/**
 * Sahte `google.maps`: gerçek Google ağına gitmeden, Google'ın BELGELENMİŞ sözleşmesini katı biçimde uygular.
 * Amaç, harita bileşenimizin entegrasyon mantığını (işaretçiler, kümeleme, seçim, çizim, bölge düzenleme) tarayıcıda
 * sınamaktır. Gerçek harita görüntüsünü ve Google'ın kendi davranışını SINAMAZ; onun için gerçek anahtar gerekir.
 *
 * Katı kurallar (ihlaller `window.__fakeMaps.violations` içine yazılır):
 *  - Map/Rectangle/Circle yalnızca belgelenmiş olay adlarını dinleyebilir (örn. Map'te `mousedown` YOKTUR).
 *  - AdvancedMarkerElement'e `addListener("click")` kullanımdan kalktı; tıklama yalnızca `gmpClickable: true` ise
 *    `gmp-click` olarak iletilir.
 *
 * vis.gl, `google.maps.importLibrary` zaten tanımlıysa betik indirmez; bu yüzden ağ isteği gerekmez.
 */
export async function installFakeGoogleMaps(page: Page): Promise<void> {
  // tsx/esbuild, adlandırılmış sınıf ve işlevlere `__name(...)` çağrısı ekler; sayfada tanımlı olmadığından önce tanımlanır.
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  await page.addInitScript(() => {
    const w = window as any;
    const MAP_EVENTS = [
      "bounds_changed",
      "center_changed",
      "click",
      "contextmenu",
      "dblclick",
      "drag",
      "dragend",
      "dragstart",
      "heading_changed",
      "idle",
      "isfractionalzoomenabled_changed",
      "mapcapabilities_changed",
      "maptypeid_changed",
      "mousemove",
      "mouseout",
      "mouseover",
      "projection_changed",
      "renderingtype_changed",
      "tilesloaded",
      "tilt_changed",
      "zoom_changed",
      "rightclick",
    ];
    const SHAPE_COMMON = [
      "click",
      "dblclick",
      "drag",
      "dragend",
      "dragstart",
      "mousedown",
      "mousemove",
      "mouseout",
      "mouseover",
      "mouseup",
      "contextmenu",
      "rightclick",
    ];
    const RECT_EVENTS = ["bounds_changed", ...SHAPE_COMMON];
    const CIRCLE_EVENTS = ["center_changed", "radius_changed", ...SHAPE_COMMON];
    const MARKER_EVENTS = ["gmp-click", "gmp-positionchange"];

    const log = (w.__fakeMaps = {
      violations: [] as string[],
      maps: [] as any[],
      markers: [] as any[],
      shapes: [] as any[],
      fitBoundsCalls: [] as any[],
    });

    type Handler = (...args: any[]) => void;

    class LatLng {
      constructor(a: any, b?: any) {
        if (typeof a === "object" && a !== null) {
          this._lat = typeof a.lat === "function" ? a.lat() : a.lat;
          this._lng = typeof a.lng === "function" ? a.lng() : a.lng;
        } else {
          this._lat = a;
          this._lng = b;
        }
      }
      _lat: number;
      _lng: number;
      lat() {
        return this._lat;
      }
      lng() {
        return this._lng;
      }
      toJSON() {
        return { lat: this._lat, lng: this._lng };
      }
      equals(o: any) {
        return !!o && o.lat() === this._lat && o.lng() === this._lng;
      }
      toString() {
        return `(${this._lat}, ${this._lng})`;
      }
    }
    class LatLngBounds {
      constructor(sw?: any, ne?: any) {
        this._s = sw ? new LatLng(sw).lat() : 90;
        this._w = sw ? new LatLng(sw).lng() : 180;
        this._n = ne ? new LatLng(ne).lat() : -90;
        this._e = ne ? new LatLng(ne).lng() : -180;
      }
      _s: number;
      _w: number;
      _n: number;
      _e: number;
      static fromLiteral(b: any) {
        return new LatLngBounds({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east });
      }
      getNorthEast() {
        return new LatLng(this._n, this._e);
      }
      getSouthWest() {
        return new LatLng(this._s, this._w);
      }
      getCenter() {
        return new LatLng((this._s + this._n) / 2, (this._w + this._e) / 2);
      }
      extend(p: any) {
        const l = new LatLng(p);
        this._s = Math.min(this._s, l.lat());
        this._n = Math.max(this._n, l.lat());
        this._w = Math.min(this._w, l.lng());
        this._e = Math.max(this._e, l.lng());
        return this;
      }
      contains(p: any) {
        const l = new LatLng(p);
        return l.lat() >= this._s && l.lat() <= this._n && l.lng() >= this._w && l.lng() <= this._e;
      }
      isEmpty() {
        return this._s > this._n;
      }
      toJSON() {
        return { south: this._s, west: this._w, north: this._n, east: this._e };
      }
      union(o: any) {
        this.extend(o.getNorthEast());
        this.extend(o.getSouthWest());
        return this;
      }
      intersects() {
        return true;
      }
    }
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    class Size {
      constructor(
        public width: number,
        public height: number,
      ) {}
    }

    const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const invMercY = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
    const toWorld = (lat: number, lng: number) => ({
      x: ((lng + 180) / 360) * 256,
      y: (0.5 - mercY(lat) / (2 * Math.PI)) * 256,
    });
    const fromWorld = (x: number, y: number) => ({
      lng: (x / 256) * 360 - 180,
      lat: invMercY((0.5 - y / 256) * 2 * Math.PI),
    });

    class Evented {
      _valid: Set<string>;
      _handlers = new Map<string, Set<Handler>>();
      constructor(valid: string[]) {
        this._valid = new Set(valid);
      }
      addListener(name: string, fn: Handler) {
        if (!this._valid.has(name))
          log.violations.push(
            `${this.constructor.name}.addListener("${name}"): belgelenmiş bir olay değil`,
          );
        if (this instanceof AdvancedMarkerElement && name === "click")
          log.violations.push(
            'AdvancedMarkerElement.addListener("click") kullanımdan kalktı; gmp-click kullanın',
          );
        const set = this._handlers.get(name) ?? new Set();
        set.add(fn);
        this._handlers.set(name, set);
        return { remove: () => set.delete(fn) };
      }
      _emit(name: string, ...args: any[]) {
        for (const fn of [...(this._handlers.get(name) ?? [])]) fn(...args);
      }
    }

    class FakeMap extends Evented {
      _div: HTMLElement;
      _opts: any;
      _center: LatLng;
      _zoom: number;
      _layer: HTMLElement;
      constructor(div: HTMLElement, opts: any = {}) {
        super(MAP_EVENTS);
        this._div = div;
        this._opts = { ...opts };
        this._center = new LatLng(opts.center ?? { lat: 50, lng: 10 });
        this._zoom = opts.zoom ?? 4;
        this._layer = document.createElement("div");
        this._layer.setAttribute("data-fake-map-layer", "");
        this._layer.style.cssText =
          "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;isolation:isolate"; // gerçek Google'daki .gm-style gibi kendi yığın bağlamı: işaretçi z-index'leri dışarı taşmaz
        div.style.position ||= "relative";
        div.appendChild(this._layer);
        div.setAttribute("data-fake-map", "");
        log.maps.push(this);
        setTimeout(() => this._idle(), 30);
      }
      _size() {
        return { w: this._div.clientWidth || 800, h: this._div.clientHeight || 600 };
      }
      _idle() {
        this._place();
        this._emit("bounds_changed");
        this._emit("idle");
      }
      _place() {
        for (const m of log.markers) m._reposition();
      }
      setOptions(o: any) {
        Object.assign(this._opts, o);
      }
      setValues(o: any) {
        Object.assign(this._opts, o);
      }
      get(k: string) {
        return this._opts[k];
      }
      getDiv() {
        return this._div;
      }
      setCenter(c: any) {
        this._center = new LatLng(c);
        setTimeout(() => this._idle(), 10);
      }
      getCenter() {
        return this._center;
      }
      setZoom(z: number) {
        this._zoom = z;
        this._emit("zoom_changed");
        setTimeout(() => this._idle(), 10);
      }
      getZoom() {
        return this._zoom;
      }
      panTo(c: any) {
        this.setCenter(c);
      }
      getHeading() {
        return 0;
      }
      getTilt() {
        return 0;
      }
      getRenderingType() {
        return "VECTOR";
      }
      getMapCapabilities() {
        return { isAdvancedMarkersAvailable: true };
      }
      getProjection() {
        return {
          fromLatLngToPoint: (ll: any) => {
            const l = new LatLng(ll);
            const p = toWorld(l.lat(), l.lng());
            return new Point(p.x, p.y);
          },
          fromPointToLatLng: (p: any) => {
            const r = fromWorld(p.x, p.y);
            return new LatLng(r.lat, r.lng);
          },
        };
      }
      getBounds() {
        const { w, h } = this._size();
        const scale = 2 ** this._zoom;
        const c = toWorld(this._center.lat(), this._center.lng());
        const nw = fromWorld(c.x - w / 2 / scale, c.y - h / 2 / scale);
        const se = fromWorld(c.x + w / 2 / scale, c.y + h / 2 / scale);
        return new LatLngBounds({ lat: se.lat, lng: nw.lng }, { lat: nw.lat, lng: se.lng });
      }
      fitBounds(b: any) {
        const lit = b instanceof LatLngBounds ? b.toJSON() : b.toJSON ? b.toJSON() : b;
        log.fitBoundsCalls.push(lit);
        const { w, h } = this._size();
        const a = toWorld(lit.north, lit.west);
        const z = toWorld(lit.south, lit.east);
        const spanX = Math.max(1e-9, Math.abs(z.x - a.x));
        const spanY = Math.max(1e-9, Math.abs(z.y - a.y));
        this._zoom = Math.max(0, Math.min(20, Math.log2(Math.min(w / spanX, h / spanY) * 0.9)));
        const mid = fromWorld((a.x + z.x) / 2, (a.y + z.y) / 2);
        this._center = new LatLng(mid.lat, mid.lng);
        this._emit("zoom_changed");
        setTimeout(() => this._idle(), 10);
      }
    }

    class AdvancedMarkerElement extends Evented {
      _el: HTMLElement | null;
      _position: any;
      _map: any = null;
      gmpClickable: boolean;
      zIndex: number | null;
      title: string;
      _dom: EventTarget = new EventTarget();
      constructor(opts: any = {}) {
        super(MARKER_EVENTS);
        this._el = opts.content ?? document.createElement("div");
        this._position = opts.position;
        this.gmpClickable = !!opts.gmpClickable;
        this.zIndex = opts.zIndex ?? null;
        this.title = opts.title ?? "";
        log.markers.push(this);
        if (opts.map) this.map = opts.map;
        // Gerçek davranış: tıklama yalnızca gmpClickable ise gmp-click olarak iletilir.
        this._el!.addEventListener("click", () => {
          if (!this.gmpClickable) return;
          this._dom.dispatchEvent(new Event("gmp-click"));
          this._emit("gmp-click", {});
        });
      }
      get content() {
        return this._el;
      }
      get position() {
        return this._position;
      }
      set position(p: any) {
        this._position = p;
        this._reposition();
      }
      get map() {
        return this._map;
      }
      set map(m: any) {
        if (this._map && this._map !== m) this._el!.remove();
        this._map = m;
        if (m) {
          m._layer.appendChild(this._el!);
          this._reposition();
        } else this._el!.remove();
      }
      addEventListener(name: string, fn: any) {
        if (!this._valid.has(name))
          log.violations.push(
            `AdvancedMarkerElement.addEventListener("${name}"): belgelenmiş bir olay değil`,
          );
        this._dom.addEventListener(name, fn);
      }
      removeEventListener(name: string, fn: any) {
        this._dom.removeEventListener(name, fn);
      }
      _reposition() {
        const m = this._map;
        if (!m || !this._el || !this._position) return;
        const p = new LatLng(this._position);
        const { w, h } = m._size();
        const scale = 2 ** m._zoom;
        const c = toWorld(m._center.lat(), m._center.lng());
        const q = toWorld(p.lat(), p.lng());
        const x = w / 2 + (q.x - c.x) * scale;
        const y = h / 2 + (q.y - c.y) * scale;
        Object.assign(this._el.style, {
          position: "absolute",
          left: `${x}px`,
          top: `${y}px`,
          pointerEvents: "auto",
          zIndex: String(this.zIndex ?? 0),
        });
        this._el.setAttribute("data-lat", String(p.lat()));
        this._el.setAttribute("data-lng", String(p.lng()));
      }
    }

    class Shape extends Evented {
      _map: any = null;
      _opts: any;
      constructor(valid: string[], opts: any) {
        super(valid);
        this._opts = { ...opts };
        this._map = opts.map ?? null;
        log.shapes.push(this);
      }
      setMap(m: any) {
        this._map = m;
      }
      getMap() {
        return this._map;
      }
      setOptions(o: any) {
        Object.assign(this._opts, o);
      }
      getEditable() {
        return !!this._opts.editable;
      }
    }
    class Rectangle extends Shape {
      _bounds: LatLngBounds;
      constructor(o: any) {
        super(RECT_EVENTS, o);
        this._bounds = LatLngBounds.fromLiteral(o.bounds);
      }
      getBounds() {
        return this._bounds;
      }
      setBounds(b: any) {
        this._bounds = b instanceof LatLngBounds ? b : LatLngBounds.fromLiteral(b);
      }
    }
    class Circle extends Shape {
      _center: LatLng;
      _radius: number;
      constructor(o: any) {
        super(CIRCLE_EVENTS, o);
        this._center = new LatLng(o.center);
        this._radius = o.radius;
      }
      getCenter() {
        return this._center;
      }
      setCenter(c: any) {
        this._center = new LatLng(c);
      }
      getRadius() {
        return this._radius;
      }
      setRadius(r: number) {
        this._radius = r;
      }
      getBounds() {
        const dLat = this._radius / 111320;
        const dLng = this._radius / (111320 * Math.cos((this._center.lat() * Math.PI) / 180));
        return new LatLngBounds(
          { lat: this._center.lat() - dLat, lng: this._center.lng() - dLng },
          { lat: this._center.lat() + dLat, lng: this._center.lng() + dLng },
        );
      }
    }

    // MarkerClusterer, OverlayView'dan türetir ve `for...in` ile yalnızca NUMARALANDIRILABİLİR prototip yöntemlerini kopyalar.
    // Gerçek Google'daki gibi eski tarz yapıcı işlev kullanılır (ES sınıf yöntemleri numaralandırılamaz).
    // setMap(map) -> onAdd() -> draw(); setMap(null) -> onRemove().
    function OverlayView(this: any) {
      this._map = null;
    }
    OverlayView.prototype.setMap = function (this: any, m: any) {
      const had = this._map;
      this._map = m;
      if (m && !had)
        setTimeout(() => {
          this.onAdd?.();
          this.draw?.();
        }, 0);
      else if (!m && had) this.onRemove?.();
    };
    OverlayView.prototype.getMap = function (this: any) {
      return this._map;
    };
    OverlayView.prototype.getPanes = function () {
      return {
        overlayLayer: document.createElement("div"),
        markerLayer: document.createElement("div"),
      };
    };
    OverlayView.prototype.getProjection = function (this: any) {
      return this._map?.getProjection();
    };
    OverlayView.prototype.onAdd = function () {};
    OverlayView.prototype.draw = function () {};
    OverlayView.prototype.onRemove = function () {};

    const event = {
      addListener: (obj: any, name: string, fn: Handler) => obj.addListener(name, fn),
      addListenerOnce: (obj: any, name: string, fn: Handler) => {
        const l = obj.addListener(name, (...a: any[]) => {
          l.remove();
          fn(...a);
        });
        return l;
      },
      removeListener: (l: any) => l?.remove?.(),
      clearInstanceListeners: (obj: any) => obj?._handlers?.clear?.(),
      trigger: (obj: any, name: string, ...args: any[]) => obj._emit?.(name, ...args),
    };

    const markerNs = {
      AdvancedMarkerElement,
      PinElement: class {
        element = document.createElement("div");
      },
    };
    const maps: any = {
      Map: FakeMap,
      Rectangle,
      Circle,
      OverlayView,
      LatLng,
      LatLngBounds,
      Point,
      Size,
      event,
      marker: markerNs,
      RenderingType: { VECTOR: "VECTOR", RASTER: "RASTER", UNINITIALIZED: "UNINITIALIZED" },
      ColorScheme: { LIGHT: "LIGHT", DARK: "DARK", FOLLOW_SYSTEM: "FOLLOW_SYSTEM" },
      MapTypeId: { ROADMAP: "roadmap" },
      ControlPosition: { TOP_LEFT: 1, TOP_RIGHT: 3, BOTTOM_LEFT: 10, RIGHT_BOTTOM: 12 },
      Settings: { getInstance: () => ({}) },
      version: "fake",
      importLibrary: async (name: string) =>
        name === "marker"
          ? markerNs
          : name === "maps"
            ? maps
            : name === "core"
              ? { LatLng, LatLngBounds, Point, Size, event }
              : {},
    };
    w.google = { maps };
  });
}

export interface FakeMapsState {
  violations: string[];
  maps: unknown[];
  markers: { gmpClickable: boolean }[];
  shapes: unknown[];
  fitBoundsCalls: { south: number; west: number; north: number; east: number }[];
}
