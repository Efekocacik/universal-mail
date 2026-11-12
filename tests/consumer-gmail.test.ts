import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dnsRoute from "@/app/api/mailboxes/[id]/dns-check/route";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes } from "@/lib/db/schema";
import {
  domainOfAddress,
  isConsumerGmailAddress,
  isConsumerGmailDomain,
} from "@/lib/mail/consumer-gmail";
import { checkDomainAuth, type TxtResolver } from "@/lib/mail/dns-check";
import { evaluateDnsReadiness, isDnsProviderManaged, recordDnsReport } from "@/lib/mail/dns-store";
import { createGmailMailbox, MailboxServiceError } from "@/lib/mail/mailbox-service";
import { classifyReasons } from "@/lib/mail/scheduler/dispatcher";
import {
  CONSUMER_GMAIL_MAX_DAILY,
  CONSUMER_GMAIL_WARMUP_BASE_PER_DAY,
  effectiveMailboxCap,
  mailboxLimitProfile,
  MAX_DAILY_PER_MAILBOX,
  warmupCeiling,
  WEEK_MS,
} from "@/lib/mail/scheduler/throttle";
import { REAUTH_DEFER_MS } from "@/lib/mail/send-service";
import { getSetting } from "@/lib/settings";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW } from "./helpers/inbound-fixture";

/**
 * Kişisel Gmail (@gmail.com / @googlemail.com) gönderen desteği: sağlayıcı yönetimli DNS, sıkı gönderim sınırları,
 * adres doğrulama ve arayüze giden alanlar. Workspace/kendi alan adı için katı kural korunur. Ağ yok (fetch casusu).
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
const CONSUMER = "firma.ornek@gmail.com";
const WORKSPACE = "satis@firma-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-consumer-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "cd".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function connectedBox(address: string): Promise<number> {
  const { id } = await createGmailMailbox(db, { label: "Satış", address });
  await db
    .update(mailboxes)
    .set({ status: "connected", credentialsRef: "x", connectedAt: NOW })
    .where(eq(mailboxes.id, id));
  return id;
}

/** Her sorguyu kaydeden sahte çözümleyici (ağ yok). */
function spyResolver(map: Record<string, string[]> = {}) {
  const names: string[] = [];
  const resolver: TxtResolver = {
    resolveTxt: async (name) => {
      names.push(name);
      if (!(name in map)) throw Object.assign(new Error("yok"), { code: "ENOTFOUND" });
      return map[name]!.map((r) => [r]);
    },
  };
  return { resolver, names };
}

const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

describe("kişisel Gmail alan adı tanıma", () => {
  it("gmail.com ve googlemail.com (büyük/küçük harf, sondaki nokta) tanınır; Workspace/başka alan adı tanınmaz", () => {
    expect(isConsumerGmailDomain("gmail.com")).toBe(true);
    expect(isConsumerGmailDomain("GoogleMail.com.")).toBe(true);
    expect(isConsumerGmailAddress("Firma.Ornek@Gmail.com")).toBe(true);
    expect(isConsumerGmailAddress(WORKSPACE)).toBe(false);
    expect(isConsumerGmailDomain("gmail.com.tr")).toBe(false);
    expect(isConsumerGmailDomain("mail.gmail.com")).toBe(false);
    expect(isConsumerGmailAddress(null)).toBe(false);
    expect(domainOfAddress("a@B.com")).toBe("b.com");
    expect(domainOfAddress("yok")).toBeNull();
  });
});

