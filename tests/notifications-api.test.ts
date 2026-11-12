import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as listRoute from "@/app/api/notifications/route";
import * as readRoute from "@/app/api/notifications/read/route";
import * as claimRoute from "@/app/api/notifications/os-claim/route";
import * as statusRoute from "@/app/api/status/route";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog } from "@/lib/db/schema";
import { notify } from "@/lib/notifications";
import { safeAppPath } from "@/lib/client/app-path";
import { BELL_LIMIT, fetchBell, markBellRead, type BellItem } from "@/lib/client/notification-bell";
import type { AppStatus } from "@/lib/client/types";
import type { NotificationItem } from "@/lib/scan/notification-view";
import { setSetting } from "@/lib/settings";
import { middleware } from "@/middleware";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function seed(n: number) {
  const now = Date.now();
  for (let i = 1; i <= n; i++)
    await notify(
      db,
      {
        kind: "scan.done",
        dedupeKey: `scan.done:${i}`,
        params: { n: i * 3, region: "London", scanId: i },
        url: `/?scan=${i}&lifecycle=new`,
        entity: "scan",
        entityId: i,
      },
      { now: now - (n - i) * 1000 },
    );
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
});

describe("GET /api/notifications", () => {
  it("yeniden eskiye, dilde metin, okunmamış sayısı; sayfalama", async () => {
    await seed(3);
    const r = await json(await listRoute.GET(req("GET", "/api/notifications?limit=2"), undefined));
    expect(r.unread).toBe(3);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      kind: "scan.done",
      title: "9 yeni işletme bulundu",
      body: "London taraması tamamlandı.",
      url: "/?scan=3&lifecycle=new",
      readAt: null,
    });
    expect(Object.keys(r.items[0]).sort()).toEqual(
      ["body", "createdAt", "id", "kind", "readAt", "title", "url"].sort(),
    );
    const next = await json(
      await listRoute.GET(
        req("GET", `/api/notifications?limit=2&before=${r.items[1].id}`),
        undefined,
      ),
    );
    expect(next.items.map((i: { title: string }) => i.title)).toEqual(["3 yeni işletme bulundu"]);

    await setSetting(db, "ui.language", "en");
    const en = await json(await listRoute.GET(req("GET", "/api/notifications?limit=1"), undefined));
    expect(en.items[0].title).toBe("9 new businesses found");
  });

  it("geçersiz sorgu 400 (limit 0, 51, bilinmeyen alan)", async () => {
    for (const q of ["limit=0", "limit=51", "limit=x", "foo=1"])
      expect((await listRoute.GET(req("GET", `/api/notifications?${q}`), undefined)).status).toBe(
        400,
      );
  });
});

describe("POST /api/notifications/read", () => {
  it("kimlikle ve tümüyle işaretler; idempotent; denetim kaydı", async () => {
    await seed(3);
    const list = await json(await listRoute.GET(req("GET", "/api/notifications"), undefined));
    const id = list.items[0].id as number;
    const r1 = await json(
      await readRoute.POST(req("POST", "/api/notifications/read", { ids: [id] }), undefined),
    );
    expect(r1).toEqual({ updated: 1, unread: 2 });
    const again = await json(
      await readRoute.POST(req("POST", "/api/notifications/read", { ids: [id] }), undefined),
    );
    expect(again).toEqual({ updated: 0, unread: 2 });
    const all = await json(
      await readRoute.POST(req("POST", "/api/notifications/read", { all: true }), undefined),
    );
    expect(all).toEqual({ updated: 2, unread: 0 });
    const audits = (await db.select().from(auditLog)).filter(
      (a) => a.action === "notifications.read",
    );
    expect(audits).toHaveLength(2);
    const status = await json(await statusRoute.GET(req("GET", "/api/status"), undefined));
    expect(status.unreadNotifications).toBe(0);
  });

  it("katı gövde: boş, karışık, 200'den fazla, all:false → 400", async () => {
    for (const b of [
      {},
      { ids: [] },
      { ids: [1], all: true },
      { all: false },
      { ids: Array.from({ length: 201 }, (_, i) => i + 1) },
      { ids: [1], x: 1 },
    ])
      expect(
        (await readRoute.POST(req("POST", "/api/notifications/read", b), undefined)).status,
      ).toBe(400);
  });

  it("çapraz kaynaklı istek middleware'de reddedilir", () => {
    const mk = (headers: Record<string, string>) =>
      new NextRequest(`${ORIGIN}/api/notifications/read`, { method: "POST", headers });
    expect(middleware(mk({ host: "127.0.0.1:3000", origin: "http://evil.example" })).status).toBe(
      403,
    );
    expect(middleware(mk({ host: "127.0.0.1:3000" })).status).toBe(403);
  });
});

