import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignError } from "@/lib/campaigns/errors";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { evaluateSend } from "@/lib/compliance/eligibility";
import {
  activateLiveCountries,
  checkActivationPrerequisites,
  getLiveCountryState,
  planActivation,
  revokeLiveCountries,
  validateActivationInput,
  type ActivationInput,
} from "@/lib/compliance/live-country-activation";
import { COUNTRY_REVOKED_PAUSE_REASON } from "@/lib/compliance/live-country-constants";
import { ActivationError } from "@/lib/compliance/live-country-error";
import { updateRecipientRestriction } from "@/lib/compliance/recipient-restriction";
import { trackTransactions, type Db } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  campaigns,
  countryPolicies,
  messages,
  mailboxes,
} from "@/lib/db/schema";
import { NativeConfirmUnavailableError } from "@/lib/native-confirm";
import { classifyReasons } from "@/lib/mail/scheduler/dispatcher";
import { setSetting } from "@/lib/settings";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

/**
 * Uygulama içi canlı ülke aktivasyonu ve geri alma (hizmet katmanı). Hazırlık maddelerinden yalnızca DIŞ olanlar
 * (DNS, çıkış uç noktası, çekme; ayrı testlerle sınanır) sahtelenir; test modu, kendime test kanıtı, hukuki kayıt,
 * veritabanı kısıtları, denetim kayıtları ve kampanya duraklatma GERÇEK veritabanıyla sınanır. Ağ isteği yok.
 */

const rd = vi.hoisted(() => ({
  failing: new Set<string>(),
  keys: [
    "live_flag",
    "consent",
    "company_profile",
    "real_mailbox",
    "dns_auth",
    "https_unsubscribe",
    "event_delivery",
    "legal_live_countries",
  ],
}));
vi.mock("@/lib/compliance/live-readiness", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/compliance/live-readiness")>();
  return {
    ...orig,
    getLiveReadiness: async () => ({
      items: rd.keys.map((key) => ({
        key,
        status: rd.failing.has(key) ? "blocked" : "ok",
        owner: "software",
      })),
      allOk: true,
      liveSendingEnabled: true,
      blockedCount: 0,
      unknownCount: 0,
    }),
  };
});

const DAY = 86_400_000;
const NOW = T0 + 10 * DAY;
const ALLOWED = "info@izinli-test.example";
const SECRET_ADDRESS = "gizli-adres@izinli-test.example";
const HANDLE = "__umDbHandle";

let client: Client;
let db: Db;
let dir: string;
let savedDataDir: string | undefined;
let boxId = 0;

const valid = (over: Partial<ActivationInput> = {}): ActivationInput => ({
  countries: ["GB"],
  mode: "generic_only",
  representativeName: "Ayşe Yetkili",
  representativeTitle: "Genel Müdür",
  operatorName: "Test Operatör",
  documentRef: "HUK-2026-014",
  documentDate: new Date(NOW - 5 * DAY).toISOString().slice(0, 10),
  documentSha256: null,
  scopeAttested: true,
  ...over,
});

const approved = (_req?: unknown) => Promise.resolve("approved" as const);

beforeEach(async () => {
  savedDataDir = process.env.UM_DATA_DIR;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-act-"));
  process.env.UM_DATA_DIR = dir;
  rd.failing.clear();
  ({ client, db } = await openMemoryDb());
  // Üretimdeki `openDatabase` ile aynı işlem sıralaması (eşzamanlı işlem testleri için).
  trackTransactions(client);
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test Operatör" });
  boxId = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  await db
    .update(mailboxes)
    .set({ connectedAt: NOW - 3 * DAY })
    .where(eq(mailboxes.id, boxId));
  await setSetting(db, "mail.gmailGrants", {
    [String(boxId)]: { send: true, read: false, at: T0 },
  });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows dosya kilidi: geçici klasör */
  }
  if (savedDataDir === undefined) delete process.env.UM_DATA_DIR;
  else process.env.UM_DATA_DIR = savedDataDir;
});

const testMode = (on = true, addresses = [ALLOWED]) =>
  updateRecipientRestriction(db, { enabled: on, addresses, ackLoosening: true }, { now: NOW });
const selfTestSent = (at: number, mailboxId = boxId, status = "sent") =>
  db.insert(messages).values({
    direction: "out",
    purpose: "test",
    mailboxId,
    fromAddress: "satis@firma-ornek.com",
    toAddress: "satis@firma-ornek.com",
    peerHash: "h",
    peerDomain: "d",
    status: status as "sent",
    createdAt: at,
    sentAt: at,
  });
