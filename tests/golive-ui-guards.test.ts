import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as alertsRoute from "@/app/api/compliance/delivery-alerts/route";
import {
  basicsDirty,
  leavingHref,
  NEW_BASICS,
  stepsDirty,
  type BasicsValues,
} from "@/features/campaigns/wizard-dirty";
import { deliveryAlertText, deliveryAlertTone } from "@/features/compliance/delivery-alert-model";
import { changedFields, EMPTY_DRAFT, type Draft } from "@/features/templates/model";
import { editedSince, savePatch, saveSnapshot } from "@/features/templates/save-snapshot";
import type { Db } from "@/lib/db/client";
import { tr } from "@/lib/i18n/tr";
import { getSetting, setSetting } from "@/lib/settings";
import { VERIFICATION_TTL_MS } from "@/lib/unsubscribe/endpoint";
import {
  computeDeliveryAlerts,
  getDeliveryAlerts,
  PROOF_WARN_MS,
  type DeliveryAlertInput,
} from "@/lib/unsubscribe/delivery-alert";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";

/**
 * C13 (sihirbaz ve şablon düzenleyici kayıt korumaları) ve C14 (çıkış teslimat uyarı bandı): saf mantık, salt okunur
 * uç ve kaynak taramalı bağlantı denetimleri (DOM'suz).
 */

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

/* C13: kampanya sihirbazı ------------------------------------------------------------------------ */

const CAMPAIGN = {
  name: "Ekim",
  mailboxId: 1,
  sendWindow: { days: [1, 2, 3], start: "09:00", end: "17:00" },
  dailyCap: 20,
  minGapS: 90,
  maxGapS: 240,
};
const values = (over: Partial<BasicsValues> = {}): BasicsValues => ({
  ...CAMPAIGN,
  sendWindow: { ...CAMPAIGN.sendWindow, days: [...CAMPAIGN.sendWindow.days] },
  ...over,
});

