import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, jobs, settings } from "@/lib/db/schema";
import { NonRetryableJobError, clearJobHandlers, getJobHandler } from "@/lib/jobs/registry";
import { getSetting, setSetting } from "@/lib/settings";
import {
  AUTO_REVERIFY_AFTER_MS,
  AUTO_REVERIFY_RETRY_MS,
  UNSUBSCRIBE_DRAIN_JOB,
  createUnsubscribeDrainHandler,
  isUnsubscribeDrainActive,
  needsAutoReverify,
  scheduleUnsubscribeDrainIfActive,
  setUnsubscribeDrainEnabled,
  startUnsubscribeDrain,
  type DrainSourceBundle,
} from "@/lib/unsubscribe/drain-job";
import { VERIFICATION_TTL_MS, setUnsubscribeBaseUrl } from "@/lib/unsubscribe/endpoint";
import { registerMailHandlers } from "@/worker/handlers";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW } from "./helpers/inbound-fixture";

/**
 * Çıkış olayı çekme işinin üretimde açılması (C4): ortam bayrağı VEYA `mail.unsubscribeDrain` ayarı HER TURDA okunur,
 * yapılandırma değişince tur planlanır, kapatılınca bekleyen turlar iptal edilir ve kanıt 25 günden eskiyse iş
 * kendiliğinden yeniden doğrular. Gerçek ağ isteği YOK.
 */

const BASE = "https://cikis.firma-ornek.com";
let client: Client;
let db: Db;
let dir: string;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY", "UM_UNSUBSCRIBE_DRAIN_ENABLED"])
    saved[k] = process.env[k];
  delete process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-drainset-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  globalFetch = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled(); // gerçek ağ isteği YOK
  globalFetch.mockRestore();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ctx = (logs: string[] = [], id = 1) => ({
  job: { id } as never,
  payload: {},
  db,
  shouldStop: () => false,
  log: (m: string) => logs.push(m),
});
const drainJobs = () => db.select().from(jobs).where(eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB));
const emptyBundle = (): DrainSourceBundle => ({
  source: { pull: async () => [], ack: async () => undefined },
  stats: { getStats: async () => ({ depth: 0, oldestAgeMs: null, corrupt: 0 }) },
});
const ON = { UM_UNSUBSCRIBE_DRAIN_ENABLED: "1" };

describe("açma anahtarı: ortam bayrağı VEYA ayar", () => {
  it("varsayılan kapalı; ayar veya bayrak açar", async () => {
    expect(await getSetting(db, "mail.unsubscribeDrain")).toEqual({ enabled: false });
    expect(await isUnsubscribeDrainActive(db, {})).toBe(false);
    expect(await isUnsubscribeDrainActive(db, ON)).toBe(true);
    await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
    expect(await isUnsubscribeDrainActive(db, {})).toBe(true);
  });

  it("worker başlangıcı ayarı da okur: ayar açık + adres varsa tek tur planlanır", async () => {
    await setUnsubscribeBaseUrl(db, BASE, NOW);
    expect(await startUnsubscribeDrain(db, { env: {}, now: () => NOW })).toEqual({
      enabled: false,
    });
    expect(await drainJobs()).toHaveLength(0);
    await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
    expect(await startUnsubscribeDrain(db, { env: {}, now: () => NOW })).toEqual({ enabled: true });
    expect(await drainJobs()).toHaveLength(1);
  });

  it("worker işleyicisi anahtarı HER TURDA okur (yeniden başlatma gerekmez)", async () => {
    clearJobHandlers();
    registerMailHandlers({ enabled: false, db });
    const h = getJobHandler(UNSUBSCRIBE_DRAIN_JOB)!;
    await expect(h(ctx())).rejects.toBeInstanceOf(NonRetryableJobError);
    await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
    const logs: string[] = [];
    await h(ctx(logs)); // yapılandırma yok: ağ yok, yalnızca günlük
    expect(logs.join("|")).toContain("yapılandırılmadı");
    clearJobHandlers();
  });

  it("işleyici: tur sürerken kapatıldıysa sonraki tur PLANLANMAZ", async () => {
    let on = true;
    const h = createUnsubscribeDrainHandler({
      enabled: async () => on,
      now: () => NOW,
      sourceFactory: async () => {
        on = false; // kullanıcı tur sırasında kapattı
        return emptyBundle();
      },
    });
    await h(ctx());
    expect(await drainJobs()).toHaveLength(0);
  });
});

