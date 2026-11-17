import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countryPolicies } from "@/lib/db/schema";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { applyLiveCountryApproval } from "@/lib/compliance/live-country-approval";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import {
  GMAIL_HEADER_TRUST_VERIFIED,
  LIVE_INBOX_READING_ENABLED,
  LIVE_SENDING_ENABLED,
  resolveCountryPolicy,
  seedCountryPolicies,
} from "@/lib/compliance/policies";
import { listCountryPolicies } from "@/lib/compliance/policy-service";
import { GmailInboxReader } from "@/lib/mail/gmail/inbox";
import { getLiveProvider, GmailProvider } from "@/lib/mail/gmail/provider";
import { buildEmailMessage, MessageBuildError } from "@/lib/mail/mime/message-builder";
import { ProviderUnavailableError } from "@/lib/mail/provider/provider";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * GÜVENLİ VARSAYILAN (fix/live-gates-fail-closed): gerçek canlı gönderim ve gerçek gelen kutusu okuma kapıları KAPALIDIR.
 * Bu dosyada HİÇBİR kapı, onay veya politika mock'lanmaz: yalnızca kodda yazılı gerçek sabitler sınanır. Kapı açık
 * senaryoları (çalışma anı korumaları) ilgili dosyalarda kapıyı yalnızca test içinde açarak sınanır; bu dosya, kapının
 * yanlışlıkla yeniden açılmasını bir "alarm teli" olarak yakalar. Kendime test gönder bu kapılardan bağımsızdır
 * (bkz. self-test-send.test.ts, orada da gerçek sabitler kapalıdır).
 */

const ADDRESS = "satis@firma-ornek.com";
const NOW = Date.parse("2026-11-17T10:00:00Z");

let t: TestDb;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  t = await createTestDb();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Bu testte ağ isteği ATILMAMALI.");
  });
});
afterEach(async () => {
  fetchSpy.mockRestore();
  await t.cleanup().catch(() => undefined);
});

describe("gerçek sabitler: güvenli varsayılan", () => {
  it("gönderim ve gelen kutusu okuma kapıları KAPALI; birleşik kapı kapalı; Gmail başlık güveni KAPALI", () => {
    expect(LIVE_SENDING_ENABLED).toBe(false);
    expect(LIVE_INBOX_READING_ENABLED).toBe(false);
    expect(GMAIL_HEADER_TRUST_VERIFIED).toBe(false);
    expect(isLiveSendingPermitted()).toBe(false);
  });

  it("yedi hukuki onay sabiti bu değişiklikte DEĞİŞMEDİ (yalnızca sayısı denetlenir; anlamları ayrı iş paketinde)", () => {
    expect(Object.keys(LEGAL_APPROVALS)).toHaveLength(7);
    // Onaylar tek başına gönderim açmaz: birleşik kapı bayrağı da ister.
    expect(isLiveSendingPermitted()).toBe(false);
  });
});

describe("kapı kapalıyken gerçek gönderim yolu hiçbir G/Ç yapmaz", () => {
  it("Gmail sağlayıcısı (varsayılan kapı): reddeder, ne Gmail'e ne OAuth'a istek atar", async () => {
    const p = new GmailProvider({ db: t.db, mailbox: { id: 1, address: ADDRESS } });
    const r = await p.send({
      raw: "From: x\r\n\r\nx",
      from: ADDRESS,
      to: "kisi@alici-ornek.com",
      messageId: "<a@firma-ornek.com>",
      signal: new AbortController().signal,
    });
    expect(r).toEqual({ status: "rejected", code: "live_sending_disabled", permanent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("canlı sağlayıcı fabrikası bağdaştırıcıyı hiç kurmaz", () => {
    expect(() => getLiveProvider(t.db, { id: 1, provider: "gmail", address: ADDRESS })).toThrow(
      ProviderUnavailableError,
    );
  });

  it("ileti oluşturucu: canlı kipte (kendine test hariç) ileti oluşturulmaz", () => {
    const base = {
      composed: {
        sendable: true,
        errors: [],
        subject: "x",
        html: "<p>x</p>",
        text: "x",
        language: "en",
      },
      mailbox: { provider: "gmail", address: ADDRESS, status: "connected" },
      profile: { contactName: "Ayşe", legalName: "Örnek A.Ş." },
      mode: "live" as const,
      now: NOW,
      recipient: "kisi@alici-ornek.com",
    };
    expect(() => buildEmailMessage(base as never)).toThrow(MessageBuildError);
    expect(() => buildEmailMessage(base as never)).toThrow(
      expect.objectContaining({ kind: "live_sending_disabled" }),
    );
  });

  it("gerçek gelen kutusu okuyucusu: kapalıyken hiçbir G/Ç yapmaz", async () => {
    const reader = new GmailInboxReader({ db: t.db });
    await expect(reader.fetch(1, null, 10)).rejects.toMatchObject({
      code: "live_inbox_disabled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("kapı, ülke kilidinden ayrı bir ek katmandır (ülke kilidi gevşetilmedi)", () => {
  it("seed canlı ülkeleri engelli ve kilitli ekler; çözümleyici kapı kapalıyken engelli döner", async () => {
    await seedCountryPolicies(t.db, NOW);
    const rows = await t.db.select().from(countryPolicies).where(eq(countryPolicies.scope, "live"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect({ m: r.mode, l: r.locked }).toEqual({ m: "blocked", l: true });
    expect(await resolveCountryPolicy(t.db, "live", "GB")).toEqual({
      mode: "blocked",
      reason: "live_disabled",
    });
  });

  it("ülke kilidi kayıtlı onayla açılsa bile kapı kapalıyken canlı kapsam engelli kalır", async () => {
    await seedCountryPolicies(t.db, NOW);
    await applyLiveCountryApproval(
      t.db,
      {
        countries: ["GB"],
        mode: "allowed",
        approvalRef: "TEST-REF-0001",
        approvedBy: "Test Yetkilisi",
      },
      { now: NOW },
    );
    const live = await listCountryPolicies(t.db, "live");
    const gb = live.find((p) => p.countryCode === "GB");
    expect(gb).toMatchObject({ storedMode: "allowed", mode: "blocked" });
    expect(await resolveCountryPolicy(t.db, "live", "GB")).toEqual({
      mode: "blocked",
      reason: "live_disabled",
    });
  });
});