describe("sihirbaz: kaydedilmemiş değişiklik", () => {
  it("temel ayarlar: aynı değerler temiz; her alan değişikliği kirli; gün sırası önemsiz", () => {
    expect(basicsDirty(CAMPAIGN, values())).toBe(false);
    expect(
      basicsDirty(
        CAMPAIGN,
        values({ sendWindow: { days: [3, 1, 2], start: "09:00", end: "17:00" } }),
      ),
    ).toBe(false);
    expect(basicsDirty(CAMPAIGN, values({ name: "Kasım" }))).toBe(true);
    expect(basicsDirty(CAMPAIGN, values({ mailboxId: 2 }))).toBe(true);
    expect(basicsDirty(CAMPAIGN, values({ dailyCap: 21 }))).toBe(true);
    expect(basicsDirty(CAMPAIGN, values({ minGapS: 91 }))).toBe(true);
    expect(basicsDirty(CAMPAIGN, values({ maxGapS: 300 }))).toBe(true);
    expect(
      basicsDirty(CAMPAIGN, values({ sendWindow: { days: [1, 2], start: "09:00", end: "17:00" } })),
    ).toBe(true);
    expect(
      basicsDirty(
        CAMPAIGN,
        values({ sendWindow: { days: [1, 2, 3], start: "10:00", end: "17:00" } }),
      ),
    ).toBe(true);
  });

  it("yeni kampanya: varsayılanlar temiz (otomatik seçilen kutu sayılmaz); ad yazılınca kirli", () => {
    expect(basicsDirty(null, { ...NEW_BASICS, mailboxId: 7 })).toBe(false);
    expect(basicsDirty(null, { ...NEW_BASICS, mailboxId: null })).toBe(false);
    expect(basicsDirty(null, { ...NEW_BASICS, mailboxId: 7, name: "Yeni" })).toBe(true);
    expect(basicsDirty(null, { ...NEW_BASICS, mailboxId: 7, dailyCap: 10 })).toBe(true);
  });

  it("adımlar: sıra önemsiz, ilk adımın gecikmesi yok sayılır; şablon/gecikme/dil farkı kirli", () => {
    const saved = [
      { stepIndex: 0, language: "en", templateId: 1, delayDays: 0 },
      { stepIndex: 1, language: "en", templateId: 2, delayDays: 5 },
    ];
    expect(stepsDirty(saved, [...saved].reverse())).toBe(false);
    expect(stepsDirty(saved, [{ ...saved[0]!, delayDays: 3 }, saved[1]!])).toBe(false);
    expect(stepsDirty(saved, [saved[0]!, { ...saved[1]!, templateId: 3 }])).toBe(true);
    expect(stepsDirty(saved, [saved[0]!, { ...saved[1]!, delayDays: 7 }])).toBe(true);
    expect(stepsDirty(saved, [saved[0]!])).toBe(true);
    expect(stepsDirty(saved, [...saved, { ...saved[0]!, language: "de" }])).toBe(true);
    expect(stepsDirty([], [])).toBe(false);
  });

  it("bağlantı koruması: yalnızca aynı kaynakta başka sayfaya giden düz tıklama yakalanır", () => {
    const here = "http://127.0.0.1:3000/campaigns/4/edit?step=basics";
    const click = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    const a = (href: string, target = "") => ({ href, target, hasDownload: false });
    expect(leavingHref(click, a("/campaigns"), here)).toBe("/campaigns");
    expect(leavingHref(click, a("http://127.0.0.1:3000/?campaign=4"), here)).toBe("/?campaign=4");
    expect(leavingHref(click, a("/campaigns/4/edit?step=steps"), here)).toBe(
      "/campaigns/4/edit?step=steps",
    );
    expect(leavingHref(click, a("#mailbox"), here)).toBeNull(); // yalnızca # değişikliği
    expect(leavingHref(click, a("https://example.com/"), here)).toBeNull();
    expect(leavingHref(click, a("/campaigns", "_blank"), here)).toBeNull();
    expect(leavingHref({ ...click, metaKey: true }, a("/campaigns"), here)).toBeNull();
    expect(leavingHref({ ...click, button: 1 }, a("/campaigns"), here)).toBeNull();
    expect(leavingHref({ ...click, defaultPrevented: true }, a("/campaigns"), here)).toBeNull();
    expect(leavingHref(click, { href: "/x.csv", target: "", hasDownload: true }, here)).toBeNull();
  });

  it("sihirbaz bağlantısı: adım geçişi korunur, kayıttan sonra koşulsuz; anahtar değişiklik varken sabit", () => {
    const src = read("src/features/campaigns/campaign-wizard.tsx");
    expect(src).toMatch(/if \(dirty\) setLeaveTo\(\{ step: s \}\)/);
    expect(src).toContain('onSaved={() => proceed("leads")}');
    expect(src).toContain('else proceed("steps")');
    expect(src).toContain("key={stepKey}");
    expect(src).not.toContain("key={campaign.updatedAt}");
    expect(src).toContain('addEventListener("beforeunload"');
    expect(src).toContain('document.addEventListener("click", onClick, true)');
    expect(src).toContain('confirmLabel={t("wizard.dirty.discard")}');
  });
});

/* C13: şablon düzenleyici ------------------------------------------------------------------------ */

describe("şablon düzenleyici: kayıt anlık görüntüsü", () => {
  const base: Draft = { ...EMPTY_DRAFT, name: "Ad", subject: "Konu", bodyHtml: "<p>Gövde</p>" };

  it("kayıt sürerken yazılanlar 'kaydedildi' sayılmaz ve bir sonraki kayıtta gönderilir", () => {
    const typed = { ...base, subject: "Konu 2" };
    const sent = saveSnapshot(5, 3, base, typed);
    expect(savePatch(sent)).toEqual({ subject: "Konu 2" });
    // Kayıt sürerken kullanıcı gövdeyi değiştirdi.
    const latest = { ...typed, bodyHtml: "<p>Gövde 2</p>" };
    expect(editedSince(sent, latest)).toBe(true);
    // Başarıdan sonra temel = GÖNDERİLEN taslak: gövde değişikliği hâlâ "değişti" görünür.
    expect(changedFields(sent.draft, latest)).toEqual({ bodyHtml: "<p>Gövde 2</p>" });
    expect(editedSince(sent, typed)).toBe(false);
  });

  it("anlık görüntü kopyadır; yeni şablonda temel sürüm 0", () => {
    const draft = { ...base };
    const sent = saveSnapshot(undefined, null, EMPTY_DRAFT, draft);
    draft.subject = "sonradan";
    expect(sent.draft.subject).toBe("Konu");
    expect(sent).toMatchObject({ id: undefined, baseVersion: 0 });
  });

  it("düzenleyici gönderilen görüntüyü kullanır (en son taslağı temel yapmaz)", () => {
    const src = read("src/features/templates/template-editor.tsx");
    expect(src).toContain("save.mutate(saveSnapshot(id, baseVersion, baseDraft, draft))");
    expect(src).toContain("setBaseDraft(sent.draft)");
    expect(src).not.toMatch(/setBaseDraft\(draft\)/);
    expect(src).toContain('toast.warning(t("tplEditor.editedWhileSaving"))');
  });
});