describe("ayarın yazılması ve planlama", () => {
  it("açınca (adres varsa) hemen tur planlanır ve denetime yazılır; tekrar açmak kopya üretmez", async () => {
    await setUnsubscribeBaseUrl(db, BASE, NOW);
    expect(await setUnsubscribeDrainEnabled(db, true, { env: {}, now: NOW })).toEqual({
      enabled: true,
      active: true,
      scheduled: true,
    });
    await setUnsubscribeDrainEnabled(db, true, { env: {}, now: NOW });
    const rows = await drainJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAt).toBe(NOW);
    const a = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "unsubscribe.drain_toggled"));
    expect(a.map((r) => r.detail)).toEqual([{ enabled: true }, { enabled: true }]);
  });

  it("adres yoksa açmak ayarı yazar ama iş planlamaz", async () => {
    expect(await setUnsubscribeDrainEnabled(db, true, { env: {}, now: NOW })).toMatchObject({
      active: true,
      scheduled: false,
    });
    expect(await drainJobs()).toHaveLength(0);
  });

  it("kapatınca bekleyen turlar iptal edilir; ortam bayrağı açıksa iptal edilmez", async () => {
    await setUnsubscribeBaseUrl(db, BASE, NOW);
    await setUnsubscribeDrainEnabled(db, true, { env: {}, now: NOW });
    expect(await setUnsubscribeDrainEnabled(db, false, { env: ON, now: NOW })).toMatchObject({
      enabled: false,
      active: true,
    });
    expect((await drainJobs())[0]!.status).toBe("queued");
    expect(await setUnsubscribeDrainEnabled(db, false, { env: {}, now: NOW })).toMatchObject({
      active: false,
      scheduled: false,
    });
    expect((await drainJobs()).map((j) => j.status)).toEqual(["cancelled"]);
  });

  it("yapılandırma değişince planlama yalnızca iş açıksa ve adres varsa yapılır", async () => {
    expect(await scheduleUnsubscribeDrainIfActive(db, { env: ON, now: NOW })).toBe(false); // adres yok
    await setUnsubscribeBaseUrl(db, BASE, NOW);
    const before = JSON.stringify(await db.select().from(settings));
    expect(await scheduleUnsubscribeDrainIfActive(db, { env: {}, now: NOW })).toBe(false); // kapalı
    expect(await drainJobs()).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(settings))).toBe(before);
    expect(await scheduleUnsubscribeDrainIfActive(db, { env: ON, now: NOW })).toBe(true);
    expect(await drainJobs()).toHaveLength(1);
  });
});

describe("kendiliğinden yeniden doğrulama (kanıt 30 gün geçerli, 25 günde yenilenir)", () => {
  const proof = async (verifiedAt: number) => {
    await setUnsubscribeBaseUrl(db, BASE, verifiedAt);
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      verified: { baseUrl: BASE, kid: "0123456789abcdef", jti: "j", verifiedAt },
    });
  };
  const failedAttempt = async (code: string, at: number) => {
    await setUnsubscribeBaseUrl(db, BASE, at);
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      lastAttempt: { at, ok: false, code },
    });
  };

  it("kural: eski kanıt → evet; taze kanıt → hayır; hiç denenmemiş → hayır", async () => {
    expect(AUTO_REVERIFY_AFTER_MS).toBeLessThan(VERIFICATION_TTL_MS);
    expect(await needsAutoReverify(db, NOW)).toBe(false); // adres yok
    await setUnsubscribeBaseUrl(db, BASE, NOW);
    expect(await needsAutoReverify(db, NOW)).toBe(false); // ilk doğrulama kullanıcı eylemidir
    await proof(NOW);
    expect(await needsAutoReverify(db, NOW + AUTO_REVERIFY_AFTER_MS)).toBe(false);
    expect(await needsAutoReverify(db, NOW + AUTO_REVERIFY_AFTER_MS + 1)).toBe(true);
  });

  it("kural: yeniden denenebilir başarısızlıktan 1 saat sonra yeniden dener; yapılandırma hatasında denemez", async () => {
    await failedAttempt("bad_status", NOW);
    expect(await needsAutoReverify(db, NOW + AUTO_REVERIFY_RETRY_MS - 1)).toBe(false);
    expect(await needsAutoReverify(db, NOW + AUTO_REVERIFY_RETRY_MS)).toBe(true);
    await failedAttempt("channel_failed", NOW);
    expect(await needsAutoReverify(db, NOW + AUTO_REVERIFY_RETRY_MS)).toBe(true);
    await failedAttempt("no_key", NOW);
    expect(await needsAutoReverify(db, NOW + 10 * AUTO_REVERIFY_RETRY_MS)).toBe(false);
  });

  it("iş: kanıt 25 günden eskiyse tur sonunda yeniden doğrular; tazeyse doğrulamaz", async () => {
    const calls: number[] = [];
    let clock = NOW + 24 * 86_400_000;
    const h = createUnsubscribeDrainHandler({
      enabled: true,
      now: () => clock,
      sourceFactory: async () => emptyBundle(),
      reverify: async () => {
        calls.push(clock);
        return { ok: true, code: "verified" };
      },
    });
    await proof(NOW);
    await h(ctx());
    expect(calls).toEqual([]);
    clock = NOW + 26 * 86_400_000;
    const logs: string[] = [];
    await h(ctx(logs, 2));
    expect(calls).toEqual([clock]);
    expect(logs.join("|")).toContain("kendiliğinden yeniden doğrulandı: verified");
  });

  it("iş: yeniden doğrulama hatası turu bozmaz; sonraki tur yine planlanır", async () => {
    await proof(NOW);
    const logs: string[] = [];
    const h = createUnsubscribeDrainHandler({
      enabled: true,
      now: () => NOW + 26 * 86_400_000,
      sourceFactory: async () => emptyBundle(),
      reverify: async () => {
        throw new Error("x");
      },
    });
    await h(ctx(logs));
    expect(logs.join("|")).toContain("yeniden doğrulama yapılamadı");
    expect(await drainJobs()).toHaveLength(1);
  });
});
