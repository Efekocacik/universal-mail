import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeStartPlan } from "@/lib/campaigns/preflight";
import { evaluateEnrollment } from "@/lib/compliance/eligibility";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { applyLiveCountryApproval } from "@/lib/compliance/live-country-approval";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import {
  GMAIL_HEADER_TRUST_VERIFIED,
  LIVE_INBOX_READING_ENABLED,
  LIVE_SENDING_ENABLED,
  resolveCountryPolicy,
} from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, countryPolicies, mailboxes, messages } from "@/lib/db/schema";
import { DNS_FRESH_MS } from "@/lib/mail/dns-store";
import type { MailProvider } from "@/lib/mail/provider/provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { DNS_GATE_RETRY_MS, sendCampaignStep } from "@/lib/mail/send-service";
import { getSetting, setSetting } from "@/lib/settings";
import {
  HttpEventSource,
  createSpoolPullHandler,
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
} from "@/lib/unsubscribe/channel";
import { setUnsubscribeBaseUrl, verifyOneClickEndpoint } from "@/lib/unsubscribe/endpoint";
import { ensureSigningKey, loadPublicKeys } from "@/lib/unsubscribe/keys";
import { createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool } from "@/lib/unsubscribe/spool";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { recordPassingDns } from "./helpers/dns-fixture";
import { enableHealthyDrain } from "./helpers/drain-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

/**
 * Kapı açma sürümü (release/live-gates, sahip kararı 11 Kasım 2026). Bu dosyada HİÇBİR kilit, onay, uygunluk veya
 * ülke politikası mock'lanmaz: gerçek sabitlerle (gönderim ve okuma kapısı açık, yedi onay `true`, başlık güveni
 * kapalı) gerçek bir canlı kampanya, çalışma anı hazırlığı tamamlanmadan ve sahip ülke kilidini
 * `scripts/approve-live-country.ts` ile açmadan GÖNDERMEZ. Sağlayıcı sahte; ağ yok.
 */

const BASE = "https://cikis.firma-ornek.com";
const ADDRESS = "satis@firma-ornek.com";
const RECIPIENT = "info@alici-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let gid: number;
let calls: number;
let provider: MailProvider;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY", "UM_UNSUBSCRIBE_DRAIN_ENABLED"])
    saved[k] = process.env[k];
  delete process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-gatesopen-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ef".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
  calls = 0;
  provider = {
    id: "gmail",
    send: async () => {
      calls++;
      return { status: "accepted", providerMessageId: `gm${calls}`, acceptedAt: T0 };
    },
  };
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

/** Süreç içi aktarıcıyla uçtan uca doğrulanmış HTTPS tek tıklamalı çıkış uç noktası (ağ yok). */
async function verifiedEndpoint(): Promise<void> {
  const spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => T0 });
  const relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => T0 });
  const pull = createSpoolPullHandler({
    spool,
    keys: () => exportChannelPublicKeys(db),
    now: () => T0,
  });
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url as string, init);
    const p = new URL(req.url).pathname;
    if (p.startsWith("/u/")) return relay(req);
    if (p.startsWith("/spool/")) return pull(req);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  await ensureSigningKey(db, T0);
  await ensureChannelKey(db, T0);
  await setUnsubscribeBaseUrl(db, BASE, T0);
  const signer = (await getChannelSigner(db))!;
  const source = new HttpEventSource({
    baseUrl: BASE,
    kid: signer.kid,
    privateKey: signer.privateKey,
    now: () => T0,
    fetch: net,
  });
  const r = await verifyOneClickEndpoint(db, {
    source,
    fetch: net,
    now: () => T0,
    sleep: async () => undefined,
    attempts: 2,
  });
  expect(r.ok).toBe(true);
}

/** Ülke kilidi DIŞINDAKİ her çalışma anı hazırlığı: Gmail bağlı + gönderim izni, uç nokta, çekme, DNS. */
async function readyExceptCountry(): Promise<void> {
  await setSetting(db, "mail.gmailGrants", { [String(gid)]: { send: true, read: false, at: T0 } });
  await verifiedEndpoint();
  await enableHealthyDrain(db, T0);
  await recordPassingDns(db, gid, T0);
}

