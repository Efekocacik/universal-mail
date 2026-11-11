import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { jobs, settings, suppressions } from "@/lib/db/schema";
import { NonRetryableJobError } from "@/lib/jobs/registry";
import { getSetting } from "@/lib/settings";
import { ensureChannelKey } from "@/lib/unsubscribe/channel";
import {
  UNSUBSCRIBE_DRAIN_JOB,
  buildHttpSource,
  createUnsubscribeDrainHandler,
  isUnsubscribeDrainEnabled,
  startUnsubscribeDrain,
} from "@/lib/unsubscribe/drain-job";
import { setUnsubscribeBaseUrl } from "@/lib/unsubscribe/endpoint";
import { ensureSigningKey, mintUnsubscribeToken } from "@/lib/unsubscribe/keys";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW, seedSent } from "./helpers/inbound-fixture";

/** Çıkış olayı çekme işi (Aşama 15.7): varsayılan kapalı, yapılandırma yoksa ağ yok, hata kuyruğu kaybettirmez. */

let client: Client;
let db: Db;
let dir: string;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-drain-"));
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

const ctx = (logs: string[] = []) => ({
  job: { id: 1 } as never,
  payload: {},
  db,
  shouldStop: () => false,
  log: (m: string) => logs.push(m),
});
const queued = () => db.select().from(jobs).where(eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB));

describe("bayrak ve başlangıç", () => {
  it("bayrak yalnızca '1'/'true'; varsayılan kapalı", () => {
    expect(isUnsubscribeDrainEnabled({})).toBe(false);
    for (const v of ["0", "yes", "", "TRUE", "on"])
      expect(isUnsubscribeDrainEnabled({ UM_UNSUBSCRIBE_DRAIN_ENABLED: v }), v).toBe(false);
    for (const v of ["1", "true"])
      expect(isUnsubscribeDrainEnabled({ UM_UNSUBSCRIBE_DRAIN_ENABLED: v })).toBe(true);
  });

  it("kapalıyken veya yapılandırma yokken başlangıç veritabanına HİÇ yazmaz", async () => {
    const before = JSON.stringify([await db.select().from(settings), await queued()]);
    expect(await startUnsubscribeDrain(db, { env: {} })).toEqual({ enabled: false });
    expect(await startUnsubscribeDrain(db, { env: { UM_UNSUBSCRIBE_DRAIN_ENABLED: "1" } })).toEqual(
      { enabled: false },
    ); // adres yok
    expect(JSON.stringify([await db.select().from(settings), await queued()])).toBe(before);
  });

  it("bayrak ve adres varsa tek bir tur planlanır (tekrar çağrı kopya üretmez)", async () => {
    await setUnsubscribeBaseUrl(db, "https://cikis.firma-ornek.com", NOW);
    const env = { UM_UNSUBSCRIBE_DRAIN_ENABLED: "1" };
    expect(await startUnsubscribeDrain(db, { env, now: () => NOW })).toEqual({ enabled: true });
    await startUnsubscribeDrain(db, { env, now: () => NOW });
    expect(await queued()).toHaveLength(1);
  });
});

describe("işleyici", () => {
  it("kapalıyken NonRetryableJobError; kaynak kurulmaz, ağ yok", async () => {
    let built = false;
    const h = createUnsubscribeDrainHandler({
      enabled: false,
      sourceFactory: async () => {
        built = true;
        return null;
      },
    });
    await expect(h(ctx())).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(built).toBe(false);
  });

  it("yapılandırma/kanal anahtarı yoksa: kaynak kurulamaz, hiçbir ağ isteği yok; sonraki tur planlanır", async () => {
    expect(await buildHttpSource(db)).toBeNull();
    const logs: string[] = [];
    await createUnsubscribeDrainHandler({ enabled: true, now: () => NOW })(ctx(logs));
    expect(logs.join("|")).toContain("yapılandırılmadı");
    expect(await queued()).toHaveLength(1);
  });

  it("olayları çeker, işler, ONAYLAR ve sağlık kaydını yazar; sonraki turu planlar", async () => {
    await ensureSigningKey(db, NOW);
    await ensureChannelKey(db, NOW);
    await setUnsubscribeBaseUrl(db, "https://cikis.firma-ornek.com", NOW);
    const campaign = await createCampaign(db, { status: "running" });
    const sent = await seedSent(db, campaign, { email: "kisi@alici-ornek.com" });
    const { token } = await mintUnsubscribeToken(db, { campaignLeadId: sent.cl, now: NOW });
    const queue = [
      {
        id: "1700000000000-aaaaaaaaaaaaaaaa",
        event: { v: 1, token, receivedAt: NOW + 1000, via: "one_click" },
      },
    ];
    const acked: string[] = [];
    const logs: string[] = [];
    const h = createUnsubscribeDrainHandler({
      enabled: true,
      now: () => NOW + 2000,
      sourceFactory: async () => ({
        source: {
          pull: async () => queue.filter((q) => !acked.includes(q.id)),
          ack: async (ids) => void acked.push(...ids),
        },
        stats: { getStats: async () => ({ depth: 0, oldestAgeMs: null, corrupt: 0 }) },
      }),
    });
    await h(ctx(logs));
    expect(acked).toEqual(["1700000000000-aaaaaaaaaaaaaaaa"]);
    expect((await db.select().from(suppressions)).length).toBe(1);
    expect(logs.join("|")).toContain("1 çıkış");
    expect((await getSetting(db, "mail.unsubscribeEndpoint")).delivery).toMatchObject({
      ok: true,
      code: "ok",
    });
    expect(await queued()).toHaveLength(1);
  });

  it("kanal hatasında olaylar onaylanmaz, hata sağlık kaydına geçer, tur yine planlanır (sessiz kalmaz)", async () => {
    const acked: string[] = [];
    const h = createUnsubscribeDrainHandler({
      enabled: true,
      now: () => NOW,
      sourceFactory: async () => ({
        source: {
          pull: async () => {
            throw new Error("ağ");
          },
          ack: async (ids) => void acked.push(...ids),
        },
        stats: {
          getStats: async () => {
            throw new Error("ağ");
          },
        },
      }),
    });
    const logs: string[] = [];
    await h(ctx(logs));
    expect(acked).toEqual([]);
    expect(logs.join("|")).toContain("çekilemedi");
    expect((await getSetting(db, "mail.unsubscribeEndpoint")).delivery).toMatchObject({
      ok: false,
      code: "unreachable",
    });
    expect(await queued()).toHaveLength(1);
  });
});
