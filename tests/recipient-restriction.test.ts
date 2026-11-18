import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as settingsRoute from "@/app/api/settings/route";
import { CampaignError } from "@/lib/campaigns/errors";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { computeStartPlan } from "@/lib/campaigns/preflight";
import { evaluateEnrollment, evaluateSend } from "@/lib/compliance/eligibility";
import { applyLiveCountryApproval } from "@/lib/compliance/live-country-approval";
import {
  getRecipientRestrictionState,
  isRecipientAllowed,
  loadRecipientRestriction,
  normalizeAddresses,
  RESTRICTION_KEY,
  RESTRICTION_MAX_ADDRESSES,
  RESTRICTION_OFF,
  RESTRICTION_PAUSE_REASON,
  RESTRICTION_RECHECK_MS,
  RestrictionError,
  updateRecipientRestriction,
} from "@/lib/compliance/recipient-restriction";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, campaigns, settings } from "@/lib/db/schema";
import { classifyReasons } from "@/lib/mail/scheduler/dispatcher";
import { setSetting, USER_SETTING_KEYS } from "@/lib/settings";
import {
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
  addSequence,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

/**
 * Test alıcı sınırı ("test modu"): kütüphane, uygunluk denetimi, dağıtıcı sınıflaması ve kampanya yaşam döngüsü.
 * Gmail sağlayıcı katmanı `gmail-provider.test.ts`'te (sahte Gmail/OAuth sunucularıyla). Ağ isteği yok.
 *
 * Not: canlı kapsam senaryoları canlı kapıların açık olduğu mevcut sürümü varsayar (diğer canlı yol testleri gibi).
 */

const NOW = T0 + 3_600_000;
const ALLOWED = "info@izinli-test.example";
const OTHER = "info@baska-isletme.example";

const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let dir: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  // GERÇEK veri klasörüne dokunulmaz: rota ve servisler bu geçici klasörü ve bellek içi veritabanını kullanır.
  savedDataDir = process.env.UM_DATA_DIR;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-restr-"));
  process.env.UM_DATA_DIR = dir;
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  liveId = null;
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows dosya kilidi: geçici klasör, önemli değil */
  }
  if (savedDataDir === undefined) delete process.env.UM_DATA_DIR;
  else process.env.UM_DATA_DIR = savedDataDir;
});