describe("DNS denetimi: sağlayıcı yönetimli sonuç", () => {
  it.each(["gmail.com", "googlemail.com", "GMAIL.COM"])(
    "%s için HİÇBİR sorgu atılmadan 'managed' döner (seçici verilse bile)",
    async (domain) => {
      const { resolver, names } = spyResolver();
      const r = await checkDomainAuth(domain, { selector: "google", resolver });
      expect(r).toEqual({
        mode: "managed",
        domain: domain.toLowerCase(),
        spf: null,
        dkim: null,
        dmarc: null,
      });
      expect(names).toEqual([]);
    },
  );

  it("Workspace/kendi alan adı katı kalır: gerçek sorgular atılır, kayıt yoksa fail", async () => {
    const { resolver, names } = spyResolver();
    const r = await checkDomainAuth("firma-ornek.com", { selector: "google", resolver });
    expect(r.mode).toBe("checked");
    expect(r.spf?.status).toBe("fail");
    expect(r.dmarc?.status).toBe("fail");
    expect(r.dkim?.status).toBe("fail");
    expect(names.sort()).toEqual(
      ["firma-ornek.com", "_dmarc.firma-ornek.com", "google._domainkey.firma-ornek.com"].sort(),
    );
  });

  it("yönetimli sonuç saklanmaz (kanıt değildir) ama hazırlık için gerekmez", async () => {
    const id = await connectedBox(CONSUMER);
    const r = await checkDomainAuth("gmail.com", { resolver: spyResolver().resolver });
    expect(await recordDnsReport(db, { id, address: CONSUMER }, r, NOW)).toBe(false);
    expect(await getSetting(db, "mail.dnsReports")).toEqual({});
    expect(await evaluateDnsReadiness(db, [{ id, address: CONSUMER }], NOW)).toBe("ok");
  });

  it("DNS denetim ucu: kişisel Gmail kutusu 'managed' döner, ağ yok; denetim kaydı mode=managed", async () => {
    const id = await connectedBox(CONSUMER);
    const res = await dnsRoute.POST(req("POST", `/api/mailboxes/${id}/dns-check`, {}), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "managed", domain: "gmail.com" });
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "dns.checked"));
    expect(audits.at(-1)?.detail).toMatchObject({ mode: "managed" });
  });
});

describe("DNS hazırlığı (hazırlık ekranı ve gönderim kapısı aynı ölçüt)", () => {
  it("kişisel Gmail kutusu kayıt aranmadan 'ok'; Workspace kutusu kayıtsız 'unknown'", async () => {
    const g = await connectedBox(CONSUMER);
    const w = await connectedBox(WORKSPACE);
    expect(isDnsProviderManaged({ address: CONSUMER })).toBe(true);
    expect(isDnsProviderManaged({ address: WORKSPACE })).toBe(false);
    expect(await evaluateDnsReadiness(db, [{ id: g, address: CONSUMER }], NOW)).toBe("ok");
    expect(await evaluateDnsReadiness(db, [{ id: w, address: WORKSPACE }], NOW)).toBe("unknown");
    // Karışık: Workspace kutusu doğrulanmadıkça bütünü "tamam" değildir.
    expect(
      await evaluateDnsReadiness(
        db,
        [
          { id: g, address: CONSUMER },
          { id: w, address: WORKSPACE },
        ],
        NOW,
      ),
    ).toBe("unknown");
  });

  it("hazırlık ekranı: yalnızca kişisel Gmail bağlıysa dns_auth 'ok' + provider_managed açıklaması", async () => {
    await connectedBox(CONSUMER);
    const item = (await getLiveReadiness(db, { now: NOW })).items.find((i) => i.key === "dns_auth");
    expect(item).toEqual({
      key: "dns_auth",
      status: "ok",
      owner: "external",
      detail: "provider_managed",
    });
  });

  it("hazırlık ekranı: Workspace kutusu eklenince katı kural geri gelir (açıklama yok)", async () => {
    await connectedBox(CONSUMER);
    await connectedBox(WORKSPACE);
    const item = (await getLiveReadiness(db, { now: NOW })).items.find((i) => i.key === "dns_auth");
    expect(item).toEqual({ key: "dns_auth", status: "unknown", owner: "external" });
  });
});

describe("gönderim sınırları: kişisel Gmail daha sıkı", () => {
  const T = Date.UTC(2026, 0, 5);
  const consumer = { address: CONSUMER, warmupStep: 10, warmupStartedAt: T };
  const workspace = { address: WORKSPACE, warmupStep: 10, warmupStartedAt: T };

  it("profil: kişisel Gmail 10'dan başlar, en çok 5/hafta artar, günde en çok 50; Workspace değişmedi", () => {
    expect(mailboxLimitProfile({ address: CONSUMER })).toMatchObject({
      kind: "consumer_gmail",
      warmupBase: CONSUMER_GMAIL_WARMUP_BASE_PER_DAY,
      maxDaily: CONSUMER_GMAIL_MAX_DAILY,
    });
    expect(CONSUMER_GMAIL_WARMUP_BASE_PER_DAY).toBe(10);
    expect(CONSUMER_GMAIL_MAX_DAILY).toBe(50);
    expect(CONSUMER_GMAIL_MAX_DAILY).toBeLessThan(100);
    expect(mailboxLimitProfile({ address: WORKSPACE })).toMatchObject({
      kind: "standard",
      warmupBase: 20,
      maxDaily: MAX_DAILY_PER_MAILBOX,
    });
    expect(mailboxLimitProfile({})).toMatchObject({ kind: "standard" });
  });

  it("ısınma tavanı ve geçerli tavan", () => {
    expect(warmupCeiling({ ...consumer, warmupStartedAt: null }, T)).toBe(10);
    expect(warmupCeiling(consumer, T + WEEK_MS - 1)).toBe(10);
    expect(warmupCeiling(consumer, T + WEEK_MS)).toBe(15); // adım 10 istense de 5 ile sınırlı
    expect(warmupCeiling(consumer, T + 30 * WEEK_MS)).toBe(50);
    expect(warmupCeiling(workspace, T + WEEK_MS)).toBe(30);
    expect(effectiveMailboxCap({ ...consumer, dailyCap: 20 }, T)).toBe(10);
    expect(effectiveMailboxCap({ ...consumer, dailyCap: 80 }, T + 99 * WEEK_MS)).toBe(50);
    expect(effectiveMailboxCap({ ...workspace, dailyCap: 80 }, T + 99 * WEEK_MS)).toBe(80);
  });
});

