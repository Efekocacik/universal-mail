import { describe, expect, it, vi } from "vitest";
import {
  alertSignature,
  buildToasts,
  freshAlerts,
  NotificationPoller,
  OS_TOAST_MAX,
  parseClaimItems,
  type OsToast,
  type PollerDeps,
} from "../electron/notify";

/** Faz 4 madde 4 + TB-4: işletim sistemi bildirimi yoklayıcısı (sahte ağ, zaman ve gösterim kapılarıyla). */
describe("electron/notify: saf işlevler", () => {
  it("parseClaimItems bozuk satırları atar, yolu doğrular, metni kısaltır", () => {
    const items = parseClaimItems({
      items: [
        { id: 1, title: "Tarama bitti", body: "12 yeni", url: "/?scan=12" },
        { id: 2, title: "Dış", body: "x", url: "https://evil.example/" },
        { id: "3", title: "kimlik metin" },
        { id: 4, title: "   " },
        { id: 5, title: "T".repeat(500), body: "B".repeat(900), url: "//evil" },
        null,
      ],
    });
    expect(items.map((i) => i.id)).toEqual([1, 2, 5]);
    expect(items[0]!.url).toBe("/?scan=12");
    expect(items[1]!.url).toBe("/");
    expect(items[2]!.url).toBe("/");
    expect(items[2]!.title).toHaveLength(120);
    expect(items[2]!.body).toHaveLength(300);
    expect(parseClaimItems(null)).toEqual([]);
    expect(parseClaimItems({ items: "x" })).toEqual([]);
  });

  it("buildToasts: en çok üç bildirim; fazlası tek özet (gösterge paneline)", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i, title: `t${i}`, body: "", url: "/campaigns" }));
    const summary = (n: number) => ({ title: `${n} yeni bildirim`, body: "özet" });
    expect(buildToasts([], summary)).toEqual([]);
    expect(buildToasts(mk(OS_TOAST_MAX), summary)).toHaveLength(3);
    expect(buildToasts(mk(5), summary)).toEqual([
      { title: "5 yeni bildirim", body: "özet", url: "/dashboard" },
    ]);
  });

  it("teslimat uyarısı imzası ve yalnızca YENİ uyarıların seçilmesi", () => {
    expect(alertSignature({ kind: "delivery_unhealthy", code: "queue_deep" })).toBe(
      "delivery_unhealthy:queue_deep",
    );
    expect(alertSignature({ kind: "proof_expired" })).toBe("proof_expired");
    expect(alertSignature({})).toBeNull();
    const a = freshAlerts(new Set(), { alerts: [{ kind: "proof_expired" }, { x: 1 }] });
    expect(a.fresh).toEqual(["proof_expired"]);
    const b = freshAlerts(a.current, { alerts: [{ kind: "proof_expired" }] });
    expect(b.fresh).toEqual([]);
    const c = freshAlerts(b.current, { alerts: [] });
    expect(c.current.size).toBe(0);
    // Kaybolup yeniden beliren uyarı yine bildirilir.
    expect(freshAlerts(c.current, { alerts: [{ kind: "proof_expired" }] }).fresh).toEqual([
      "proof_expired",
    ]);
    expect(freshAlerts(new Set(), null).fresh).toEqual([]);
  });
});

