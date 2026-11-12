import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getDb, type Db } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import { NOTIFICATION_KINDS } from "@/lib/db/schema";
import {
  claimForOs,
  listNotifications,
  markRead,
  notify,
  NOTIFICATION_URL_RE,
  OS_TOAST_MAX,
  pruneNotifications,
  renderNotification,
  toOsToasts,
  unreadCount,
} from "@/lib/notifications";
import { setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

/** Faz 4 P0: bildirim servisi (idempotent ekleme, liste, okundu, atomik OS sahiplenme, budama) ve metin üretimi. */

const NOW = 1_794_000_000_000;
const DAY = 86_400_000;
let t: TestDb;
let db: Db;

beforeEach(async () => {
  t = await createTestDb();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
});

const scanDone = (scanId: number, n = 12, at = NOW) =>
  notify(
    db,
    {
      kind: "scan.done",
      dedupeKey: `scan.done:${scanId}`,
      params: { n, region: "Londra", scanId },
      url: `/?scan=${scanId}`,
      entity: "scan",
      entityId: scanId,
    },
    { now: at },
  );

describe("notify", () => {
  it("aynı dedupeKey ikinci kez satır eklemez (idempotent) ve aynı kimliği döndürür", async () => {
    const a = await scanDone(1);
    const b = await scanDone(1, 99);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "scan.done",
      params: { n: 12, region: "Londra", scanId: 1 },
      entity: "scan",
      entityId: "1",
      createdAt: NOW,
      readAt: null,
      osClaimedAt: null,
    });
  });

  it("dış adres, şema-göreli adres, bilinmeyen tür ve uygunsuz parametreler reddedilir", async () => {
    const base = { kind: "scan.done" as const, dedupeKey: "x", url: "/scans" };
    for (const url of [
      "https://evil.example",
      "//evil.example",
      "javascript:alert(1)",
      "/a b",
      "scans",
    ])
      await expect(notify(db, { ...base, url }), url).rejects.toBeInstanceOf(ZodError);
    await expect(notify(db, { ...base, kind: "spam" as never })).rejects.toBeInstanceOf(ZodError);
    await expect(notify(db, { ...base, dedupeKey: "  " })).rejects.toBeInstanceOf(ZodError);
    await expect(notify(db, { ...base, params: { "bad key": 1 } as never })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      notify(db, { ...base, params: { nested: { a: 1 } } as never }),
    ).rejects.toBeInstanceOf(ZodError);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    await expect(notify(db, { ...base, params: many })).rejects.toBeInstanceOf(ZodError);
    expect(await db.select().from(notifications)).toEqual([]);
    expect(NOTIFICATION_URL_RE.test("/?lifecycle=opened&scan=12")).toBe(true);
  });

  it("varsayılanlar: parametre {} ve varlık boş; şimdiki zaman kullanılır", async () => {
    const before = Date.now();
    const r = await notify(db, { kind: "scan.paused", dedupeKey: "p:1", url: "/scans" });
    const row = (await db.select().from(notifications))[0]!;
    expect(row.id).toBe(r.id);
    expect(row.params).toEqual({});
    expect(row.entity).toBeNull();
    expect(row.entityId).toBeNull();
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
  });
});