let liveId: number | null = null;
async function liveBox(): Promise<number> {
  if (liveId !== null) return liveId;
  const id = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  await setSetting(db, "mail.gmailGrants", { [String(id)]: { send: true, read: false, at: T0 } });
  liveId = id;
  return id;
}
async function unlockGb(): Promise<void> {
  await applyLiveCountryApproval(
    db,
    { countries: ["GB"], mode: "allowed", approvalRef: "TEST-REF-1", approvedBy: "Test Yetkilisi" },
    { now: T0 },
  );
}
const enable = (addresses: string[]) =>
  updateRecipientRestriction(db, { enabled: true, addresses }, { now: NOW });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("kütüphane: varsayılan kapalı ve adres doğrulaması", () => {
  it("kayıt yoksa KAPALI; kapalıyken (veya sınır yokken) herkes izinli", async () => {
    const r = await loadRecipientRestriction(db);
    expect(r).toEqual(RESTRICTION_OFF);
    expect(isRecipientAllowed(r, "kimse@firma.example")).toBe(true);
    expect(isRecipientAllowed(null, "kimse@firma.example")).toBe(true);
    const state = await getRecipientRestrictionState(db);
    expect(state).toMatchObject({
      enabled: false,
      addresses: [],
      corrupt: false,
      max: RESTRICTION_MAX_ADDRESSES,
    });
  });

  it("yalnızca TAM adres: görünen ad, boşluk, alan adı, joker ve virgüllü liste GEÇERSİZ; yinelenen ve büyük harf düzelir", () => {
    expect(
      normalizeAddresses(["Info@Izinli-Test.example", " info@izinli-test.example ", "x@y.example"]),
    ).toEqual({
      addresses: ["info@izinli-test.example", "x@y.example"],
      invalid: 0,
    });
    for (const bad of [
      "<info@firma.example>",
      "Ad Soyad <info@firma.example>",
      "info @firma.example",
      "@firma.example",
      "firma.example",
      "*@firma.example",
      "info*@firma.example",
      "i?fo@firma.example",
      "info@*.example",
      "info@firma.example, x@y.example",
      "info@firma.example;x@y.example",
      "",
      "   ",
    ]) {
      expect(normalizeAddresses([bad]).invalid, JSON.stringify(bad)).toBe(1);
    }
  });

  it("izinli kontrolü büyük/küçük harf duyarsız tam eşleşmedir (takma ad ve alt alan adı eşleşmez)", async () => {
    await enable([ALLOWED]);
    const r = await loadRecipientRestriction(db);
    expect(isRecipientAllowed(r, ALLOWED)).toBe(true);
    expect(isRecipientAllowed(r, "INFO@IZINLI-TEST.EXAMPLE")).toBe(true);
    expect(isRecipientAllowed(r, "info+x@izinli-test.example")).toBe(false);
    expect(isRecipientAllowed(r, "info@alt.izinli-test.example")).toBe(false);
    expect(isRecipientAllowed(r, OTHER)).toBe(false);
  });

  it("iç ayar: ayarlar API'siyle yazılamaz", async () => {
    expect((USER_SETTING_KEYS as readonly string[]).includes(RESTRICTION_KEY)).toBe(false);
    const res = await settingsRoute
      .PUT(
        new Request("http://127.0.0.1:3000/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
          body: JSON.stringify({
            [RESTRICTION_KEY]: { enabled: false, addresses: [], updatedAt: 1 },
          }),
        }),
        undefined as never,
      )
      .catch((e: unknown) => e);
    // Katı gövde: bilinmeyen anahtar reddedilir (hata fırlatır veya 4xx döner); kayıt oluşmaz.
    if (res instanceof Response) expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(settings).where(eq(settings.key, RESTRICTION_KEY))).toHaveLength(
      0,
    );
  });
});