describe("posta kutusu ekleme", () => {
  it("kişisel Gmail ve googlemail adresi eklenebilir (küçük harfe çevrilir, noktalar korunur)", async () => {
    const a = await createGmailMailbox(db, { label: "Kişisel", address: "Firma.Ornek@Gmail.com" });
    const b = await createGmailMailbox(db, { label: "Eski", address: "ihracat@googlemail.com" });
    const rows = await db.select().from(mailboxes);
    expect(rows.find((r) => r.id === a.id)?.address).toBe("firma.ornek@gmail.com");
    expect(rows.find((r) => r.id === b.id)?.address).toBe("ihracat@googlemail.com");
  });

  it("kişisel Gmail'de '+etiket' birincil adres olamaz → invalid_email; Workspace'te kabul edilir", async () => {
    const e = await createGmailMailbox(db, {
      label: "Etiket",
      address: "firma+satis@gmail.com",
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailboxServiceError);
    expect((e as MailboxServiceError).kind).toBe("invalid_email");
    await expect(
      createGmailMailbox(db, { label: "WS", address: "satis+eu@firma-ornek.com" }),
    ).resolves.toMatchObject({ id: expect.any(Number) });
  });
});

describe("kutu listesi ucu", () => {
  it("kişisel Gmail işareti, bugünkü tavan ve yeniden bağlanma gerekliliği döner; sır/hata metni yok", async () => {
    const g = await connectedBox(CONSUMER);
    const w = await connectedBox(WORKSPACE);
    await db
      .update(mailboxes)
      .set({ status: "error", lastError: "reauthorization_required" })
      .where(eq(mailboxes.id, w));
    const res = await mailboxesRoute.GET(req("GET", "/api/mailboxes"), undefined);
    const text = await res.text();
    const items = (JSON.parse(text) as { items: Record<string, unknown>[] }).items;
    expect(items.find((i) => i.id === g)).toMatchObject({
      consumerGmail: true,
      reauthorizationRequired: false,
      limits: { todayCap: 10, warmupBase: 10, maxDaily: 20 },
    });
    expect(items.find((i) => i.id === w)).toMatchObject({
      consumerGmail: false,
      reauthorizationRequired: true,
      limits: { todayCap: 20, warmupBase: 20, maxDaily: 20 },
    });
    expect(text).not.toContain("credentials");
    expect(text).not.toContain("lastError");
  });
});

describe("yeniden yetkilendirme: dağıtıcı sınıflandırması", () => {
  it("yalnızca kutunun yeniden bağlanması bekleniyorsa ERTELE (duraklatma yok)", () => {
    expect(
      classifyReasons([{ code: "mailbox_not_ready", detail: "reauthorization_required" }], NOW),
    ).toEqual({ action: "defer", retryAt: NOW + REAUTH_DEFER_MS });
  });

  it("başka bir duraklatma nedeni varsa veya kutu başka nedenle hazır değilse DURAKLAT (önceki davranış)", () => {
    expect(classifyReasons([{ code: "mailbox_not_ready", detail: "not_configured" }], NOW)).toEqual(
      { action: "pause" },
    );
    expect(
      classifyReasons(
        [
          { code: "mailbox_not_ready", detail: "reauthorization_required" },
          { code: "sender_profile_incomplete" },
        ],
        NOW,
      ),
    ).toEqual({ action: "pause" });
  });
});
