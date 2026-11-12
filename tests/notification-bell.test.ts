import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_PATH_RE, joinAppPath, safeAppPath } from "@/lib/client/app-path";
import {
  badgeText,
  BELL_LIMIT,
  fetchBell,
  markBellRead,
  parseBellList,
  unreadIncreased,
} from "@/lib/client/notification-bell";
import { NOTIFICATION_URL_RE } from "@/lib/notifications/service";

/** Faz 4: bildirim zili istemci mantığı ve uygulama içi yol doğrulaması (DOM'suz). */
describe("uygulama içi yol doğrulaması", () => {
  it("istemci kopyası sunucudaki NOTIFICATION_URL_RE ile birebir aynıdır", () => {
    expect(APP_PATH_RE.source).toBe(NOTIFICATION_URL_RE.source);
    expect(APP_PATH_RE.flags).toBe(NOTIFICATION_URL_RE.flags);
  });

  it.each([
    "https://evil.example/",
    "//evil.example",
    "javascript:alert(1)",
    "/a/../b",
    "/./x",
    "/a//b",
    "/a%2fb",
    "/a%5Cb",
    "relative",
    "",
  ])("reddeder: %s", (bad) => {
    expect(safeAppPath(bad)).toBe("/");
  });

  it.each(["/", "/?scan=12", "/campaigns/3", "/compliance?tab=suppression", "/leads/9"])(
    "kabul eder: %s",
    (ok) => {
      expect(safeAppPath(ok)).toBe(ok);
    },
  );

  it("metin olmayan ve çok uzun değerler varsayılana düşer", () => {
    expect(safeAppPath(42)).toBe("/");
    expect(safeAppPath(null, "/dashboard")).toBe("/dashboard");
    expect(safeAppPath(`/${"a".repeat(600)}`)).toBe("/");
  });

  it("joinAppPath sonucu her zaman aynı kökende kalır", () => {
    const o = "http://127.0.0.1:4310";
    expect(joinAppPath(o, "/campaigns/3")).toBe(`${o}/campaigns/3`);
    expect(joinAppPath(o, "https://evil.example/x")).toBe(`${o}/`);
    expect(joinAppPath(o, "//evil.example")).toBe(`${o}/`);
    expect(joinAppPath("bozuk köken", "/x")).toBe("bozuk köken/");
  });
});

describe("zil: saf işlevler", () => {
  it("rozet metni", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(-2)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
  });

  it("parseBellList savunmacıdır: kimliksiz satır atılır, dış bağlantı '/' olur, sınır uygulanır", () => {
    const list = parseBellList({
      items: [
        {
          id: 1,
          kind: "scan_done",
          title: "T",
          body: "B",
          url: "/?scan=1",
          createdAt: 5,
          readAt: null,
        },
        { id: "x", title: "kimlik yok" },
        { id: 2, title: "dış", url: "https://evil.example", readAt: 9 },
        null,
      ],
    });
    expect(list.items.map((i) => i.id)).toEqual([1, 2]);
    expect(list.items[1]).toMatchObject({ url: "/", kind: "", body: "", createdAt: 0, readAt: 9 });
    // `unread` yoksa okunmamış satırlardan sayılır
    expect(list.unread).toBe(1);
    expect(parseBellList({ items: [], unread: -3 }).unread).toBe(0);
    expect(parseBellList(null)).toEqual({ items: [], unread: 0 });
    const many = parseBellList({
      items: Array.from({ length: 60 }, (_, i) => ({ id: i, title: "t" })),
      unread: 60,
    });
    expect(many.items).toHaveLength(BELL_LIMIT);
    expect(many.unread).toBe(60);
  });

  it("okunmamış artışı yalnızca önceki değer biliniyorsa sayılır", () => {
    expect(unreadIncreased(undefined, 3)).toBe(false);
    expect(unreadIncreased(2, 3)).toBe(true);
    expect(unreadIncreased(3, 3)).toBe(false);
    expect(unreadIncreased(3, undefined)).toBe(false);
  });
});

describe("zil: ağ", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (status: number, data: unknown) => {
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(data), { status }),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("fetchBell: 404 → null (uç henüz yok); başarı → ayrıştırılmış liste; diğer hatalar fırlatılır", async () => {
    stub(404, { error: "yok" });
    expect(await fetchBell()).toBeNull();
    const f = stub(200, { items: [{ id: 3, title: "x", url: "/" }], unread: 1 });
    expect(await fetchBell(5)).toEqual({
      items: [{ id: 3, kind: "", title: "x", body: "", url: "/", createdAt: 0, readAt: null }],
      unread: 1,
    });
    expect(f.mock.calls[0]![0]).toBe("/api/notifications?limit=5");
    stub(500, { error: "x", code: "INTERNAL" });
    await expect(fetchBell()).rejects.toMatchObject({ status: 500 });
  });

  it("markBellRead: kimlikler en çok 200; tümü için {all:true}", async () => {
    const f = stub(200, { updated: 1 });
    await markBellRead({ ids: Array.from({ length: 250 }, (_, i) => i + 1) });
    const body1 = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body1.ids).toHaveLength(200);
    await markBellRead({ all: true });
    const [url, init] = f.mock.calls[1]!;
    expect(url).toBe("/api/notifications/read");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ all: true });
  });
});
