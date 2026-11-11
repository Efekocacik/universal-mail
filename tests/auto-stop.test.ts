import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_STOP_DEFAULTS,
  AutoStopError,
  computeBounceStats,
  getAutoStopConfig,
  shouldAutoPause,
  tightenAutoStop,
  type AutoStopConfig,
} from "@/lib/campaigns/auto-stop";
import type { Db } from "@/lib/db/client";
import { messages, settings } from "@/lib/db/schema";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { seedSent } from "./helpers/inbound-fixture";

/**
 * Otomatik durdurma: pay/payda tutarlılığı (birim = ALICI) ve yalnızca sıkılaştırma kuralı (Aşama 13, K5).
 * Sıkılaştırma = durdurmayı DAHA KOLAY tetikleme: asgari alıcı ve oran düşürülebilir, ARTIRILAMAZ; doğrulanmış bounce
 * sayısı 2'de sabittir.
 */

let client: Client;
let db: Db;
beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});
afterEach(() => client.close());

const DEF: AutoStopConfig = { minRecipients: 20, minBounces: 2, minRateBp: 500 };

describe("karar işlevi (varsayılan eşikler)", () => {
  const d = (recipients: number, bounced: number, cfg = DEF) =>
    shouldAutoPause({ recipients, bounced }, cfg);
  it("üç koşul birlikte aranır", () => {
    expect(d(19, 2)).toBe(false); // alıcı az (oran %10,5)
    expect(d(20, 1)).toBe(false); // bounce sayısı az (oran %5)
    expect(d(50, 2)).toBe(false); // oran %4
    expect(d(40, 2)).toBe(true); // tam %5: sınır DAHİL
    expect(d(20, 2)).toBe(true); // %10
    expect(d(30, 2)).toBe(true); // %6,7
    expect(d(0, 0)).toBe(false);
  });
  it("sıkılaştırılmış oran daha erken durdurur", () => {
    expect(d(50, 2, { ...DEF, minRateBp: 300 })).toBe(true); // %4 >= %3
    expect(d(15, 2, { ...DEF, minRecipients: 15 })).toBe(true);
  });
});

describe("pay ve payda: aynı kampanyadaki FARKLI alıcılar", () => {
  async function setup() {
    const camp = await createCampaign(db, { status: "running" });
    const rs = [];
    for (let i = 0; i < 30; i++) rs.push(await seedSent(db, camp));
    return { camp, rs };
  }
  const markHard = async (id: number) =>
    db.update(messages).set({ deliveryStatus: "bounced_hard" }).where(eq(messages.id, id));

  it("örnek hesap: 30 alıcı, 20'sine takip; 2 alıcı bounce (biri iki iletide) → 2/30", async () => {
    const { camp, rs } = await setup();
    // 20 alıcıya 2. adım (takip) de gitmiş: ileti sayısı 50, alıcı sayısı 30.
    for (let i = 0; i < 20; i++) {
      await seedSent(db, camp, {
        clId: rs[i]!.cl,
        leadId: rs[i]!.leadId,
        email: rs[i]!.email,
        step: 1,
      });
    }
    const all = await db.select().from(messages).where(eq(messages.campaignId, camp));
    expect(all).toHaveLength(50);
    // A: yalnızca 1. adımda; B: hem 1. hem 2. adımda bounce.
    await markHard(rs[0]!.outboundId);
    await markHard(rs[1]!.outboundId);
    const b2 = all.find((m) => m.campaignLeadId === rs[1]!.cl && m.stepIndex === 1)!;
    await markHard(b2.id);

    const stats = await computeBounceStats(db, camp);
    expect(stats).toEqual({ recipients: 30, bounced: 2 }); // ileti bazlı olsaydı 3/50 = %6,0 (şişik)
    expect(shouldAutoPause(stats, DEF)).toBe(true); // 2/30 = %6,7
  });

  it("test iletileri, başarısız ve belirsiz iletiler paydaya girmez", async () => {
    const camp = await createCampaign(db, { status: "running" });
    await seedSent(db, camp); // 1 gerçek alıcı
    await seedSent(db, camp, { purpose: "test" });
    await seedSent(db, camp, { status: "failed" });
    await seedSent(db, camp, { status: "unknown" });
    await seedSent(db, camp, { status: "queued" });
    expect(await computeBounceStats(db, camp)).toEqual({ recipients: 1, bounced: 0 });
  });

  it("yumuşak bounce ve işaretlenmemiş iletiler paya girmez; diğer kampanya karışmaz", async () => {
    const { camp, rs } = await setup();
    const other = await createCampaign(db, { status: "running" });
    const o = await seedSent(db, other);
    await markHard(o.outboundId);
    await db
      .update(messages)
      .set({ deliveryStatus: "bounced_soft" })
      .where(eq(messages.id, rs[0]!.outboundId));
    expect(await computeBounceStats(db, camp)).toEqual({ recipients: 30, bounced: 0 });
    expect(await computeBounceStats(db, other)).toEqual({ recipients: 1, bounced: 1 });
  });
});