/** `scripts/approve-live-country.ts --apply` ile aynı işlev (sahibin son adımı). */
const unlockGB = () =>
  applyLiveCountryApproval(
    db,
    {
      countries: ["GB"],
      mode: "allowed",
      approvalRef: "SAHIP-KARARI-2026-11-11",
      approvedBy: "Şirket sahibi",
    },
    { now: T0 },
  );

const send = (cl: number, now = T0) =>
  sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { now: () => now, provider });
const codes = (o: { reasons?: { code: string }[] }) => (o.reasons ?? []).map((r) => r.code);
const outRows = () => db.select().from(messages).where(eq(messages.direction, "out"));

describe("sürüm kapıları (gerçek sabitler)", () => {
  it("gönderim ve okuma kapısı açık, yedi onay true; Gmail başlık güveni KAPALI kalır", () => {
    expect(LIVE_SENDING_ENABLED).toBe(true);
    expect(LIVE_INBOX_READING_ENABLED).toBe(true);
    expect(GMAIL_HEADER_TRUST_VERIFIED).toBe(false);
    expect(Object.keys(LEGAL_APPROVALS)).toHaveLength(7);
    for (const [k, v] of Object.entries(LEGAL_APPROVALS)) expect(v, k).toBe(true);
    expect(isLiveSendingPermitted()).toBe(true);
  });

  it("seed hiçbir canlı ülkeyi açmaz: hepsi engelli ve kilitli; çözümleyici 'locked' döner", async () => {
    const live = await db.select().from(countryPolicies).where(eq(countryPolicies.scope, "live"));
    expect(live.length).toBeGreaterThan(0);
    for (const r of live)
      expect({ c: r.countryCode, m: r.mode, l: r.locked }).toEqual({
        c: r.countryCode,
        m: "blocked",
        l: true,
      });
    expect(await resolveCountryPolicy(db, "live", "GB")).toEqual({
      mode: "blocked",
      reason: "locked",
    });
  });
});

describe("ülke kilitliyken canlı kampanya GÖNDERMEZ (diğer her hazırlık tamam olsa bile)", () => {
  it("ekleme ve başlatma özeti: dizi uygun değil (country_blocked/locked), başlatma no_eligible_leads ile engellenir", async () => {
    await readyExceptCountry();
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    await db.update(campaigns).set({ status: "draft" }).where(eq(campaigns.id, id));
    const s = await addSequence(db, id, { email: RECIPIENT });
    await db.update(campaignLeads).set({ status: "pending" }).where(eq(campaignLeads.id, s.cl));

    const v = await evaluateEnrollment(
      db,
      { campaignId: id, leadId: s.leadId },
      { now: T0, ignoreCampaignLeadId: s.cl },
    );
    expect(v.eligible).toBe(false);
    expect(v.reasons).toContainEqual(
      expect.objectContaining({ code: "country_blocked", detail: "locked" }),
    );
    expect(codes(v)).not.toContain("live_sending_disabled");

    const plan = await computeStartPlan(db, id, { now: T0, env: {} });
    expect(plan.blockers).toContain("no_eligible_leads");
    expect(plan.blockers).not.toContain("live_disabled");
    expect(plan.blockers).not.toContain("scheduler_disabled");
    expect(plan.blockers).not.toContain("mailbox_not_ready");
    expect(plan.eligible).toEqual([]);
    expect(plan.ineligible).toEqual([{ id: s.cl, reasons: ["country_blocked"] }]);
  });

  it("zorla zamanlanmış dizi: dağıtıcı göndermez; sağlayıcı çağrılmaz, ileti kaydı yok, dizi country_blocked ile sonlanır", async () => {
    await readyExceptCountry();
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    const s = await addSequence(db, id, { nextSendAt: null, email: RECIPIENT });

    const direct = await send(s.cl);
    expect(direct.outcome).toBe("ineligible");
    expect(codes(direct as { reasons: { code: string }[] })).toContain("country_blocked");

    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider });
    expect(r.send).toBeNull();
    expect(calls).toBe(0);
    expect(await outRows()).toHaveLength(0);
    const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    expect(cl!.status).toBe("removed");
    expect(cl!.exclusionReasons).toContain("country_blocked");
  });

  it("kontrol: sahip ülkeyi approve-live-country işleviyle açınca aynı koşullarda ileti gider", async () => {
    await readyExceptCountry();
    await unlockGB();
    const [row] = await db
      .select()
      .from(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "GB")));
    expect(row).toMatchObject({ mode: "allowed", locked: false });
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    await addSequence(db, id, { nextSendAt: null, email: RECIPIENT });
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider });
    expect(r.send).toMatchObject({ outcome: "sent" });
    expect(calls).toBe(1);
  });
});