/** Tüm ön koşulları sağlar. */
async function ready() {
  await testMode();
  await selfTestSent(NOW - DAY);
}
const gb = async () =>
  (
    await db
      .select()
      .from(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "GB")))
  )[0]!;
const audits = async (action: string) =>
  (await db.select().from(auditLog)).filter((r) => r.action === action);
const kind = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  return e instanceof ActivationError ? e.kind : e instanceof Error ? `HATA:${e.message}` : null;
};
const deps = (confirm = approved) => ({ confirm: vi.fn(confirm), now: () => NOW, env: {} });

describe("hukuki yetkilendirme KAYDI zorunludur (doğrulanmış yetki DEĞİLDİR)", () => {
  it("geçerli kayıt kabul edilir; yazılacak onay alanları sütun sınırlarının içinde", () => {
    const n = validateActivationInput(valid(), NOW);
    expect(n.approvedBy).toBe("Ayşe Yetkili (Genel Müdür); işlem: Test Operatör");
    expect(n.approvalRef).toMatch(/^HUK-2026-014 \| \d{4}-\d{2}-\d{2}$/);
    const max = validateActivationInput(
      valid({
        representativeName: "A".repeat(40),
        representativeTitle: "B".repeat(30),
        operatorName: "C".repeat(30),
        documentRef: "D".repeat(100),
        documentSha256: "a".repeat(64),
      }),
      NOW,
    );
    expect(max.approvedBy.length).toBeLessThanOrEqual(120);
    expect(max.approvalRef.length).toBeLessThanOrEqual(200);
    expect(max.approvalRef).toContain("sha256:" + "a".repeat(16));
  });

  it.each([
    ["temsilci adı yok", { representativeName: " " }],
    ["unvan yok", { representativeTitle: "" }],
    ["işlemi yapan yok", { operatorName: "x" }],
    ["belge referansı yok", { documentRef: "ab" }],
    ["kontrol karakteri", { documentRef: "HUK\u0000-1" }],
    ["tarih biçimi", { documentDate: "18.11.2026" }],
    ["olmayan gün", { documentDate: "2026-02-31" }],
    ["gelecek tarih", { documentDate: new Date(NOW + 2 * DAY).toISOString().slice(0, 10) }],
    [
      "çok eski belge (>90 gün)",
      { documentDate: new Date(NOW - 91 * DAY).toISOString().slice(0, 10) },
    ],
    ["kapsam beyanı yok", { scopeAttested: false }],
    ["belge özeti bozuk", { documentSha256: "xyz" }],
  ] as [string, Partial<ActivationInput>][])("REDDEDİLİR: %s", (_n, over) => {
    expect(() => validateActivationInput(valid(over), NOW)).toThrowError(ActivationError);
    try {
      validateActivationInput(valid(over), NOW);
    } catch (e) {
      expect((e as ActivationError).kind).toBe("activation_legal");
    }
  });

  it("ülke ve mod hataları activation_invalid; 90 günlük sınırda (tam 90) kabul edilir", () => {
    for (const bad of [
      valid({ countries: [] }),
      valid({ countries: ["ZZ"] }),
      valid({ countries: ["GB", "x"] }),
      valid({ mode: "blocked" as never }),
      valid({ countries: ["GB", "FR", "DE", "NL", "BE", "ES", "IT", "PT", "AT", "IE", "SE"] }),
    ]) {
      try {
        validateActivationInput(bad, NOW);
        throw new Error("kabul edildi");
      } catch (e) {
        expect((e as ActivationError).kind).toBe("activation_invalid");
      }
    }
    expect(() =>
      validateActivationInput(
        valid({ documentDate: new Date(NOW - 90 * DAY).toISOString().slice(0, 10) }),
        NOW,
      ),
    ).not.toThrow();
  });
});