/* C14: çıkış teslimat uyarısı -------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const KID = "0123456789abcdef";
const BASE = "https://cikis.firma-ornek.com";
const input = (over: Partial<DeliveryAlertInput["endpoint"]> = {}, kid: string | null = KID) => ({
  endpoint: { baseUrl: BASE, verified: null, delivery: null, ...over },
  currentKid: kid,
});
const verifiedAt = (msBeforeExpiry: number) => NOW - VERIFICATION_TTL_MS + msBeforeExpiry;
const DAY = 86_400_000;

describe("çıkış teslimat uyarıları", () => {
  it("uç nokta yapılandırılmadıysa uyarı yok (bugünkü varsayılan)", () => {
    expect(computeDeliveryAlerts(input({ baseUrl: null }), NOW)).toEqual([]);
    expect(
      computeDeliveryAlerts(
        input({
          baseUrl: null,
          delivery: {
            checkedAt: NOW,
            ok: false,
            depth: 0,
            oldestAgeMs: null,
            corrupt: 0,
            code: "unreachable",
          },
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("son sağlık denetimi kötüyse uyarı; iyiyse yok", () => {
    const d = (ok: boolean, code: string) => ({
      checkedAt: NOW - 1000,
      ok,
      depth: 5000,
      oldestAgeMs: 10,
      corrupt: 0,
      code,
    });
    expect(computeDeliveryAlerts(input({ delivery: d(true, "ok") }), NOW)).toEqual([]);
    expect(computeDeliveryAlerts(input({ delivery: d(false, "queue_deep") }), NOW)).toEqual([
      { kind: "delivery_unhealthy", code: "queue_deep", checkedAt: NOW - 1000 },
    ]);
  });

  it("kanıt 5 gün içinde bitiyorsa 'bitiyor' (gün yukarı yuvarlanır), bittiyse 'bitti'; uzaksa yok", () => {
    const v = (ms: number, kid = KID, baseUrl = BASE) => ({
      verified: { baseUrl, kid, jti: "j", verifiedAt: verifiedAt(ms) },
    });
    expect(computeDeliveryAlerts(input(v(PROOF_WARN_MS + 1)), NOW)).toEqual([]);
    expect(computeDeliveryAlerts(input(v(PROOF_WARN_MS)), NOW)).toEqual([
      { kind: "proof_expiring", expiresAt: NOW + PROOF_WARN_MS, daysLeft: 5 },
    ]);
    expect(computeDeliveryAlerts(input(v(DAY / 2)), NOW)[0]).toMatchObject({
      kind: "proof_expiring",
      daysLeft: 1,
    });
    expect(computeDeliveryAlerts(input(v(0)), NOW)).toEqual([
      { kind: "proof_expired", expiredAt: NOW },
    ]);
    // Başka adres veya döndürülmüş anahtar: süre uyarısı değil (yeniden doğrulama uç nokta ekranında).
    expect(computeDeliveryAlerts(input(v(DAY, KID, "https://eski.example")), NOW)).toEqual([]);
    expect(computeDeliveryAlerts(input(v(DAY, "fedcba9876543210")), NOW)).toEqual([]);
    expect(computeDeliveryAlerts(input(v(DAY), null), NOW)).toEqual([]);
  });

  it("metin ve ton: kötü teslimat/bitmiş kanıt kırmızı, yaklaşan süre sarı", () => {
    expect(deliveryAlertTone([])).toBeNull();
    const expiring = { kind: "proof_expiring" as const, expiresAt: NOW + 2 * DAY, daysLeft: 2 };
    expect(deliveryAlertTone([expiring])).toBe("warning");
    expect(deliveryAlertTone([expiring, { kind: "proof_expired", expiredAt: NOW - DAY }])).toBe(
      "danger",
    );
    expect(deliveryAlertText(expiring)).toContain("2 gün");
    expect(
      deliveryAlertText({ kind: "delivery_unhealthy", code: "events_stale", checkedAt: NOW }),
    ).toContain(tr["deliveryAlert.unhealthy.events_stale"]);
    expect(
      deliveryAlertText({ kind: "delivery_unhealthy", code: "yeni_kod", checkedAt: NOW }),
    ).toContain(tr["deliveryAlert.unhealthy.other"]);
  });

  describe("salt okunur uç", () => {
    const HANDLE = "__umDbHandle";
    let client: Client;
    let db: Db;
    beforeEach(async () => {
      ({ client, db } = await openMemoryDb());
      await seedBase(db);
      (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
    });
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)[HANDLE];
      client.close();
    });

    it("saklanan kayıtlardan uyarı döner; hiçbir şey yazmaz, adres/anahtar döndürmez", async () => {
      const call = async () => {
        const r = await alertsRoute.GET(
          new Request("http://127.0.0.1:3000/api/compliance/delivery-alerts"),
          undefined,
        );
        return { status: r.status, text: await r.text() };
      };
      expect(await call()).toEqual({ status: 200, text: JSON.stringify({ alerts: [] }) });

      const x = "A".repeat(43);
      await setSetting(db, "mail.unsubscribeKeys", {
        current: KID,
        keys: [{ kid: KID, x, createdAt: 1, retiredAt: null, revokedAt: null }],
      });
      const now = Date.now();
      await setSetting(db, "mail.unsubscribeEndpoint", {
        baseUrl: BASE,
        pending: null,
        verified: {
          baseUrl: BASE,
          kid: KID,
          jti: "j",
          verifiedAt: now - VERIFICATION_TTL_MS + DAY,
        },
        lastAttempt: null,
        delivery: {
          checkedAt: now - 1000,
          ok: false,
          depth: 0,
          oldestAgeMs: null,
          corrupt: 0,
          code: "unreachable",
        },
      });
      const before = JSON.stringify(await getSetting(db, "mail.unsubscribeEndpoint"));
      const r = await call();
      expect(r.status).toBe(200);
      const alerts = (JSON.parse(r.text) as { alerts: { kind: string }[] }).alerts;
      expect(alerts.map((a) => a.kind).sort()).toEqual(["delivery_unhealthy", "proof_expiring"]);
      expect(r.text).not.toContain("cikis.firma-ornek.com");
      expect(r.text).not.toContain(KID);
      expect(JSON.stringify(await getSetting(db, "mail.unsubscribeEndpoint"))).toBe(before);
      expect((await getDeliveryAlerts(db, now)).length).toBe(2);

      // Anahtar iptal edildiyse süre uyarısı yok (kanıt zaten geçersiz; yeniden doğrulama gerekir).
      await setSetting(db, "mail.unsubscribeKeys", {
        current: KID,
        keys: [{ kid: KID, x, createdAt: 1, retiredAt: null, revokedAt: 2 }],
      });
      expect((await getDeliveryAlerts(db, now)).map((a) => a.kind)).toEqual(["delivery_unhealthy"]);
    });

    it("bant kampanyalar sayfasına bağlı ve ağa yalnızca bu yerel uçla çıkar", () => {
      expect(read("src/features/campaigns/campaigns-page.tsx")).toContain(
        "<DeliveryAlertBanner />",
      );
      const banner = read("src/features/compliance/delivery-alert.tsx");
      expect(banner).toContain('"/api/compliance/delivery-alerts"');
      expect(banner).not.toMatch(/\/health|\/verify|refetchInterval/);
      const lib = read("src/lib/unsubscribe/delivery-alert.ts");
      expect(lib).not.toMatch(/fetch|checkDeliveryHealth|setSetting|audit\(/);
    });
  });
});