describe("servis: açma, sıkılaştırma, gevşetme", () => {
  it("AÇARKEN liste açıkça verilmelidir: boş liste ile açılamaz; kayıt yazılmaz", async () => {
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: [] }),
    ).rejects.toMatchObject({
      kind: "list_required",
    });
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: ["  ", ""] }),
    ).rejects.toBeInstanceOf(RestrictionError);
    expect(await db.select().from(settings).where(eq(settings.key, RESTRICTION_KEY))).toHaveLength(
      0,
    );
  });

  it("geçersiz girdi, çok fazla adres ve alan adı/joker reddedilir; hiçbir şey yazılmaz", async () => {
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: ["*@firma.example"] }),
    ).rejects.toMatchObject({
      kind: "invalid_address",
    });
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: ["@firma.example"] }),
    ).rejects.toMatchObject({
      kind: "invalid_address",
    });
    const many = Array.from(
      { length: RESTRICTION_MAX_ADDRESSES + 1 },
      (_, i) => `a${i}@firma.example`,
    );
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: many }),
    ).rejects.toMatchObject({
      kind: "too_many_addresses",
    });
    expect(await db.select().from(settings).where(eq(settings.key, RESTRICTION_KEY))).toHaveLength(
      0,
    );
  });

  it("sıkılaştırma serbest: açmak ve adres çıkarmak onay istemez; denetim kaydında adres YOK, yalnızca sayılar", async () => {
    const a = await enable([ALLOWED, OTHER]);
    expect(a.loosened).toBe(false);
    expect(a.changed).toBe(true);
    expect(a.state).toMatchObject({ enabled: true, addresses: [OTHER, ALLOWED].sort() });
    const b = await updateRecipientRestriction(
      db,
      { enabled: true, addresses: [ALLOWED] },
      { now: NOW + 1 },
    );
    expect(b.loosened).toBe(false);
    expect(b.state.addresses).toEqual([ALLOWED]);
    const audits = (await db.select().from(auditLog)).filter((r) =>
      r.action.startsWith("recipient_restriction."),
    );
    expect(audits.length).toBe(2);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain("izinli-test");
    expect(dump).not.toContain("baska-isletme");
    expect(dump).toContain('"added":2');
    expect(dump).toContain('"removed":1');
  });

  it("değişiklik yoksa hiçbir şey yazılmaz (denetim kaydı yok)", async () => {
    await enable([ALLOWED]);
    const before = (await db.select().from(auditLog)).length;
    const r = await enable([ALLOWED]);
    expect(r.changed).toBe(false);
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("GEVŞETME açık onay ister: kapatmak ve listeye adres eklemek; onaysız hiçbir şey değişmez", async () => {
    await enable([ALLOWED]);
    await expect(
      updateRecipientRestriction(db, { enabled: false, addresses: [ALLOWED] }),
    ).rejects.toMatchObject({
      kind: "loosening_ack_required",
    });
    await expect(
      updateRecipientRestriction(db, { enabled: true, addresses: [ALLOWED, OTHER] }),
    ).rejects.toMatchObject({ kind: "loosening_ack_required" });
    await expect(
      updateRecipientRestriction(db, { enabled: false, addresses: [ALLOWED], ackLoosening: false }),
    ).rejects.toMatchObject({ kind: "loosening_ack_required" });
    const still = await loadRecipientRestriction(db);
    expect(still.enabled).toBe(true);
    expect([...still.addresses]).toEqual([ALLOWED]);
  });

  it("gevşetme çalışan CANLI kampanyaları duraklatır (neden 'restriction'); demo, zaten duraklatılmış ve taslak etkilenmez", async () => {
    const live = await liveBox();
    const running = await createCampaign(db, { mailboxId: live, status: "running" });
    const demoRunning = await createCampaign(db, { mailboxId: DEMO_MAILBOX, status: "running" });
    const alreadyPaused = await createCampaign(db, { mailboxId: live, status: "paused" });
    await db.update(campaigns).set({ pauseReason: "user" }).where(eq(campaigns.id, alreadyPaused));
    await enable([ALLOWED]);

    const r = await updateRecipientRestriction(
      db,
      { enabled: true, addresses: [ALLOWED, OTHER], ackLoosening: true },
      { now: NOW + 5 },
    );
    expect(r.loosened).toBe(true);
    expect(r.pausedCampaigns).toEqual([running]);
    const rows = await db.select().from(campaigns);
    const by = (id: number) => rows.find((c) => c.id === id)!;
    expect(by(running)).toMatchObject({
      status: "paused",
      pauseReason: RESTRICTION_PAUSE_REASON,
      pausedAt: NOW + 5,
    });
    expect(by(demoRunning).status).toBe("running");
    expect(by(alreadyPaused)).toMatchObject({ status: "paused", pauseReason: "user" });
    const audits = (await db.select().from(auditLog)).map((a) => a.action);
    expect(audits).toContain("recipient_restriction.campaigns_paused");
  });

  it("ack gerektiren hata, çalışan canlı kampanya sayısını bildirir (arayüz onay penceresi için)", async () => {
    const live = await liveBox();
    await createCampaign(db, { mailboxId: live, status: "running" });
    await enable([ALLOWED]);
    await expect(
      updateRecipientRestriction(db, { enabled: false, addresses: [ALLOWED] }),
    ).rejects.toMatchObject({
      kind: "loosening_ack_required",
      detail: { runningCampaigns: 1 },
    });
    const state = await getRecipientRestrictionState(db);
    expect(state.runningLiveCampaigns).toBe(1);
  });

  it("kişisel/kişi adlı adres için bilgi notu verir (mevcut uygunluk kuralları zaten göndermez); yine de kaydedilir", async () => {
    const r = await enable(["kisi@gmail.com", "ayse.yilmaz@firma.example", ALLOWED]);
    const issues = Object.fromEntries(r.state.notes.map((n) => [n.address, n.issue]));
    expect(issues["kisi@gmail.com"]).toBe("consumer");
    expect(issues["ayse.yilmaz@firma.example"]).toBe("personal");
    expect(issues[ALLOWED]).toBeUndefined();
  });

  it("BOZUK kayıt: sınır AÇIK ve boş sayılır (her şeyi engeller, kapalıya düşmez); geçerli kayıtla onarılır", async () => {
    await db.insert(settings).values({
      key: RESTRICTION_KEY,
      value: { enabled: "evet", addresses: "yanlis" },
      updatedAt: NOW,
    });
    const r = await loadRecipientRestriction(db);
    expect(r).toMatchObject({ enabled: true, corrupt: true });
    expect(isRecipientAllowed(r, ALLOWED)).toBe(false);
    const state = await getRecipientRestrictionState(db);
    expect(state).toMatchObject({ enabled: true, corrupt: true, addresses: [] });
    // Bozuk kayıt "hepsini engelle" sayılır; geçerli listeyle onarmak da gevşetmedir: açık onay ister.
    await expect(enable([ALLOWED])).rejects.toMatchObject({ kind: "loosening_ack_required" });
    const fixed = await updateRecipientRestriction(
      db,
      { enabled: true, addresses: [ALLOWED], ackLoosening: true },
      { now: NOW },
    );
    expect(fixed.state.corrupt).toBe(false);
    expect(isRecipientAllowed(await loadRecipientRestriction(db), ALLOWED)).toBe(true);
  });
});