type Route = (init?: RequestInit) => Response | Promise<Response>;
function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(
  routes: Record<string, Route>,
  opts: { alertEveryMs?: number; alertStore?: PollerDeps["alertStore"] } = {},
) {
  const shown: OsToast[] = [];
  const logs: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let now = 1_000_000;
  const deps: PollerDeps = {
    origin: () => "http://127.0.0.1:4310",
    fetch: async (url, init) => {
      calls.push({ url, init });
      const path = url.replace("http://127.0.0.1:4310", "");
      const r = routes[path];
      if (!r) return jsonRes({ error: "yok" }, 404);
      return r(init);
    },
    show: (t) => shown.push(t),
    text: (key, n) => ({ title: `${key}:${n ?? ""}`, body: key }),
    log: (m) => logs.push(m),
    now: () => now,
    alertStore: opts.alertStore,
  };
  const poller = new NotificationPoller(deps, {
    intervalMs: 1000,
    alertEveryMs: opts.alertEveryMs,
  });
  return {
    poller,
    shown,
    logs,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("electron/notify: NotificationPoller", () => {
  it("os-claim'i Origin başlığıyla POST eder ve gelenleri gösterir", async () => {
    const s = setup({
      "/api/notifications/os-claim": () =>
        jsonRes({ items: [{ id: 7, title: "Yanıt geldi", body: "Kafe X", url: "/campaigns/3" }] }),
      "/api/config": () => jsonRes({ notificationsOs: true }),
      "/api/compliance/delivery-alerts": () => jsonRes({ alerts: [] }),
    });
    await s.poller.poll();
    expect(s.shown).toEqual([{ title: "Yanıt geldi", body: "Kafe X", url: "/campaigns/3" }]);
    const claim = s.calls.find((c) => c.url.endsWith("/os-claim"))!;
    expect(claim.init?.method).toBe("POST");
    expect((claim.init?.headers as Record<string, string>).Origin).toBe("http://127.0.0.1:4310");
  });

  it("uç yoksa (404) sessizce sürer ve yalnızca bir kez günlüğe yazar", async () => {
    const s = setup({});
    expect(await s.poller.claimOnce()).toBe(0);
    expect(await s.poller.claimOnce()).toBe(0);
    expect(s.logs.filter((l) => l.includes("os-claim ucu yok"))).toHaveLength(1);
    expect(s.shown).toEqual([]);
  });

  it("sunucu hatası, bozuk JSON ve ağ hatası bildirim göstermeden günlüğe düşer", async () => {
    const s1 = setup({ "/api/notifications/os-claim": () => jsonRes({}, 500) });
    expect(await s1.poller.claimOnce()).toBe(0);
    expect(s1.logs).toContain("os-claim HTTP 500");
    const s2 = setup({
      "/api/notifications/os-claim": () => new Response("<html>", { status: 200 }),
    });
    expect(await s2.poller.claimOnce()).toBe(0);
    const s3 = setup({
      "/api/notifications/os-claim": () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await s3.poller.claimOnce()).toBe(0);
    expect(s3.logs.some((l) => l.includes("fetch failed"))).toBe(true);
  });

  it("teslimat uyarısı: yeni uyarıda tek bildirim (/compliance), tekrar etmez; aralığa uyar", async () => {
    let alerts: unknown[] = [{ kind: "delivery_stale", checkedAt: null }];
    const s = setup(
      {
        "/api/notifications/os-claim": () => jsonRes({ items: [] }),
        "/api/config": () => jsonRes({ notificationsOs: true }),
        "/api/compliance/delivery-alerts": () => jsonRes({ alerts }),
      },
      { alertEveryMs: 60_000 },
    );
    await s.poller.poll();
    expect(s.shown).toEqual([
      { title: "deliveryAlert:", body: "deliveryAlert", url: "/compliance" },
    ]);
    s.advance(1000);
    alerts = [{ kind: "delivery_stale", checkedAt: null }, { kind: "proof_expired" }];
    await s.poller.poll(); // aralık dolmadı: uyarılar okunmaz
    expect(s.shown).toHaveLength(1);
    s.advance(60_000);
    await s.poller.poll();
    expect(s.shown).toHaveLength(2);
    s.advance(60_000);
    await s.poller.poll(); // aynı küme: yeni bildirim yok
    expect(s.shown).toHaveLength(2);
  });

  it("teslimat uyarısı: bildirilen imzalar kalıcıdır; yeniden başlatmada süren uyarı tekrar bildirilmez", async () => {
    let stored: string[] = [];
    const store = { load: () => stored, save: (s: string[]) => void (stored = s) };
    let alerts: unknown[] = [{ kind: "proof_expiring" }];
    const routes = {
      "/api/config": () => jsonRes({ notificationsOs: true }),
      "/api/compliance/delivery-alerts": () => jsonRes({ alerts }),
    };
    const first = setup(routes, { alertStore: store });
    expect(await first.poller.checkDeliveryAlerts()).toBe(true);
    expect(stored).toEqual(["proof_expiring"]);
    // Uygulama yeniden açıldı: aynı uyarı sürüyor → bildirim yok, /api/settings hiç çağrılmaz.
    const second = setup(routes, { alertStore: store });
    expect(await second.poller.checkDeliveryAlerts()).toBe(false);
    expect(second.shown).toEqual([]);
    expect(second.calls.some((c) => c.url.endsWith("/api/settings"))).toBe(false);
    // Uyarı kapandı (kayıt boşalır), sonra yeniden belirdi → bir kez daha bildirilir.
    alerts = [];
    expect(await second.poller.checkDeliveryAlerts()).toBe(false);
    expect(stored).toEqual([]);
    alerts = [{ kind: "proof_expiring" }];
    const third = setup(routes, { alertStore: store });
    expect(await third.poller.checkDeliveryAlerts()).toBe(true);
  });

  it("bozuk/okunamayan imza deposu boş kabul edilir; yazma hatası günlüğe düşer", async () => {
    const routes = {
      "/api/config": () => jsonRes({ notificationsOs: true }),
      "/api/compliance/delivery-alerts": () => jsonRes({ alerts: [{ kind: "delivery_stale" }] }),
    };
    const s = setup(routes, {
      alertStore: {
        load: () => {
          throw new Error("bozuk");
        },
        save: () => {
          throw new Error("disk dolu");
        },
      },
    });
    expect(await s.poller.checkDeliveryAlerts()).toBe(true);
    expect(s.logs.some((l) => l.includes("okunamadı"))).toBe(true);
    expect(s.logs.some((l) => l.includes("disk dolu"))).toBe(true);
    const s2 = setup(routes, {
      alertStore: {
        load: () => ["delivery_stale", 42 as unknown as string, "x".repeat(500)],
        save: () => undefined,
      },
    });
    expect(await s2.poller.checkDeliveryAlerts()).toBe(false);
  });

  it("notifications.os kapalıysa teslimat uyarısı gösterilmez", async () => {
    const s = setup({
      "/api/notifications/os-claim": () => jsonRes({ items: [] }),
      "/api/config": () => jsonRes({ notificationsOs: false }),
      "/api/compliance/delivery-alerts": () => jsonRes({ alerts: [{ kind: "proof_expired" }] }),
    });
    expect(await s.poller.checkDeliveryAlerts()).toBe(false);
    expect(s.calls.some((c) => c.url.endsWith("/delivery-alerts"))).toBe(false);
  });

  it("ayar/uyarı uçları hatalıysa sessizce false", async () => {
    expect(await setup({}).poller.checkDeliveryAlerts()).toBe(false);
    const s = setup({
      "/api/config": () => new Response("x", { status: 200 }),
    });
    expect(await s.poller.checkDeliveryAlerts()).toBe(false);
    const s2 = setup({
      "/api/config": () => jsonRes({}),
      "/api/compliance/delivery-alerts": () => new Response("x", { status: 200 }),
    });
    expect(await s2.poller.checkDeliveryAlerts()).toBe(false);
  });

  it("süren yoklama sırasında dürtme bir kez daha yoklatır (kayıp yok, paralel yok)", async () => {
    let release!: () => void;
    let claims = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const s = setup(
      {
        "/api/notifications/os-claim": async () => {
          claims++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (claims === 1) await new Promise<void>((r) => (release = r));
          inFlight--;
          return jsonRes({ items: [] });
        },
      },
      { alertEveryMs: Number.MAX_SAFE_INTEGER },
    );
    const first = s.poller.poll();
    await vi.waitFor(() => expect(claims).toBe(1));
    s.poller.nudge();
    s.poller.nudge();
    release();
    await first;
    expect(claims).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it("köken yoksa istek atılmaz; start/stop zamanlayıcıyı yönetir", async () => {
    const s = setup({});
    const p = new NotificationPoller(
      { ...({} as PollerDeps), origin: () => "", log: () => undefined, now: () => 0 } as PollerDeps,
      { intervalMs: 10 },
    );
    expect(await p.claimOnce()).toBe(0);
    vi.useFakeTimers();
    try {
      s.poller.start();
      s.poller.start(); // ikinci start etkisiz
      s.poller.stop();
      s.poller.stop();
    } finally {
      vi.useRealTimers();
    }
    expect(s.poller.intervalMs).toBe(1000);
  });
});
