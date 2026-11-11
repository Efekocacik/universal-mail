import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, campaigns, messages } from "@/lib/db/schema";
import { isPreConnectFailure } from "@/lib/mail/gmail/provider";
import {
  RECENT_UNKNOWN_COOLDOWN_MS,
  getMailboxBackoff,
  mailboxBackoffUntil,
} from "@/lib/mail/mailbox-backoff";
import { FakeMailProvider, type FakeStep } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { nextUtcDayStart } from "@/lib/mail/scheduler/throttle";
import { sendCampaignStep } from "@/lib/mail/send-service";
import {
  DEMO_MAILBOX,
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * Kutu düzeyi gönderim retleri (kota/429, yetki uç noktası, ağ erişilemez, Google 403) ve belirsiz sonuç devre kesicisi.
 * Bellek içi veritabanı ve sahte sağlayıcı; ağ yok.
 */

let client: Client;
let db: Db;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});
afterEach(() => {
  client.close();
});

const always = (step: FakeStep, n = 50) =>
  new FakeMailProvider({ script: Array.from({ length: n }, () => ({ ...step })), now: () => T0 });
const seqs = (c: number) => db.select().from(campaignLeads).where(eq(campaignLeads.campaignId, c));
const outMessages = () => db.select().from(messages).where(eq(messages.direction, "out"));

describe("kutu düzeyi retler dizinin deneme hakkını tüketmez", () => {
  it("günlük kota (rate_limited_daily) tekrar tekrar: hiçbir dizi failed olmaz, attempts=0; kutu sonraki UTC gününe kadar kapalı", async () => {
    const c = await createCampaign(db, { steps: 1 });
    for (let i = 0; i < 5; i++) await addSequence(db, c);
    const p = always({ kind: "reject", code: "rate_limited_daily", permanent: false });
    const d = new MailDispatcher(db);

    const first = await d.dispatchOnce({ now: () => T0, provider: p });
    expect(first.send).toMatchObject({ outcome: "failed", code: "rate_limited_daily" });
    const until = nextUtcDayStart(T0);
    expect(await getMailboxBackoff(db, DEMO_MAILBOX, T0)).toEqual({
      until,
      code: "rate_limited_daily",
    });

    // Gün boyunca her turda (gönderim aralığı dolsa da) başka dizi denenmez.
    for (let t = T0 + 5 * MIN; t < T0 + 6 * HOUR; t += 7 * MIN) {
      const r = await d.dispatchOnce({ now: () => t, provider: p });
      expect(r.send).toBeNull();
    }
    expect(p.calls).toBe(1);
    const other = (await seqs(c)).find((s) => s.status === "scheduled" && s.nextSendAt === null);
    expect(
      await sendCampaignStep(
        db,
        { campaignLeadId: other!.id, stepIndex: 0 },
        { now: () => T0 + HOUR, provider: p },
      ),
    ).toMatchObject({
      outcome: "not_sendable",
      code: "mailbox_halted",
      retryAt: until,
      detail: "rate_limited_daily",
    });

    // Sonraki günlerde de kota dolu kalsın: günde en çok bir deneme ve hiçbir dizi yanmaz.
    for (let day = 1; day <= 4; day++) {
      for (let t = T0 + day * DAY - 2 * HOUR; t < T0 + day * DAY + 8 * HOUR; t += 10 * MIN) {
        await d.dispatchOnce({ now: () => t, provider: p });
      }
    }
    expect(p.calls).toBeGreaterThanOrEqual(2);
    expect(p.calls).toBeLessThanOrEqual(5);
    for (const s of await seqs(c)) {
      expect(s.status).not.toBe("failed");
      expect(s.attempts).toBe(0);
    }
    const msgs = await outMessages();
    expect(msgs.every((m) => m.status === "failed" && m.errorMessage === "mailbox_scope")).toBe(
      true,
    );
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, c));
    expect(camp!.status).toBe("running");
    expect(
      (await db.select().from(auditLog).where(eq(auditLog.action, "mailbox.send_backoff"))).length,
    ).toBe(p.calls);
  });

  it("429 (rate_limited) Retry-After'a uyar; yetki uç noktası/ağ erişilemez varsayılan 10 dk", () => {
    expect(mailboxBackoffUntil("rate_limited", HOUR, T0)).toBe(T0 + HOUR);
    expect(mailboxBackoffUntil("rate_limited", undefined, T0)).toBe(T0 + 15 * MIN);
    expect(mailboxBackoffUntil("rate_limited", 10 * DAY, T0)).toBe(T0 + DAY);
    expect(mailboxBackoffUntil("auth_unavailable", undefined, T0)).toBe(T0 + 10 * MIN);
    expect(mailboxBackoffUntil("network_unreachable", undefined, T0)).toBe(T0 + 10 * MIN);
    expect(mailboxBackoffUntil("rate_limited_daily", HOUR, T0)).toBe(nextUtcDayStart(T0));
    expect(mailboxBackoffUntil("rate_limited_daily", 23 * HOUR, T0)).toBe(T0 + 23 * HOUR);
  });

  it("ağ erişilemez (network_unreachable): dizi ertelenir, deneme sayılmaz; bekleme bitince gönderim sürer", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const a = await addSequence(db, c);
    const p = new FakeMailProvider({
      script: [{ kind: "reject", code: "network_unreachable", permanent: false }],
      now: () => T0,
    });
    const d = new MailDispatcher(db);
    await d.dispatchOnce({ now: () => T0, provider: p });
    const [row] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, a.cl));
    expect(row).toMatchObject({
      status: "scheduled",
      attempts: 0,
      nextSendAt: T0 + 10 * MIN,
      lastError: "network_unreachable",
    });
    await d.dispatchOnce({ now: () => T0 + 10 * MIN, provider: p });
    const [after] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, a.cl));
    expect(after!.status).toBe("completed");
  });

  it("Google 403 (forbidden): kutunun çalışan kampanyaları duraklatılır, dizi failed olmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const c2 = await createCampaign(db, { steps: 1 });
    const a = await addSequence(db, c);
    await addSequence(db, c2);
    const p = always({ kind: "reject", code: "forbidden", permanent: true });
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    const [row] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, a.cl));
    expect(row).toMatchObject({ status: "scheduled", attempts: 0, lastError: "forbidden" });
    const camps = await db.select().from(campaigns);
    expect(camps.map((x) => [x.status, x.pauseReason])).toEqual([
      ["paused", "auto:forbidden"],
      ["paused", "auto:forbidden"],
    ]);
    expect(p.calls).toBe(1);
  });
});