describe("yalnızca sıkılaştırma", () => {
  const t = (
    i: Partial<{ scope: string; minRecipients: number; minBounces: number; minRateBp: number }>,
  ) => tightenAutoStop(db, { scope: "demo", ...i });
  const expectKind = async (p: Promise<unknown>, kind: string) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AutoStopError);
    expect((e as AutoStopError).kind).toBe(kind);
  };

  it("varsayılanlar: 20 alıcı, 2 bounce, %5", async () => {
    expect(await getAutoStopConfig(db)).toEqual(DEF);
    expect(AUTO_STOP_DEFAULTS).toEqual({ minRecipients: 20, minRateBp: 500 });
  });

  it("gevşetme reddedilir: asgari alıcı artırma, oran artırma, bounce sayısı artırma", async () => {
    await expectKind(t({ minRecipients: 25 }), "loosening_forbidden");
    await expectKind(t({ minRateBp: 800 }), "loosening_forbidden");
    await expectKind(t({ minBounces: 3 }), "loosening_forbidden");
    expect(await getAutoStopConfig(db)).toEqual(DEF);
  });

  it("bounce sayısı 2'nin altına inemez (tek ileti kampanyayı durduramaz)", async () => {
    await expectKind(t({ minBounces: 1 }), "below_floor");
  });

  it("sıkılaştırma kabul edilir ve gerçekten daha erken durdurur", async () => {
    const cfg = await t({ minRecipients: 15, minRateBp: 300 });
    expect(cfg).toEqual({ minRecipients: 15, minBounces: 2, minRateBp: 300 });
    expect(await getAutoStopConfig(db)).toEqual(cfg);
    expect(shouldAutoPause({ recipients: 50, bounced: 2 }, cfg)).toBe(true);
  });

  it("alt sınırlar: 10 alıcı ve %1", async () => {
    expect(await t({ minRecipients: 10, minRateBp: 100 })).toEqual({
      minRecipients: 10,
      minBounces: 2,
      minRateBp: 100,
    });
    await expectKind(t({ minRecipients: 9 }), "below_floor");
    await expectKind(t({ minRateBp: 99 }), "below_floor");
  });

  it("geri gevşetme yasak; eşit değer sorunsuz (idempotent)", async () => {
    await t({ minRecipients: 12, minRateBp: 200 });
    await expectKind(t({ minRecipients: 20 }), "loosening_forbidden");
    await expectKind(t({ minRecipients: 13 }), "loosening_forbidden");
    await expectKind(t({ minRateBp: 500 }), "loosening_forbidden");
    expect(await t({ minRecipients: 12, minRateBp: 200 })).toEqual({
      minRecipients: 12,
      minBounces: 2,
      minRateBp: 200,
    });
    expect(await t({ minBounces: 2 })).toMatchObject({ minRecipients: 12 });
  });

  it("geçersiz girdiler: ondalık, NaN, sonsuz, boş istek", async () => {
    await expectKind(t({ minRecipients: 15.5 }), "invalid_input");
    await expectKind(t({ minRateBp: Number.NaN }), "invalid_input");
    await expectKind(t({ minRecipients: Number.POSITIVE_INFINITY }), "invalid_input");
    await expectKind(t({}), "invalid_input");
  });

  it("canlı kapsam reddedilir", async () => {
    await expectKind(t({ scope: "live", minRecipients: 15 }), "live_locked");
    await expectKind(t({ scope: "x", minRecipients: 15 }), "live_locked");
  });

  it("elle bozulmuş ayar varsayılana sıkıştırılır (gevşek değer işe yaramaz)", async () => {
    const put = (value: unknown) =>
      db
        .insert(settings)
        .values({ key: "mail.autoStop", value, updatedAt: 1 })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: 1 } });
    await put({ minRecipients: 500, minRateBp: 9000 });
    expect(await getAutoStopConfig(db)).toEqual(DEF);
    await put({ minRecipients: 1, minRateBp: 1 });
    expect(await getAutoStopConfig(db)).toEqual({
      minRecipients: 10,
      minBounces: 2,
      minRateBp: 100,
    });
    await put({ minRecipients: "x" });
    expect(await getAutoStopConfig(db)).toEqual(DEF); // şemaya uymayan değer varsayılana düşer
  });
});
