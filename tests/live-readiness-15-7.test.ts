import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes, settings } from "@/lib/db/schema";
import { checkDomainAuth, type DnsReport, type TxtResolver } from "@/lib/mail/dns-check";
import {
  DNS_FRESH_MS,
  clearDnsReport,
  evaluateDnsReadiness,
  recordDnsReport,
} from "@/lib/mail/dns-store";
import { createGmailMailbox, deleteMailbox } from "@/lib/mail/mailbox-service";
import { getSetting, setSetting } from "@/lib/settings";
import { checkDeliveryHealth, setUnsubscribeBaseUrl } from "@/lib/unsubscribe/endpoint";
import { ensureChannelKey } from "@/lib/unsubscribe/channel";
import { ensureSigningKey } from "@/lib/unsubscribe/keys";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW } from "./helpers/inbound-fixture";

/**
 * Canlı hazırlık ekranı (Aşama 15.7): DNS sonuçlarının saklanması ve yeni kontroller. Ağ yok: DNS çözümleyicisi
 * sahte; yalnızca saklanan KAYITLARDAN türeyen durumlar sınanır. Hiçbir kapı açılmaz.
 */

const ADDRESS = "satis@firma-ornek.com";
const DOMAIN = "firma-ornek.com";

let client: Client;
let db: Db;
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-ready-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});
afterEach(() => {
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function realMailbox(address = ADDRESS) {
  const { id } = await createGmailMailbox(db, { label: "Satış", address });
  await db
    .update(mailboxes)
    .set({ status: "connected", credentialsRef: "x", connectedAt: NOW })
    .where(eq(mailboxes.id, id));
  return id;
}

/** Sahte TXT çözümleyici (ağ yok). */
const resolver = (map: Record<string, string[]>): TxtResolver => ({
  resolveTxt: async (name) => {
    if (!(name in map)) throw Object.assign(new Error("yok"), { code: "ENOTFOUND" });
    return map[name]!.map((r) => [r]);
  },
});
const GOOD: Record<string, string[]> = {
  [DOMAIN]: ["v=spf1 include:_spf.google.com -all"],
  [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=reject; rua=mailto:d@firma-ornek.com"],
  [`google._domainkey.${DOMAIN}`]: ["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"],
};
const report = (map = GOOD, selector: string | null = "google") =>
  checkDomainAuth(DOMAIN, { selector, resolver: resolver(map) });
const by = async (now = NOW) =>
  Object.fromEntries((await getLiveReadiness(db, { now })).items.map((i) => [i.key, i.status]));

describe("DNS sonuçlarının saklanması", () => {
  it("gerçek denetim kutunun kendi alan adı için saklanır; yalnızca durumlar ve kodlar (ham TXT yok)", async () => {
    const id = await realMailbox();
    const r = await report();
    expect(r.mode).toBe("checked");
    expect(await recordDnsReport(db, { id, address: ADDRESS }, r, NOW)).toBe(true);
    const stored = (await getSetting(db, "mail.dnsReports"))[String(id)]!;
    expect(stored).toMatchObject({
      domain: DOMAIN,
      checkedAt: NOW,
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    });
    const dump = JSON.stringify(await db.select().from(settings));
    expect(dump).not.toContain("MIGfMA0GCSq");
    expect(dump).not.toContain("_spf.google.com");
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(DOMAIN);
  });

  it("saklanmaz: demo rapor, başka alan adı, alan adsız kutu, denetlenmemiş", async () => {
    const id = await realMailbox();
    const demo: DnsReport = { mode: "demo", domain: null, spf: null, dkim: null, dmarc: null };
    expect(await recordDnsReport(db, { id, address: ADDRESS }, demo, NOW)).toBe(false);
    const other = await checkDomainAuth("baska-alan.com", { resolver: resolver({}) });
    expect(await recordDnsReport(db, { id, address: ADDRESS }, other, NOW)).toBe(false);
    expect(await recordDnsReport(db, { id, address: null }, await report(), NOW)).toBe(false);
    expect(await recordDnsReport(db, { id, address: "x@baska.example" }, await report(), NOW)).toBe(
      false,
    );
    expect(await getSetting(db, "mail.dnsReports")).toEqual({});
  });

  it("ayrılmış alan adı (.invalid/.test) 'demo' rapor döndürür ve alan adı kutununkiyle AYNI olsa bile saklanmaz", async () => {
    const id = 77; // kutu servisi ayrılmış alan adlı gerçek kutuyu zaten reddeder; saklama katmanı da bağımsız savunur
    const r = await checkDomainAuth("firma.invalid", { resolver: resolver({}) });
    expect(r).toMatchObject({ mode: "demo", domain: "firma.invalid" });
    expect(await recordDnsReport(db, { id, address: "satis@firma.invalid" }, r, NOW)).toBe(false);
    expect(await getSetting(db, "mail.dnsReports")).toEqual({});
  });

  it("kutu silinince/temizlenince kayıt kalmaz", async () => {
    const id = await realMailbox();
    await recordDnsReport(db, { id, address: ADDRESS }, await report(), NOW);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, id));
    await deleteMailbox(db, id, NOW);
    expect(await getSetting(db, "mail.dnsReports")).toEqual({});
    const id2 = await realMailbox("diger@firma-ornek.com");
    await recordDnsReport(
      db,
      { id: id2, address: "diger@firma-ornek.com" },
      await checkDomainAuth(DOMAIN, { resolver: resolver(GOOD) }).then((r) => ({
        ...r,
        domain: "firma-ornek.com",
      })),
      NOW,
    );
    await clearDnsReport(db, id2);
    await clearDnsReport(db, 9999); // yok: zararsız
    expect(await getSetting(db, "mail.dnsReports")).toEqual({});
  });
});

describe("dns_auth hazırlık durumu (yalnızca saklanan sonuçtan)", () => {
  it("gerçek kutu yok → bilinmiyor; kutu var ama denetim yok → bilinmiyor", async () => {
    expect((await by()).dns_auth).toBe("unknown");
    await realMailbox();
    expect((await by()).dns_auth).toBe("unknown");
  });

  const cases: [string, Record<string, string[]>, string | null, "ok" | "blocked" | "unknown"][] = [
    ["üçü de geçer", GOOD, "google", "ok"],
    ["SPF yok → fail", { ...GOOD, [DOMAIN]: [] }, "google", "blocked"],
    ["DMARC yok → fail", { ...GOOD, [`_dmarc.${DOMAIN}`]: [] }, "google", "blocked"],
    ["DKIM yok → fail", { ...GOOD, [`google._domainkey.${DOMAIN}`]: [] }, "google", "blocked"],
    [
      "DMARC yalnızca izleme (uyarı) → doğrulanmadı",
      { ...GOOD, [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=none"] },
      "google",
      "unknown",
    ],
    ["DKIM seçici verilmedi → doğrulanmadı", GOOD, null, "unknown"],
  ];
  it.each(cases)("%s", async (_n, map, selector, expected) => {
    const id = await realMailbox();
    await recordDnsReport(db, { id, address: ADDRESS }, await report(map, selector), NOW);
    expect((await by()).dns_auth).toBe(expected);
  });

  it("bayat sonuç → bilinmiyor; kutunun alan adı değiştiyse → bilinmiyor; gelecekteki kayıt geçersiz", async () => {
    const id = await realMailbox();
    await recordDnsReport(db, { id, address: ADDRESS }, await report(), NOW);
    expect((await by(NOW + DNS_FRESH_MS - 1000)).dns_auth).toBe("ok");
    expect((await by(NOW + DNS_FRESH_MS + 1000)).dns_auth).toBe("unknown");
    expect((await by(NOW - 3600_000)).dns_auth).toBe("unknown");
    await db.update(mailboxes).set({ address: "satis@baska-alan.com" }).where(eq(mailboxes.id, id));
    expect((await by()).dns_auth).toBe("unknown");
  });

  it("birden çok kutu: biri başarısızsa engel, biri eksikse bilinmiyor, hepsi geçerse tamam", async () => {
    const a = await realMailbox();
    const b = await realMailbox("diger@firma-ornek.com");
    await recordDnsReport(db, { id: a, address: ADDRESS }, await report(), NOW);
    expect((await by()).dns_auth).toBe("unknown"); // b eksik
    await recordDnsReport(db, { id: b, address: "diger@firma-ornek.com" }, await report(), NOW);
    expect((await by()).dns_auth).toBe("ok");
    await recordDnsReport(
      db,
      { id: b, address: "diger@firma-ornek.com" },
      await report({ ...GOOD, [DOMAIN]: [] }),
      NOW,
    );
    expect((await by()).dns_auth).toBe("blocked");
  });

  it("evaluateDnsReadiness doğrudan: kutu listesi boşsa bilinmiyor", async () => {
    expect(await evaluateDnsReadiness(db, [], NOW)).toBe("unknown");
  });
});

describe("yeni hazırlık maddeleri (hiçbiri varsayımla 'tamam' olmaz)", () => {
  it("varsayılan: canlı gelen kutusu kilidi ve Gmail başlık güveni ENGEL; teslimat engel; çıkış uç noktası engel", async () => {
    const s = await by();
    expect(s).toMatchObject({
      live_inbox_flag: "blocked",
      inbox_header_trust: "blocked",
      event_delivery: "blocked",
      https_unsubscribe: "blocked",
      live_flag: "blocked",
    });
    expect((await getLiveReadiness(db, { now: NOW })).allOk).toBe(false);
  });

  it("teslimat: adres+kanal anahtarı yoksa engel; denetlenmediyse bilinmiyor; sağlıklıysa tamam; bayatsa bilinmiyor", async () => {
    await ensureSigningKey(db, NOW);
    await ensureChannelKey(db, NOW);
    expect((await by()).event_delivery).toBe("blocked"); // adres yok
    await setUnsubscribeBaseUrl(db, "https://cikis.firma-ornek.com", NOW);
    expect((await by()).event_delivery).toBe("unknown");
    await checkDeliveryHealth(
      db,
      { getStats: async () => ({ depth: 0, oldestAgeMs: null, corrupt: 0 }) },
      NOW,
    );
    expect((await by(NOW + 1000)).event_delivery).toBe("ok");
    expect((await by(NOW + 25 * 3600_000)).event_delivery).toBe("unknown");
    await checkDeliveryHealth(
      db,
      { getStats: async () => ({ depth: 3, oldestAgeMs: 2 * 3600_000, corrupt: 0 }) },
      NOW,
    );
    expect((await by(NOW + 1000)).event_delivery).toBe("blocked");
  });

  it("kullanıcı beyanıyla/ayar yazmayla çıkış uç noktası 'tamam' OLMAZ; kanıt olsa bile sürüm kapısı (LEGAL_APPROVALS) da gerekir", async () => {
    expect(LEGAL_APPROVALS.httpsUnsubscribeEndpoint).toBe(false);
    await ensureSigningKey(db, NOW);
    const kid = (await getSetting(db, "mail.unsubscribeKeys")).current!;
    await setSetting(db, "mail.unsubscribeEndpoint", {
      baseUrl: "https://cikis.firma-ornek.com",
      pending: null,
      verified: { baseUrl: "https://cikis.firma-ornek.com", kid, jti: "x", verifiedAt: NOW },
      lastAttempt: null,
      delivery: null,
    });
    expect((await by(NOW + 1000)).https_unsubscribe).toBe("blocked"); // kanıt (sahte) olsa da sürüm kapısı kapalı
  });

  it("okuma yalnızdır: hazırlık değerlendirmesi hiçbir ayar/denetim kaydı yazmaz", async () => {
    await realMailbox();
    const before = JSON.stringify([
      await db.select().from(settings),
      await db.select().from(auditLog),
    ]);
    await getLiveReadiness(db, { now: NOW });
    await getLiveReadiness(db, { now: NOW + 5 });
    expect(
      JSON.stringify([await db.select().from(settings), await db.select().from(auditLog)]),
    ).toBe(before);
  });
});
