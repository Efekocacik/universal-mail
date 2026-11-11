import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { auditLog, messages, settings } from "@/lib/db/schema";
import type { MailProvider } from "@/lib/mail/provider/provider";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { ensureSigningKey } from "@/lib/unsubscribe/keys";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

/**
 * Gerçek (mock'lanmamış) sabitlerle (Aşama 15.7; kapı açma sürümünde güncellendi): kod kapısı AÇIK olsa bile canlı
 * ülke politikası kilitliyken ve kutu gönderime hazır değilken canlı bir posta kutusu hiçbir şey yapmaz — belirteç
 * basmaz, ileti kaydı açmaz, sağlayıcıyı çağırmaz.
 */

let client: Client;
let db: Db;
let dir: string;
let globalFetch: ReturnType<typeof vi.spyOn>;
let calls: number;
const provider: MailProvider = {
  id: "gmail",
  send: async () => {
    calls++;
    return { status: "accepted", providerMessageId: "x", acceptedAt: T0 };
  },
};
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-liveclosed-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  globalFetch = vi.spyOn(globalThis, "fetch");
  calls = 0;
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function liveSequence() {
  const gid = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  const camp = await createCampaign(db, { status: "running", mailboxId: gid });
  return addSequence(db, camp, { nextSendAt: null, email: "kisi@alici-ornek.com" });
}
const snapshot = async () =>
  JSON.stringify([
    await db.select().from(settings),
    (await db.select().from(auditLog)).length,
    await db.select().from(messages),
  ]);

describe("ülke kilidi ve uygunluk kapısı (kod kapısı açık)", () => {
  it("gerçek kod kapısı açık ama ülke kilitli: canlı kutu kampanya yolunda hiçbir yan etki üretmez", async () => {
    expect(LIVE_SENDING_ENABLED).toBe(true);
    const s = await liveSequence();
    await ensureSigningKey(db, T0); // anahtar var; yine de belirteç BASILMAMALI
    const before = await snapshot();
    const out = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0, provider },
    );
    expect(out.outcome).toBe("ineligible");
    expect((out as { reasons: { code: string }[] }).reasons.map((r) => r.code)).toContain(
      "country_blocked",
    );
    expect(calls).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it("test geçersiz kılması açık olsa bile ülke politikası/uygunluk kapısı canlı kutuyu durdurur (bağımsız ikinci kapı)", async () => {
    const s = await liveSequence();
    const before = await snapshot();
    const out = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0, provider, liveEnabled: () => true },
    );
    expect(out.outcome).toBe("ineligible");
    expect(calls).toBe(0);
    expect(await snapshot()).toBe(before);
  });
});