describe("uygunluk denetimi: ek ret nedeni (VE), mevcut kurallar korunur", () => {
  async function liveSeq(email: string) {
    const live = await liveBox();
    const campaignId = await createCampaign(db, { mailboxId: live, status: "running" });
    const s = await addSequence(db, campaignId, { email });
    return { live, campaignId, ...s };
  }

  it("sınır KAPALIYKEN hiçbir etki yok (varsayılan davranış korunur)", async () => {
    const s = await liveSeq(OTHER);
    expect(
      codes(await evaluateSend(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: NOW })),
    ).not.toContain("recipient_not_allowed");
    expect(
      codes(
        await evaluateEnrollment(
          db,
          { campaignId: s.campaignId, leadId: s.leadId },
          { now: NOW, ignoreCampaignLeadId: s.cl },
        ),
      ),
    ).not.toContain("recipient_not_allowed");
  });

  it("sınır AÇIKKEN: listede olmayan alıcı için gönderim ve ekleme denetimi 'recipient_not_allowed' verir (until: +1 saat); izinli olana vermez", async () => {
    await enable([ALLOWED]);
    const blocked = await liveSeq(OTHER);
    const send = await evaluateSend(db, { campaignLeadId: blocked.cl, stepIndex: 0 }, { now: NOW });
    expect(send.eligible).toBe(false);
    const reason = send.reasons.find((r) => r.code === "recipient_not_allowed");
    expect(reason).toMatchObject({ until: NOW + RESTRICTION_RECHECK_MS });
    const enr = await evaluateEnrollment(
      db,
      { campaignId: blocked.campaignId, leadId: blocked.leadId },
      { now: NOW, ignoreCampaignLeadId: blocked.cl },
    );
    expect(codes(enr)).toContain("recipient_not_allowed");

    const campaignId2 = await createCampaign(db, { mailboxId: blocked.live, status: "running" });
    const ok = await addSequence(db, campaignId2, { email: ALLOWED });
    expect(
      codes(await evaluateSend(db, { campaignLeadId: ok.cl, stepIndex: 0 }, { now: NOW })),
    ).not.toContain("recipient_not_allowed");
  });

  it("DEMO kutusu etkilenmez (gerçek kişilere ulaşmaz)", async () => {
    await enable([ALLOWED]);
    const campaignId = await createCampaign(db, { mailboxId: DEMO_MAILBOX, status: "running" });
    const s = await addSequence(db, campaignId, { email: OTHER });
    expect(
      codes(await evaluateSend(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: NOW })),
    ).not.toContain("recipient_not_allowed");
  });

  it("bozuk kayıtta herkes reddedilir (güvenli taraf)", async () => {
    await db
      .insert(settings)
      .values({ key: RESTRICTION_KEY, value: { enabled: 1 }, updatedAt: NOW });
    const s = await liveSeq(ALLOWED);
    expect(
      codes(await evaluateSend(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: NOW })),
    ).toContain("recipient_not_allowed");
  });

  it("mevcut korumalar GEVŞEMEZ: izinli listedeki alıcı bile ülke kilidi, suppression ve adres kurallarına tabidir", async () => {
    await enable([ALLOWED]);
    // 1) Ülke kilitli (canlı politika engelli): izinli adres olsa da country_blocked sürer.
    const s = await liveSeq(ALLOWED);
    const locked = codes(
      await evaluateSend(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: NOW }),
    );
    expect(locked).toContain("country_blocked");
    expect(locked).not.toContain("recipient_not_allowed");
    // 2) Listede olmayan + ülke kilitli: İKİ neden birlikte (VE koşulu), hiçbiri diğerini gizlemez.
    const o = await liveSeq(OTHER);
    const both = codes(
      await evaluateSend(db, { campaignLeadId: o.cl, stepIndex: 0 }, { now: NOW }),
    );
    expect(both).toEqual(expect.arrayContaining(["country_blocked", "recipient_not_allowed"]));
  });
});

