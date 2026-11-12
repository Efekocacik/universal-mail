import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as claimRoute from "@/app/api/notifications/os-claim/route";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { notify } from "@/lib/notifications";
import { nudgeOsNotifications } from "@/lib/scan/scan-notifications";
import { setSetting } from "@/lib/settings";
import {
  createWakeSignal,
  FOCUS_WAKE_MIN_MS,
  isNotifyMessage,
  NotificationPoller,
  type OsToast,
} from "../electron/notify";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 4 entegrasyonu: işçi ↔ Electron ana süreci IPC dikişleri (gerçek Electron olmadan).
 *  - işçinin gönderdiği `{type:'notify'}` ana sürecin tanıdığı biçimdir;
 *  - uyandırma sinyali: uyku/kilit her zaman, odak sınırlı;
 *  - yoklayıcı GERÇEK `POST /api/notifications/os-claim` ucuna bağlıyken düzenli yoklama + dürtme fırtınası aynı
 *    bildirimi bir kez gösterir; `notifications.os` kapalıyken hiç göstermez.
 */

describe("işçi → ana süreç: {type:'notify'}", () => {
  it("nudgeOsNotifications'ın gönderdiği ileti ana süreçte bildirim dürtmesi sayılır", () => {
    const sent: unknown[] = [];
    const send = Object.getOwnPropertyDescriptor(process, "send");
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    Object.defineProperty(process, "send", {
      configurable: true,
      writable: true,
      value: (m: unknown) => {
        sent.push(m);
        return true;
      },
    });
    Object.defineProperty(process, "connected", { configurable: true, value: true });
    try {
      nudgeOsNotifications();
    } finally {
      if (send) Object.defineProperty(process, "send", send);
      else delete (process as { send?: unknown }).send;
      if (connected) Object.defineProperty(process, "connected", connected);
      else delete (process as { connected?: unknown }).connected;
    }
    expect(sent).toHaveLength(1);
    expect(isNotifyMessage(sent[0])).toBe(true);
    for (const other of [{ type: "wake" }, "notify", null, undefined, 3])
      expect(isNotifyMessage(other)).toBe(false);
  });
});

describe("ana süreç → işçi: uyandırma sinyali", () => {
  function setup(connected = true) {
    let now = 1_000_000;
    const sends: number[] = [];
    let nudges = 0;
    const wake = createWakeSignal({
      sendWake: () => {
        if (!connected) return false;
        sends.push(now);
        return true;
      },
      nudge: () => void nudges++,
      now: () => now,
    });
    return {
      wake,
      sends,
      nudges: () => nudges,
      advance: (ms: number) => void (now += ms),
    };
  }

  it("uyku sonrası ve kilit açılınca her zaman uyandırır ve bildirimleri yoklatır", () => {
    const s = setup();
    expect(s.wake("resume")).toBe(true);
    expect(s.wake("unlock")).toBe(true);
    expect(s.sends).toHaveLength(2);
    expect(s.nudges()).toBe(2);
  });

  it("pencere odağı dakikada en çok bir uyandırma gönderir ve bildirim yoklatmaz", () => {
    const s = setup();
    expect(s.wake("focus")).toBe(true);
    expect(s.wake("focus")).toBe(false);
    s.advance(FOCUS_WAKE_MIN_MS - 1);
    expect(s.wake("focus")).toBe(false);
    s.advance(1);
    expect(s.wake("focus")).toBe(true);
    expect(s.sends).toHaveLength(2);
    expect(s.nudges()).toBe(0);
  });

  it("kilit açılışının hemen ardından gelen odak ikinci uyandırma göndermez", () => {
    const s = setup();
    s.wake("unlock");
    expect(s.wake("focus")).toBe(false);
    expect(s.sends).toHaveLength(1);
  });

  it("işçi bağlı değilse sessizce false (yoklama yine dürtülür)", () => {
    const s = setup(false);
    expect(s.wake("resume")).toBe(false);
    expect(s.nudges()).toBe(1);
  });
});