describe("ülke açık olsa bile çalışma anı hazırlığı gönderimi korur", () => {
  let cl: number;
  beforeEach(async () => {
    await readyExceptCountry();
    await unlockGB();
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    cl = (await addSequence(db, id, { nextSendAt: null, email: RECIPIENT })).cl;
  });
  const noSend = async () => {
    expect(calls).toBe(0);
    expect(await outRows()).toHaveLength(0);
  };

  it("Gmail kutusu bağlı değil veya gönderim izni yok → mailbox_not_ready (kampanya duraklar)", async () => {
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, gid));
    expect(codes((await send(cl)) as { reasons: { code: string }[] })).toContain(
      "mailbox_not_ready",
    );
    await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, gid));
    await setSetting(db, "mail.gmailGrants", {});
    expect(codes((await send(cl)) as { reasons: { code: string }[] })).toContain(
      "mailbox_not_ready",
    );
    await noSend();
  });

  it("DNS denetimi yok / bayat / DMARC yalnızca izleme / hata → dns_not_verified (ertelenir)", async () => {
    const blocked = (detail: string, now = T0) => ({
      outcome: "not_sendable",
      code: "dns_not_verified",
      detail,
      retryAt: now + DNS_GATE_RETRY_MS,
    });
    const reports = await getSetting(db, "mail.dnsReports");
    const r = reports[String(gid)]!;

    await setSetting(db, "mail.dnsReports", {});
    expect(await send(cl)).toMatchObject(blocked("unknown"));

    await setSetting(db, "mail.dnsReports", { [String(gid)]: { ...r, dmarc: "warn" } });
    expect(await send(cl)).toMatchObject(blocked("unknown"));

    await setSetting(db, "mail.dnsReports", { [String(gid)]: { ...r, spf: "fail" } });
    expect(await send(cl)).toMatchObject(blocked("blocked"));

    await setSetting(db, "mail.dnsReports", { [String(gid)]: { ...r, domain: "baska.com" } });
    expect(await send(cl)).toMatchObject(blocked("unknown"));

    await setSetting(db, "mail.dnsReports", {
      [String(gid)]: { ...r, checkedAt: T0 - DNS_FRESH_MS - 60_000 },
    });
    expect(await send(cl)).toMatchObject(blocked("unknown"));
    await noSend();
  });

  it("dağıtıcı DNS kapısında diziyi ERTELER (dışlamaz, kampanyayı durdurmaz); denetim gelince gönderir", async () => {
    await setSetting(db, "mail.dnsReports", {});
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider });
    expect(r).toMatchObject({ send: null, deferred: 1, excluded: 0, pausedCampaigns: [] });
    const [row] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, cl));
    expect(row).toMatchObject({
      status: "scheduled",
      nextSendAt: T0 + DNS_GATE_RETRY_MS,
      lastError: "dns_not_verified",
    });
    await noSend();
    const later = T0 + DNS_GATE_RETRY_MS;
    await recordPassingDns(db, gid, later);
    const ok = await new MailDispatcher(db).dispatchOnce({ now: () => later, provider });
    expect(ok.send).toMatchObject({ outcome: "sent" });
    expect(calls).toBe(1);
  });

  it("HTTPS çıkış uç noktası doğrulanmamış → unsubscribe_unavailable", async () => {
    const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", { ...cfg, verified: null });
    expect(await send(cl)).toMatchObject({
      outcome: "not_sendable",
      code: "unsubscribe_unavailable",
    });
    await noSend();
  });

  it("çıkış çekme işi kapalı → unsubscribe_drain_unhealthy", async () => {
    await setSetting(db, "mail.unsubscribeDrain", { enabled: false });
    expect(await send(cl)).toMatchObject({
      outcome: "not_sendable",
      code: "unsubscribe_drain_unhealthy",
      detail: "drain_disabled",
    });
    await noSend();
  });

  it("kontrol: hepsi tamamken gönderilir", async () => {
    expect(await send(cl)).toMatchObject({ outcome: "sent" });
    expect(calls).toBe(1);
  });
});