describe("liste, okunmamış sayısı, okundu işareti", () => {
  it("yeniden eskiye sayfalar; okundu işareti yalnızca okunmamışlara dokunur", async () => {
    for (let i = 1; i <= 5; i++) await scanDone(i, i, NOW + i);
    const page1 = await listNotifications(db, { limit: 2 });
    expect(page1.map((r) => r.params.scanId)).toEqual([5, 4]);
    const page2 = await listNotifications(db, { limit: 2, before: page1[1]!.id });
    expect(page2.map((r) => r.params.scanId)).toEqual([3, 2]);
    expect((await listNotifications(db, { limit: 0 })).length).toBe(1); // en az 1
    expect(await unreadCount(db)).toBe(5);

    expect(
      await markRead(db, { ids: [page1[0]!.id, page1[0]!.id, -1, 1.5] }, { now: NOW + 100 }),
    ).toBe(1);
    expect(await markRead(db, { ids: [page1[0]!.id] }, { now: NOW + 200 })).toBe(0); // zaten okunmuş
    expect(await markRead(db, { ids: [] })).toBe(0);
    expect(await unreadCount(db)).toBe(4);
    expect((await listNotifications(db, { unreadOnly: true })).length).toBe(4);
    const read = (await listNotifications(db)).find((r) => r.id === page1[0]!.id)!;
    expect(read.readAt).toBe(NOW + 100);

    await expect(
      markRead(db, { ids: Array.from({ length: 201 }, (_, i) => i + 1) }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await markRead(db, { all: true }, { now: NOW + 300 })).toBe(4);
    expect(await unreadCount(db)).toBe(0);
  });
});

describe("claimForOs (atomik, en çok bir kez)", () => {
  it("iki eşzamanlı sahiplenme ayrık kümeler alır; sahiplenilen tekrar dönmez; 24 saatten eskiler ve okunmuşlar gösterilmez", async () => {
    for (let i = 1; i <= 8; i++) await scanDone(i, i, NOW - 1000 + i);
    await scanDone(100, 1, NOW - 2 * DAY); // eski
    const readOne = await scanDone(101, 1, NOW - 10);
    await markRead(db, { ids: [readOne.id] }, { now: NOW });

    const [a, b] = await Promise.all([
      claimForOs(db, { now: NOW, limit: 5 }),
      claimForOs(db, { now: NOW, limit: 5 }),
    ]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(8);
    expect([...a, ...b].every((r) => r.osClaimedAt === NOW)).toBe(true);
    expect(await claimForOs(db, { now: NOW + 1 })).toEqual([]);
    // eski olan hâlâ zilde görünür, ama OS'a hiç gitmez
    expect((await listNotifications(db, { limit: 100 })).length).toBe(10);
  });

  it("notifications.os kapalıysa hiçbir şey sahiplenilmez", async () => {
    await scanDone(1);
    await setSetting(db, "notifications.os", false);
    expect(await claimForOs(db, { now: NOW + 1 })).toEqual([]);
    await setSetting(db, "notifications.os", true);
    expect((await claimForOs(db, { now: NOW + 1 })).map((r) => r.params.scanId)).toEqual([1]);
  });
});

describe("pruneNotifications", () => {
  it("90 günden eski okunmuşları ve 180 günden eski hepsini siler; yenilere dokunmaz", async () => {
    const oldRead = await scanDone(1, 1, NOW - 100 * DAY);
    await markRead(db, { ids: [oldRead.id] }, { now: NOW - 95 * DAY });
    const recentRead = await scanDone(2, 1, NOW - 10 * DAY);
    await markRead(db, { ids: [recentRead.id] }, { now: NOW - 5 * DAY });
    await scanDone(3, 1, NOW - 200 * DAY); // okunmamış ama çok eski
    await scanDone(4, 1, NOW - 100 * DAY); // okunmamış, 180 günden yeni
    expect(await pruneNotifications(db, { now: NOW })).toBe(2);
    expect((await listNotifications(db)).map((r) => r.params.scanId).sort()).toEqual([2, 4]);
    expect(await pruneNotifications(db, { now: NOW })).toBe(0);
    // varsayılan zaman: bugünün kayıtları silinmez
    expect(await pruneNotifications(db)).toBe(0);
  });
});

describe("renderNotification / toOsToasts", () => {
  const r = (kind: (typeof NOTIFICATION_KINDS)[number], params = {}) => ({
    tr: renderNotification({ kind, params }, "tr"),
    en: renderNotification({ kind, params }, "en"),
  });

  it("her tür iki dilde de dolu, yer tutucusu kalmamış metin üretir", () => {
    for (const kind of NOTIFICATION_KINDS)
      for (const params of [
        {},
        { n: 3, region: "Berlin", code: "NEEDS_ACK" },
        { code: "WHATEVER" },
      ]) {
        const out = r(kind, params);
        for (const v of [out.tr.title, out.tr.body, out.en.title, out.en.body]) {
          expect(v.trim().length, `${kind} ${JSON.stringify(params)}`).toBeGreaterThan(0);
          expect(v, kind).not.toMatch(/\{[a-zA-Z]+\}|notif\./);
        }
      }
  });

  it("sayılar dile göre biçimlenir; bölge adı ve kodlar doğru metni seçer", () => {
    expect(r("scan.done", { n: 1846, region: "Londra" }).tr).toEqual({
      title: "1.846 yeni işletme bulundu",
      body: "Londra taraması tamamlandı.",
    });
    expect(r("scan.done", { n: 1846 }).en.title).toBe("1,846 new businesses found");
    expect(r("scan.done", { n: "x" }).tr.title).toBe("0 yeni işletme bulundu");
    expect(r("place.opened", { n: 2, region: " " }).tr.body).toBe(
      "Yakında açılacak olarak izlenen işletmeler artık faaliyette.",
    );
    expect(r("place.opened", { n: 2, region: "Köln" }).en.body).toContain("Köln:");
    expect(r("scan.failed", { region: "Paris" }).tr.body).toContain("Paris");
    expect(r("scan.paused", { n: 2 }).tr.body).toContain("2 tarama");
    expect(r("schedule.skipped", { code: "BUDGET_BLOCKED" }).tr.body).toContain("bütçe");
    expect(r("schedule.skipped", { code: "nope" }).en.body).toBe(
      "The scan could not run this time; it will be retried.",
    );
    expect(r("background.skipped", { code: "PLACES_KEY_MISSING" }).en.body).toContain("Places");
    expect(r("background.skipped", {}).tr.body).toContain("Arka plan");
  });

  it(`en çok ${OS_TOAST_MAX} bildirim tek tek, fazlası tek özet`, () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      kind: "scan.done" as const,
      params: { n: i + 1 },
      url: `/?scan=${i + 1}`,
    }));
    const few = toOsToasts(rows.slice(0, 3), "tr");
    expect(few.map((x) => [x.ids, x.url])).toEqual([
      [[1], "/?scan=1"],
      [[2], "/?scan=2"],
      [[3], "/?scan=3"],
    ]);
    const many = toOsToasts(rows, "en");
    expect(many).toEqual([
      {
        title: "5 new notifications",
        body: "Open the notifications in the app for details.",
        url: "/dashboard",
        ids: [1, 2, 3, 4, 5],
      },
    ]);
    expect(toOsToasts([], "tr")).toEqual([]);
  });
});