describe("POST /api/notifications/os-claim", () => {
  it("sözleşme (Paket D): Electron ana süreci Origin göndermek ZORUNDA; Origin yoksa 403", () => {
    const mk = (headers: Record<string, string>) =>
      new NextRequest(`${ORIGIN}/api/notifications/os-claim`, { method: "POST", headers });
    // Node/Electron-main fetch'i Origin eklemez: middleware reddeder.
    expect(middleware(mk({ host: "127.0.0.1:3000" })).status).toBe(403);
    // Doğru kullanım: Origin: http://127.0.0.1:<port> (Host ile aynı) + Content-Type.
    expect(
      middleware(
        mk({
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        }),
      ).status,
    ).toBe(200);
  });

  it("en çok 5, bir kez; ayar kapalıysa boş", async () => {
    await seed(7);
    const a = await json(
      await claimRoute.POST(req("POST", "/api/notifications/os-claim"), undefined),
    );
    expect(a.items).toHaveLength(5);
    expect(a.items[0].title).toMatch(/yeni işletme bulundu/);
    const b = await json(
      await claimRoute.POST(req("POST", "/api/notifications/os-claim"), undefined),
    );
    expect(b.items).toHaveLength(2);
    expect(new Set([...a.items, ...b.items].map((i: { id: number }) => i.id)).size).toBe(7);
    expect(
      (await json(await claimRoute.POST(req("POST", "/api/notifications/os-claim"), undefined)))
        .items,
    ).toHaveLength(0);

    await notify(db, { kind: "scan.done", dedupeKey: "x", params: { n: 1 }, url: "/" });
    await setSetting(db, "notifications.os", false);
    expect(
      (await json(await claimRoute.POST(req("POST", "/api/notifications/os-claim"), undefined)))
        .items,
    ).toHaveLength(0);
  });
});

describe("istemci yol denetimi", () => {
  it("yalnızca uygulama içi yollar (zil ve OS bildirimi aynı kuralı kullanır)", () => {
    expect(safeAppPath("/?scan=12&lifecycle=new")).toBe("/?scan=12&lifecycle=new");
    expect(safeAppPath("/scans")).toBe("/scans");
    for (const bad of ["https://evil", "//evil", "javascript:alert(1)", "/a\\b", ""])
      expect(safeAppPath(bad)).toBe("/");
  });
});

/**
 * Entegrasyon: Paket D'nin zili (src/lib/client/notification-bell.ts) Paket B'nin GERÇEK uçlarıyla konuşur. İstemcinin
 * `fetch`'i yerel uç işleyicilerine yönlendirilir; böylece istek biçimi (sorgu, gövde) ve yanıt biçimi birlikte sınanır.
 */
describe("sözleşme: zil istemcisi ↔ bildirim uçları", () => {
  // Tür düzeyi: sunucunun satır biçimi zilin beklediği biçime birebir atanabilir (alan eklenir/silinirse derleme kırılır).
  const toBell = (i: NotificationItem): BellItem => i;
  const toServer = (i: BellItem): NotificationItem => i;
  void toBell;
  void toServer;
  const _status: Pick<AppStatus, "unreadNotifications"> = { unreadNotifications: 0 };
  void _status;

  const requests: { method: string; url: string; body: unknown }[] = [];
  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? init.body : undefined;
      requests.push({ method, url, body: body ? JSON.parse(body) : undefined });
      const r = req(method, url, body ? JSON.parse(body) : undefined);
      if (url.startsWith("/api/notifications/read")) return readRoute.POST(r, undefined);
      if (url.startsWith("/api/notifications")) return listRoute.GET(r, undefined);
      if (url.startsWith("/api/status")) return statusRoute.GET(r, undefined);
      return new Response("{}", { status: 404 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("liste, okunmamış sayısı ve okundu işaretleme uçtan uca uyuşur", async () => {
    await seed(3);
    const bell = await fetchBell();
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: `/api/notifications?limit=${BELL_LIMIT}`,
    });
    expect(bell!.unread).toBe(3);
    expect(bell!.items).toHaveLength(3);
    // Ayrıştırma sunucu satırını DEĞİŞTİRMEZ (alan adları ve bağlantı birebir).
    const raw = await json(
      await listRoute.GET(req("GET", `/api/notifications?limit=${BELL_LIMIT}`), undefined),
    );
    expect(bell!.items).toEqual(raw.items);
    for (const i of bell!.items)
      expect(Object.keys(i).sort()).toEqual([
        "body",
        "createdAt",
        "id",
        "kind",
        "readAt",
        "title",
        "url",
      ]);

    await markBellRead({ ids: [bell!.items[0]!.id] });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/notifications/read",
      body: { ids: [bell!.items[0]!.id] },
    });
    const status = (await json(
      await statusRoute.GET(req("GET", "/api/status"), undefined),
    )) as AppStatus;
    expect(status.unreadNotifications).toBe(2);
    expect((await fetchBell())!.unread).toBe(2);

    await markBellRead({ all: true });
    expect(requests.at(-1)!.body).toEqual({ all: true });
    const after = await fetchBell();
    expect(after!.unread).toBe(0);
    expect(after!.items.every((i) => i.readAt !== null)).toBe(true);
  });
});