describe("dağıtıcı sınıflaması: izin verilmeyen alıcı ERTELENİR, dışlanmaz", () => {
  it("yalnızca 'recipient_not_allowed': ertele (until'e kadar, en az 1 dk); silme/dışlama yok", () => {
    const v = classifyReasons(
      [{ code: "recipient_not_allowed", until: NOW + RESTRICTION_RECHECK_MS }],
      NOW,
    );
    expect(v).toEqual({ action: "defer", retryAt: NOW + RESTRICTION_RECHECK_MS });
    const soon = classifyReasons([{ code: "recipient_not_allowed", until: NOW + 10 }], NOW);
    expect(soon).toEqual({ action: "defer", retryAt: NOW + 60_000 });
  });

  it("kalıcı bir neden birlikteyse (ülke kilidi, suppression) mevcut kural geçerli: dışlanır", () => {
    expect(
      classifyReasons(
        [
          { code: "recipient_not_allowed", until: NOW + RESTRICTION_RECHECK_MS },
          { code: "country_blocked" },
        ],
        NOW,
      ).action,
    ).toBe("exclude");
    expect(
      classifyReasons(
        [
          { code: "recipient_not_allowed", until: NOW + RESTRICTION_RECHECK_MS },
          { code: "suppressed" },
        ],
        NOW,
      ).action,
    ).toBe("exclude");
  });
});