describe("electron/main.ts bağlantıları (Electron'u başlatmadan kaynak denetimi)", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "..", "electron", "main.ts"), "utf8");
  it("uyku/kilit/odak olayları uyandırma sinyaline, işçi ve web sürecinin dürtmesi yoklayıcıya bağlıdır", () => {
    expect(main).toMatch(/powerMonitor\.on\("resume", \(\) => wake\("resume"\)\)/);
    expect(main).toMatch(/powerMonitor\.on\("unlock-screen", \(\) => wake\("unlock"\)\)/);
    expect(main).toMatch(/app\.on\("browser-window-focus", \(\) => wake\("focus"\)\)/);
    expect(main).toMatch(/listenForNotify\(w\)/);
    expect(main).toMatch(/listenForNotify\(spawnChild\("server"/);
    expect(main).toMatch(/w\.send\(\{ type: "wake" \}\)/);
    // Bildirim tıklaması pencereyi öne getirir ve yalnızca uygulama içi yola gider.
    expect(main).toMatch(/win\.focus\(\);[\s\S]{0,200}joinAppPath\(origin, toast\.url\)/);
  });
});

describe("yoklayıcı + gerçek os-claim ucu (atomik sahiplenme)", () => {
  const ORIGIN = "http://127.0.0.1:3000";
  let t: TestDb;
  let db: Db;

  beforeEach(async () => {
    t = await createTestDb();
    await initDatabase();
    db = await getDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  async function seed(n: number) {
    const now = Date.now();
    for (let i = 1; i <= n; i++)
      await notify(
        db,
        {
          kind: "scan.done",
          dedupeKey: `scan.done:${i}`,
          params: { n: i, region: "London", scanId: i },
          url: `/?scan=${i}&lifecycle=new`,
          entity: "scan",
          entityId: i,
        },
        { now: now - (n - i) * 1000 },
      );
  }

  function poller(shown: OsToast[]) {
    return new NotificationPoller(
      {
        origin: () => ORIGIN,
        // Yalnızca os-claim gerçek uca gider; teslimat uyarısı yolu bu testin konusu değil (404).
        fetch: async (url, init) =>
          url.endsWith("/api/notifications/os-claim")
            ? claimRoute.POST(new Request(url, init), undefined)
            : new Response("{}", { status: 404 }),
        show: (toast) => shown.push(toast),
        text: (_key, n) => ({ title: `${n} bildirim`, body: "" }),
        log: () => undefined,
        now: () => Date.now(),
      },
      { intervalMs: 60_000, alertEveryMs: Number.MAX_SAFE_INTEGER },
    );
  }

  it("düzenli yoklama, dürtme fırtınası ve ikinci bir yoklayıcı aynı bildirimi bir kez gösterir", async () => {
    await seed(2);
    const shown: OsToast[] = [];
    const a = poller(shown);
    const b = poller(shown); // ör. yeniden başlatma sırasında iki yoklayıcı
    await Promise.all([a.poll(), b.poll(), a.poll()]);
    a.nudge();
    b.nudge();
    await Promise.all([a.poll(), b.poll()]);
    expect(shown.map((s) => s.url).sort()).toEqual([
      "/?scan=1&lifecycle=new",
      "/?scan=2&lifecycle=new",
    ]);
    // Sonradan eklenen bildirim dürtmeyle bir kez gelir.
    await notify(db, {
      kind: "place.opened",
      dedupeKey: "place.opened:scan:9",
      params: { n: 2, region: "London", scanId: 9 },
      url: "/?scan=9&lifecycle=opened",
    });
    a.nudge();
    b.nudge();
    await vi.waitFor(() => expect(shown).toHaveLength(3));
    await Promise.all([a.poll(), b.poll()]);
    expect(shown).toHaveLength(3);
    expect(shown[2]!.url).toBe("/?scan=9&lifecycle=opened");
  });

  it("'Masaüstü bildirimleri' kapalıyken hiçbir şey gösterilmez", async () => {
    await setSetting(db, "notifications.os", false);
    await seed(2);
    const shown: OsToast[] = [];
    await poller(shown).poll();
    expect(shown).toEqual([]);
  });
});