describe("ön koşullar: test modu ve kendime test kanıtı GERÇEK veritabanıyla", () => {
  it("hiçbir şey hazır değilken: test modu ve kendime test eksik", async () => {
    const p = await checkActivationPrerequisites(db, NOW, {});
    expect(p.ok).toBe(false);
    expect(p.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(["test_mode", "self_test"]);
  });

  it("test modu: KAPALI, BOŞ ve BOZUK kayıt yetmez; açık + dolu liste yeter", async () => {
    await selfTestSent(NOW - DAY);
    const ok = (p: Awaited<ReturnType<typeof checkActivationPrerequisites>>) =>
      p.checks.find((c) => c.key === "test_mode")!.ok;
    expect(ok(await checkActivationPrerequisites(db, NOW, {}))).toBe(false);
    await db.insert((await import("@/lib/db/schema")).settings).values({
      key: "mail.recipientRestriction",
      value: { enabled: "evet", addresses: 3 },
      updatedAt: NOW,
    });
    expect(ok(await checkActivationPrerequisites(db, NOW, {}))).toBe(false); // bozuk
    await testMode();
    const p = await checkActivationPrerequisites(db, NOW, {});
    expect(ok(p)).toBe(true);
    expect(p.testMode).toMatchObject({ enabled: true, addresses: 1, corrupt: false });
  });

  it("kendime test: eski (>30 gün), yeniden bağlanmadan ÖNCE yapılan, başarısız ve başka kutudaki test yetmez", async () => {
    await testMode();
    const st = async () =>
      (await checkActivationPrerequisites(db, NOW, {})).checks.find((c) => c.key === "self_test")!
        .ok;
    expect(await st()).toBe(false); // hiç yok
    await selfTestSent(NOW - 40 * DAY);
    expect(await st()).toBe(false); // 30 günden eski
    await db
      .update(mailboxes)
      .set({ connectedAt: NOW - 20 * DAY })
      .where(eq(mailboxes.id, boxId));
    await selfTestSent(NOW - 25 * DAY);
    expect(await st()).toBe(false); // yeniden bağlanmadan önce
    await selfTestSent(NOW - 2 * DAY, boxId, "failed");
    expect(await st()).toBe(false); // başarısız
    const other = await addMailbox(db, { provider: "gmail", address: "baska@firma-ornek.com" });
    await selfTestSent(NOW - DAY, other);
    expect(await st()).toBe(false); // test yalnızca BAŞKA kutuda
    await selfTestSent(NOW - DAY);
    expect(await st()).toBe(true); // her iki gerçek kutuda da kanıt var
    // Üçüncü gerçek kutu kanıtsız → yetmez (her gerçek kutu kanıtlanmalı).
    await addMailbox(db, { provider: "gmail", address: "ucuncu@firma-ornek.com" });
    expect(await st()).toBe(false);
  });

  it("dış hazırlık maddeleri (DNS, çıkış uç noktası, çekme...) eksikse ön koşul tamamlanmaz", async () => {
    await ready();
    expect((await checkActivationPrerequisites(db, NOW, {})).ok).toBe(true);
    for (const key of rd.keys) {
      rd.failing.clear();
      rd.failing.add(key);
      const p = await checkActivationPrerequisites(db, NOW, {});
      expect(p.ok, key).toBe(false);
      expect(p.checks.find((c) => c.key === key)!.ok, key).toBe(false);
    }
  });

  it("plan hiçbir şey yazmaz; işlemi yapan kişi onay kaydından farklıysa uyarı", async () => {
    await ready();
    const before = JSON.stringify(await db.select().from(countryPolicies));
    const plan = await planActivation(db, valid({ operatorName: "Başka Kişi" }), {
      now: NOW,
      env: {},
    });
    expect(plan.ready).toBe(true);
    expect(plan.warnings).toEqual(["operator_differs_from_consent"]);
    expect(JSON.stringify(await db.select().from(countryPolicies))).toBe(before);
    expect((await audits("country_policy.live_approved")).length).toBe(0);
    const same = await planActivation(db, valid(), { now: NOW, env: {} });
    expect(same.warnings).toEqual([]);
  });
});

describe("aktivasyon: yerel onay olmadan HİÇBİR ŞEY açılmaz", () => {
  it("başarılı yol: ülke açılır, onay alanları ve denetim kayıtları yazılır (adres/gizli bilgi yok)", async () => {
    await testMode(true, [SECRET_ADDRESS]);
    await selfTestSent(NOW - DAY);
    const d = deps();
    const r = await activateLiveCountries(db, valid(), d);
    expect(r.activated).toEqual(["GB"]);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    const req = d.confirm.mock.calls[0]![0] as {
      kind: string;
      summary: Record<string, unknown>;
    };
    expect(req.kind).toBe("country_activation");
    expect(req.summary).toMatchObject({
      countries: ["GB"],
      mode: "generic_only",
      operatorName: "Test Operatör",
      representativeName: "Ayşe Yetkili",
      testModeEnabled: true,
      allowedAddressCount: 1,
    });
    expect(JSON.stringify(req.summary)).not.toContain(SECRET_ADDRESS); // özet adres taşımaz
    expect(await gb()).toMatchObject({
      mode: "generic_only",
      locked: false,
      approvedBy: "Ayşe Yetkili (Genel Müdür); işlem: Test Operatör",
    });
    expect((await gb()).approvalRef).toMatch(/^HUK-2026-014 \| /);

    const live = await audits("country_policy.live_approved");
    expect(live).toHaveLength(1);
    expect(live[0]!.detail).toMatchObject({ via: "app:native-confirm", countryCode: "GB" });
    const conf = await audits("country_policy.activation_confirmed");
    expect(conf).toHaveLength(1);
    expect(conf[0]!.detail).toMatchObject({
      confirm: "native",
      legalRecord: { documentRef: "HUK-2026-014", scopeAttested: true, verifiedByApp: false },
      operatorName: "Test Operatör",
    });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(SECRET_ADDRESS);
  });

  it("hukuki kayıt eksik/geçersiz: onay penceresi AÇILMAZ ve hiçbir şey yazılmaz", async () => {
    await ready();
    const d = deps();
    expect(await kind(activateLiveCountries(db, valid({ documentRef: "" }), d))).toBe(
      "activation_legal",
    );
    expect(await kind(activateLiveCountries(db, valid({ scopeAttested: false }), d))).toBe(
      "activation_legal",
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("test modu kapalıyken (ilk aktivasyon) reddedilir; pencere açılmaz; iptal denetim kaydı yazılır", async () => {
    await selfTestSent(NOW - DAY);
    const d = deps();
    expect(await kind(activateLiveCountries(db, valid(), d))).toBe("activation_test_mode");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
    expect((await audits("country_policy.activation_cancelled"))[0]!.detail).toMatchObject({
      reason: "test_mode_required",
    });
  });

  it("diğer ön koşullar (kendime test, hazırlık) eksikse reddedilir; pencere açılmaz", async () => {
    await testMode();
    const d = deps();
    expect(await kind(activateLiveCountries(db, valid(), d))).toBe("activation_prerequisites");
    await selfTestSent(NOW - DAY);
    rd.failing.add("https_unsubscribe");
    expect(await kind(activateLiveCountries(db, valid(), d))).toBe("activation_prerequisites");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("yerel onay yok, iptal veya zaman aşımı: hiçbir şey yazılmaz, denetim kaydı 'iptal'", async () => {
    await ready();
    const cases: [() => Promise<never | "declined" | "timeout">, string][] = [
      [() => Promise.resolve("declined" as const), "confirm_declined"],
      [() => Promise.resolve("timeout" as const), "confirm_timeout"],
      [
        () => Promise.reject(new NativeConfirmUnavailableError("no_channel")),
        "confirm_unavailable",
      ],
      [() => Promise.reject(new NativeConfirmUnavailableError("busy")), "confirm_unavailable"],
    ];
    for (const [c, expected] of cases) {
      expect(await kind(activateLiveCountries(db, valid(), deps(c as never)))).toBe(expected);
      expect(await gb()).toMatchObject({ mode: "blocked", locked: true, approvedBy: null });
    }
    expect((await audits("country_policy.activation_cancelled")).length).toBe(4);
    expect((await audits("country_policy.live_approved")).length).toBe(0);
    expect((await audits("country_policy.activation_confirmed")).length).toBe(0);
  });

  it("beklenmeyen onay hatası olduğu gibi yayılır; yazı yapılmaz", async () => {
    await ready();
    const d = deps(() => Promise.reject(new Error("kanal koptu")) as never);
    expect(await kind(activateLiveCountries(db, valid(), d))).toBe("HATA:kanal koptu");
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("onay beklenirken ön koşul bozulursa (test modu kapandı) onaydan SONRA yeniden doğrulanır ve reddedilir", async () => {
    await ready();
    const d = deps(async () => {
      await testMode(false, [ALLOWED]); // kullanıcı onay penceresi açıkken test modunu kapattı
      return "approved";
    });
    expect(await kind(activateLiveCountries(db, valid(), d))).toBe("activation_prerequisites");
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
    expect((await audits("country_policy.activation_cancelled")).at(-1)!.detail).toMatchObject({
      reason: "prerequisites_changed",
    });
  });

  it("zaten açık ülke yeniden 'açılamaz' (mevcut onay ezilmez); pencere açılmaz", async () => {
    await ready();
    await activateLiveCountries(db, valid(), deps());
    const before = await gb();
    const d = deps();
    expect(await kind(activateLiveCountries(db, valid({ documentRef: "BASKA-REF" }), d))).toBe(
      "activation_refused",
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(await gb()).toEqual(before);
  });

  it("EŞZAMANLI iki aktivasyon: ülke yalnızca BİR kez açılır, tek onay denetim kaydı", async () => {
    await ready();
    const a = activateLiveCountries(db, valid(), deps());
    const b = activateLiveCountries(db, valid({ documentRef: "IKINCI-REF" }), deps());
    const res = await Promise.allSettled([a, b]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ActivationError);
    expect((await audits("country_policy.live_approved")).length).toBe(1);
    expect((await gb()).locked).toBe(false);
  });
});

describe("mevcut korumalar GEVŞEMEZ: açılan ülkede bile adres/ülke kuralları geçerli; geri alınınca gönderim engellenir", () => {
  async function liveSeq(email: string) {
    const campaignId = await createCampaign(db, { mailboxId: boxId, status: "running", steps: 1 });
    const s = await addSequence(db, campaignId, { email });
    return { campaignId, ...s };
  }
  const codes = async (cl: number) =>
    (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: NOW })).reasons.map(
      (r) => r.code,
    );

  it("kilitliyken country_blocked; aktivasyondan sonra ülke engeli kalkar; kişi adlı adres yine reddedilir; geri alınca yine engel", async () => {
    await ready();
    const ok = await liveSeq(ALLOWED);
    const personal = await liveSeq("ayse.yilmaz@izinli-test.example");
    expect(await codes(ok.cl)).toContain("country_blocked");

    await activateLiveCountries(db, valid({ mode: "allowed" }), deps());
    expect(await codes(ok.cl)).not.toContain("country_blocked");
    expect(await codes(personal.cl)).toContain("email_personal"); // adres kuralı gevşemedi

    await revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW });
    expect(await codes(ok.cl)).toContain("country_blocked"); // her gönderimde ülke yeniden denetlenir
  });
});

describe("geri alma: önce kampanyalar duraklatılır, sonra ülke yeniden blocked + locked olur", () => {
  async function opened() {
    await ready();
    await activateLiveCountries(db, valid(), deps());
  }

  it("ülke blocked+locked olur, onay alanları temizlenir; denetim kaydı önceki onayı taşır", async () => {
    await opened();
    const prev = await gb();
    const r = await revokeLiveCountries(db, { countries: ["gb"], ack: true }, { now: NOW + 1 });
    expect(r.revoked).toEqual(["GB"]);
    expect(await gb()).toMatchObject({
      mode: "blocked",
      locked: true,
      approvalRef: null,
      approvedBy: null,
      approvedAt: null,
    });
    const a = (await audits("country_policy.live_revoked"))[0]!;
    expect(a.detail).toMatchObject({
      countryCode: "GB",
      previousApprovalRef: prev.approvalRef,
      previousApprovedBy: prev.approvedBy,
      to: { mode: "blocked", locked: true },
    });
  });

  it("açık onay (ack) olmadan ve zaten kilitli ülkede reddedilir; hiçbir şey değişmez", async () => {
    await opened();
    expect(await kind(revokeLiveCountries(db, { countries: ["GB"], ack: false }))).toBe(
      "activation_invalid",
    );
    expect((await gb()).locked).toBe(false);
    await revokeLiveCountries(db, { countries: ["GB"], ack: true });
    expect(await kind(revokeLiveCountries(db, { countries: ["GB"], ack: true }))).toBe(
      "activation_invalid",
    ); // zaten kilitli
    expect(await kind(revokeLiveCountries(db, { countries: ["ZZ"], ack: true }))).toBe(
      "activation_invalid",
    );
  });

  it("çalışan GERÇEK kutulu kampanyalar duraklar (country_revoked); demo ve kullanıcıyla duraklatılmış olanlar etkilenmez", async () => {
    await opened();
    const live = await createCampaign(db, { mailboxId: boxId, status: "running", steps: 1 });
    const demo = await createCampaign(db, { mailboxId: DEMO_MAILBOX, status: "running", steps: 1 });
    const user = await createCampaign(db, { mailboxId: boxId, status: "paused", steps: 1 });
    await db.update(campaigns).set({ pauseReason: "user" }).where(eq(campaigns.id, user));
    const r = await revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW });
    expect(r.pausedCampaigns).toEqual([live]);
    const by = async (id: number) =>
      (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]!;
    expect(await by(live)).toMatchObject({
      status: "paused",
      pauseReason: COUNTRY_REVOKED_PAUSE_REASON,
    });
    expect(await by(demo)).toMatchObject({ status: "running", pauseReason: null });
    expect(await by(user)).toMatchObject({ status: "paused", pauseReason: "user" });
    expect((await audits("country_policy.campaigns_paused")).length).toBe(1);
  });

  it("duraklatılan kampanya AÇIK onay olmadan sürdürülemez; alıcılar dışlanmadan bekler", async () => {
    await opened();
    const campaignId = await createCampaign(db, { mailboxId: boxId, status: "running", steps: 1 });
    const s = await addSequence(db, campaignId, { email: ALLOWED });
    await revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW });
    const err = await transitionCampaign(db, campaignId, "resume", { now: NOW + 5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect(err).toMatchObject({
      code: "restriction_ack_required",
      detail: { countryRevoked: true },
    });
    const row = (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!;
    expect(row.status).toBe("paused");
    // Alıcı dışlanmadı: dizi hâlâ eski durumunda.
    const cl = (await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl)))[0]!;
    expect(cl.status).not.toBe("excluded");
  });

  it("YARIŞ: aday geri almadan ÖNCE seçildi, gönderim SONRA denendi: alıcı DIŞLANMAZ (kampanya duraklı → atla)", async () => {
    await opened();
    const campaignId = await createCampaign(db, { mailboxId: boxId, status: "running", steps: 1 });
    const s = await addSequence(db, campaignId, { email: ALLOWED });
    // Dağıtıcı adayı seçti ... araya geri alma girdi ...
    await revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW });
    // ... ve gönderim anında uygunluk yeniden denetlendi.
    const ev = await evaluateSend(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: NOW + 1 });
    const c = ev.reasons.map((r) => r.code);
    expect(c).toContain("country_blocked"); // ülke yeniden denetlendi, engelli
    expect(c).toContain("campaign_not_active"); // kampanya duraklı
    expect(classifyReasons(ev.reasons, NOW + 1).action).toBe("skip"); // kalıcı dışlama (exclude) DEĞİL
  });

  it("EŞZAMANLI iki geri alma: tek başarı, tek denetim kaydı; geri alma ile aktivasyon yarışında tutarlı son durum", async () => {
    await opened();
    const res = await Promise.allSettled([
      revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW }),
      revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await audits("country_policy.live_revoked")).length).toBe(1);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });

    // Aktivasyon ve geri alma birlikte: ne olursa olsun satır CHECK kısıtlarına uygun ve denetim kayıtlarıyla tutarlı.
    const mix = await Promise.allSettled([
      activateLiveCountries(db, valid(), deps()),
      revokeLiveCountries(db, { countries: ["GB"], ack: true }, { now: NOW + 5 }),
    ]);
    const row = await gb();
    const open = row.mode !== "blocked";
    const acts = (await audits("country_policy.live_approved")).length;
    const revs = (await audits("country_policy.live_revoked")).length;
    expect(mix.some((m) => m.status === "fulfilled")).toBe(true);
    // Veritabanı değişmezi: kilitli satır yalnızca blocked olabilir; açık satırın onay alanları dolu olmalı.
    expect(row.locked).toBe(!open);
    if (open) expect(row.approvalRef && row.approvedBy && row.approvedAt).toBeTruthy();
    expect(acts + revs).toBeGreaterThanOrEqual(1);
  });
});

describe("durum (arayüz)", () => {
  it("yerel onay kanalı yoksa nativeConfirmAvailable false; ülkeler ve ön koşullar döner", async () => {
    await ready();
    const s = await getLiveCountryState(db, { now: NOW, env: {}, nativeConfirmAvailable: false });
    expect(s.nativeConfirmAvailable).toBe(false);
    expect(s.countries.find((c) => c.countryCode === "GB")).toMatchObject({
      mode: "blocked",
      locked: true,
    });
    expect(s.prerequisites.ok).toBe(true);
    expect(s.limits).toMatchObject({
      maxCountries: 10,
      documentMaxAgeDays: 90,
      selfTestMaxAgeDays: 30,
    });
  });
});