describe("kampanya yaşam döngüsü: bekletme ve AÇIK yeniden başlatma onayı", () => {
  const demoEnv = { FAZ3_DEMO_SCHEDULER_ENABLED: "1" };

  it("sınır nedeniyle duraklatılan kampanya onaysız SÜRDÜRÜLEMEZ; açık onayla sürdürülür", async () => {
    const id = await createCampaign(db, { mailboxId: DEMO_MAILBOX, status: "paused", steps: 1 });
    await db
      .update(campaigns)
      .set({ pauseReason: RESTRICTION_PAUSE_REASON })
      .where(eq(campaigns.id, id));
    await addSequence(db, id, { email: OTHER });

    const err = await transitionCampaign(db, id, "resume", { now: NOW, env: demoEnv }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect(err).toMatchObject({ code: "restriction_ack_required", detail: { waiting: 1 } });
    expect((await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]).toMatchObject({
      status: "paused",
      pauseReason: RESTRICTION_PAUSE_REASON,
    });
    // açık onay yalnızca true değeriyle kabul edilir
    await expect(
      transitionCampaign(db, id, "resume", { now: NOW, env: demoEnv, restrictionAck: false }),
    ).rejects.toMatchObject({ code: "restriction_ack_required" });

    const ok = await transitionCampaign(db, id, "resume", {
      now: NOW,
      env: demoEnv,
      restrictionAck: true,
    });
    expect(ok).toMatchObject({ changed: true, status: "running" });
    expect((await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]).toMatchObject({
      pauseReason: null,
    });
  });

  it("kullanıcı kendisi duraklatmışsa bile, sınır nedeniyle BEKLEYEN alıcı varsa devam onay ister; yoksa istemez", async () => {
    const id = await createCampaign(db, { mailboxId: DEMO_MAILBOX, status: "paused", steps: 1 });
    await db.update(campaigns).set({ pauseReason: "user" }).where(eq(campaigns.id, id));
    const s = await addSequence(db, id, { email: OTHER });
    await db
      .update(campaignLeads)
      .set({
        lastError: "recipient_not_allowed",
        status: "scheduled",
        nextSendAt: NOW + RESTRICTION_RECHECK_MS,
      })
      .where(eq(campaignLeads.id, s.cl));

    await expect(
      transitionCampaign(db, id, "resume", { now: NOW, env: demoEnv }),
    ).rejects.toMatchObject({
      code: "restriction_ack_required",
      detail: { held: 1 },
    });
    // Bekleyen kalmayınca normal devam (ek onay yok).
    await db.update(campaignLeads).set({ lastError: null }).where(eq(campaignLeads.id, s.cl));
    const ok = await transitionCampaign(db, id, "resume", { now: NOW, env: demoEnv });
    expect(ok.status).toBe("running");
  });

  it("gevşetme → duraklat → onaysız sürdürme reddi: ertelenen alıcılar kendiliğinden gönderime BAŞLAMAZ", async () => {
    const live = await liveBox();
    const id = await createCampaign(db, { mailboxId: live, status: "running" });
    const s = await addSequence(db, id, { email: OTHER });
    await db
      .update(campaignLeads)
      .set({ lastError: "recipient_not_allowed" })
      .where(eq(campaignLeads.id, s.cl));
    await enable([ALLOWED]);
    const r = await updateRecipientRestriction(
      db,
      { enabled: false, addresses: [ALLOWED], ackLoosening: true },
      { now: NOW + 9 },
    );
    expect(r.pausedCampaigns).toEqual([id]);
    await expect(transitionCampaign(db, id, "resume", { now: NOW + 10 })).rejects.toMatchObject({
      code: "restriction_ack_required",
      detail: { restrictionEnabled: false },
    });
    const row = (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]!;
    expect(row.status).toBe("paused");
  });

  it("BAŞLATMA: yalnızca sınır nedeniyle uygun olmayan alıcı DIŞLANMAZ, bekletilir; kalıcı nedenli olan yine dışlanır", async () => {
    const live = await liveBox();
    await unlockGb();
    const id = await createCampaign(db, { mailboxId: live, status: "paused", steps: 1 });
    await db
      .update(campaigns)
      .set({ status: "ready", pausedAt: null, pauseReason: null })
      .where(eq(campaigns.id, id));
    const ok = await addSequence(db, id, { email: ALLOWED });
    const held = await addSequence(db, id, { email: OTHER });
    const bad = await addSequence(db, id, { email: "ayse.yilmaz@kisisel-ad.example" }); // kişi adlı: kalıcı neden
    await db
      .update(campaignLeads)
      .set({ status: "pending", nextSendAt: null })
      .where(eq(campaignLeads.campaignId, id));
    await enable([ALLOWED, "ayse.yilmaz@kisisel-ad.example"]);

    const plan = await computeStartPlan(db, id, { now: NOW, env: demoEnv });
    expect(plan.eligible.map((e) => e.id)).toEqual([ok.cl]);
    expect(plan.held.map((h) => h.id)).toEqual([held.cl]);
    expect(plan.ineligible.map((i) => i.id)).toEqual([bad.cl]);

    const res = await transitionCampaign(db, id, "start", {
      now: NOW,
      env: demoEnv,
      confirmToken: plan.token,
    });
    expect(res).toMatchObject({ status: "running", scheduled: 1, excluded: 1, held: 1 });
    const rows = await db.select().from(campaignLeads).where(eq(campaignLeads.campaignId, id));
    const by = (cl: number) => rows.find((r) => r.id === cl)!;
    expect(by(ok.cl).status).toBe("scheduled");
    expect(by(held.cl)).toMatchObject({
      status: "scheduled",
      nextSendAt: NOW + RESTRICTION_RECHECK_MS,
      lastError: "recipient_not_allowed",
    });
    expect(by(bad.cl).status).toBe("excluded"); // mevcut kural (kişi adlı adres) gevşemedi
  });
});