describe("belirsiz sonuç devre kesicisi", () => {
  it("art arda hata veren sağlayıcı yalnızca BİR belirsiz kayıt üretir; 30 dk sonra yeniden denenir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    for (let i = 0; i < 3; i++) await addSequence(db, c);
    const p = always({ kind: "throw-after" });
    const d = new MailDispatcher(db);
    expect((await d.dispatchOnce({ now: () => T0, provider: p })).send?.outcome).toBe("unknown");
    for (let t = T0 + 5 * MIN; t < T0 + RECENT_UNKNOWN_COOLDOWN_MS; t += 4 * MIN) {
      expect((await d.dispatchOnce({ now: () => t, provider: p })).send).toBeNull();
    }
    expect(p.calls).toBe(1);
    expect((await outMessages()).filter((m) => m.status === "unknown")).toHaveLength(1);
    const later = T0 + RECENT_UNKNOWN_COOLDOWN_MS + MIN;
    expect((await d.dispatchOnce({ now: () => later, provider: p })).send?.outcome).toBe("unknown");
    expect(p.calls).toBe(2);
    expect(
      await db
        .select()
        .from(campaignLeads)
        .where(and(eq(campaignLeads.campaignId, c), eq(campaignLeads.status, "in_flight"))),
    ).toHaveLength(2);
  });
});

describe("bağlantı öncesi ağ hataları", () => {
  const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
  it("yalnızca bağlantı KURULMADAN oluşan kodlar kesin ret sayılır", () => {
    expect(isPreConnectFailure(fetchFailed({ code: "ENOTFOUND" }))).toBe(true);
    expect(isPreConnectFailure(fetchFailed({ code: "ECONNREFUSED" }))).toBe(true);
    expect(isPreConnectFailure(fetchFailed({ code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(true);
    const agg = Object.assign(new AggregateError([]), {
      code: "ECONNREFUSED",
      errors: [{ code: "ECONNREFUSED" }, { code: "ENETUNREACH" }],
    });
    expect(isPreConnectFailure(fetchFailed(agg))).toBe(true);
    const mixed = Object.assign(new AggregateError([]), {
      errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }],
    });
    expect(isPreConnectFailure(fetchFailed(mixed))).toBe(false);
    expect(isPreConnectFailure(fetchFailed({ code: "ECONNRESET" }))).toBe(false);
    expect(isPreConnectFailure(fetchFailed({ code: "UND_ERR_SOCKET" }))).toBe(false);
    expect(isPreConnectFailure(fetchFailed({ code: "UND_ERR_HEADERS_TIMEOUT" }))).toBe(false);
    expect(isPreConnectFailure(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isPreConnectFailure(fetchFailed(undefined))).toBe(false);
  });
});
