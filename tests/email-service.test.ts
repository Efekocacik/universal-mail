import { and, eq } from "drizzle-orm";
import { AGENT_TOKEN, buildUserAgent, createEmailDeps } from "@/lib/email/deps";
import { safeFetch } from "@/lib/email/safe-fetch";
import { setSecret } from "@/lib/secrets/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeCache } from "@/lib/db/cache-schema";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import {
  categorySets,
  leadContacts,
  leadEmails,
  leadEnrichment,
  leads,
  places,
} from "@/lib/db/schema";
import { createDemoFetch, createDemoResolver, resetDemoWeb } from "@/lib/email/demo";
import { EMAIL_JOB, enqueueEmailSearch } from "@/lib/email/enqueue";
import { ExternalProviderError, type ExternalEmailProvider } from "@/lib/email/external";
import type { FetchFn, FetchResult } from "@/lib/email/safe-fetch";
import { findEmailsForLeads, RETRY_DELAY_MS, type EmailDeps } from "@/lib/email/service";
import { computeEmailStatus, pickPrimary } from "@/lib/email/status";
import { findDuplicates, getLeadEmails, refreshLeadSummary, saveEmails } from "@/lib/email/store";
import { clearEventHandlers, onEvent } from "@/lib/events";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { jobs } from "@/lib/db/schema";
import { MockPlacesProvider } from "@/lib/places/mock";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import {
  registerCoreHandlers,
  registerEmailHandlers,
  bindEmailEvents,
  resetEmailEventsForTests,
} from "@/worker/handlers";
import { Worker } from "@/worker/loop";
import { clearJobHandlers } from "@/lib/jobs/registry";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let db: Db;
const londonBox = bboxFromCenter(51.5085, -0.1257, 3.5);

function provider() {
  return new MockPlacesProvider({ getEpoch: () => 0 });
}
function baseDeps(over: Partial<EmailDeps> = {}): EmailDeps {
  return {
    db,
    fetch: createDemoFetch(),
    resolver: createDemoResolver(),
    sleep: async () => undefined,
    delayMs: 0,
    maxRequests: 6,
    timeoutMs: 1000,
    concurrency: 4,
    userAgent: "UniversalMail/test",
    agentToken: "UniversalMail",
    ...over,
  };
}

async function scanAndEnrich(count: number) {
  const cafes = (await db.select().from(categorySets))
    .filter((c) => c.key === "cafe")
    .map((c) => c.id);
  const { scanId } = await createAndStartScan(db, {
    region: { kind: "city", name: "London", countryCode: "GB", bbox: londonBox },
    categoryIds: cafes,
  });
  await runScan(
    {
      db,
      provider: provider(),
      getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
      getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
      sleep: async () => undefined,
      minIntervalMs: 0,
    },
    scanId,
  );
  const placeIds = (await db.select({ id: places.placeId }).from(places).limit(count)).map(
    (r) => r.id,
  );
  await enrichPlaces(
    {
      db,
      provider: provider(),
      getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
      getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
      sleep: async () => undefined,
    },
    placeIds,
    "enrich",
  );
  const rows = await db.select().from(leads);
  return rows.filter((l) => l.placeId && placeIds.includes(l.placeId)).map((l) => l.id);
}

const res = (
  url: string,
  status: number,
  body = "",
  headers: Record<string, string> = {},
): FetchResult => ({
  url,
  status,
  headers: { "content-type": "text/html", ...headers },
  body,
  skippedBody: false,
  truncated: false,
  hops: 0,
});

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
  resetDemoWeb();
  clearEventHandlers();
});
afterEach(async () => {
  clearEventHandlers();
  clearJobHandlers();
  resetEmailEventsForTests();
  await t.cleanup();
});

describe("durum özeti ve birincil adres", () => {
  const e = (
    kind: "generic" | "personal" | "consumer",
    verifyStatus: "verified" | "unverified" | "invalid",
  ) => ({ kind, verifyStatus });
  it("SRS e-posta durumu önceliği", () => {
    expect(computeEmailStatus([e("personal", "verified"), e("generic", "verified")], true)).toBe(
      "found_verified",
    );
    expect(computeEmailStatus([e("generic", "verified"), e("personal", "unverified")], true)).toBe(
      "generic",
    );
    expect(computeEmailStatus([e("personal", "unverified")], true)).toBe("found_unverified");
    expect(computeEmailStatus([e("consumer", "unverified")], true)).toBe("found_unverified");
    expect(computeEmailStatus([e("generic", "invalid")], true)).toBe("invalid");
    expect(computeEmailStatus([], true)).toBe("not_found");
    expect(computeEmailStatus([], false)).toBeNull();
  });

  it("birincil: sabitlenen kazanır; yoksa siteyle eşleşen > doğrulanmış > genel > kaynak; geçersiz seçilmez", () => {
    const row = (over: Record<string, unknown>) =>
      ({
        id: 1,
        kind: "generic",
        verifyStatus: "verified",
        siteMatch: true,
        sourceType: "mailto",
        foundAt: 1,
        primaryPinned: false,
        ...over,
      }) as Parameters<typeof pickPrimary>[0][number];
    expect(
      pickPrimary([row({ id: 1, kind: "personal" }), row({ id: 2, kind: "generic" })])?.id,
    ).toBe(2);
    expect(
      pickPrimary([row({ id: 1, siteMatch: false }), row({ id: 2, verifyStatus: "unverified" })])
        ?.id,
    ).toBe(2);
    expect(pickPrimary([row({ id: 1, verifyStatus: "unverified" }), row({ id: 2 })])?.id).toBe(2);
    expect(
      pickPrimary([row({ id: 1, sourceType: "text" }), row({ id: 2, sourceType: "mailto" })])?.id,
    ).toBe(2);
    expect(
      pickPrimary([row({ id: 1 }), row({ id: 2, kind: "personal", primaryPinned: true })])?.id,
    ).toBe(2);
    expect(pickPrimary([row({ id: 1, verifyStatus: "invalid" })])).toBeNull();
    expect(pickPrimary([row({ id: 1, verifyStatus: "invalid", primaryPinned: true })])).toBeNull();
  });
});

describe("e-posta bulma (demo web ile, ağ yok)", () => {
  it("lead'lerin sitelerini tarar; adresler kaynak URL, tür ve doğrulamayla kaydedilir; bulma oranı raporlanır", async () => {
    const ids = await scanAndEnrich(60);
    expect(ids.length).toBe(60);
    const out = await findEmailsForLeads(baseDeps(), ids);

    expect(out.processed + out.noWebsite + out.needsGoogle).toBe(60);
    expect(out.needsGoogle).toBe(0);
    const emails = await db.select().from(leadEmails);
    expect(emails.length).toBeGreaterThan(10);
    for (const e of emails) {
      expect(e.email).toBe(e.email.toLowerCase());
      expect(e.sourceUrl).toMatch(/^https:\/\/.+\.example\//);
      expect(["generic", "personal", "consumer"]).toContain(e.kind);
      expect(["verified", "unverified", "invalid"]).toContain(e.verifyStatus);
      expect(e.verifiedAt).not.toBeNull();
    }
    const states = await db.select().from(leadEnrichment);
    expect(states.length).toBe(60);
    const valid = new Set([
      "found_verified",
      "found_unverified",
      "generic",
      "not_found",
      "invalid",
      null,
    ]);
    expect(states.every((s) => valid.has(s.emailStatus))).toBe(true);
    expect(
      states.every((s) => ["done", "blocked", "failed", "no_website"].includes(s.status)),
    ).toBe(true);
    // Demo dağılımı: yaklaşık yarısında kullanılabilir adres (kabul ölçütü %40 gerçek dünya için ayrıca denenecek)
    expect(out.found / 60).toBeGreaterThan(0.4);
    // Birincil: lead başına en fazla bir
    const primaries = await db.select().from(leadEmails).where(eq(leadEmails.isPrimary, true));
    const perLead = new Map<number, number>();
    for (const p of primaries) perLead.set(p.leadId, (perLead.get(p.leadId) ?? 0) + 1);
    expect([...perLead.values()].every((n) => n === 1)).toBe(true);
    expect((await db.select().from(leadContacts)).length).toBeGreaterThan(0);
    expect(out.blocked).toBeGreaterThan(0);
  });

  it("adres bulunan lead'ler için lead.emailsFound olayı yayılır", async () => {
    const ids = await scanAndEnrich(40);
    const seen: number[][] = [];
    onEvent("lead.emailsFound", ({ leadIds }) => void seen.push(leadIds));
    const out = await findEmailsForLeads(baseDeps(), ids);
    expect(seen.length).toBe(out.found > 0 ? 1 : 0);
    expect(seen.flat().length).toBe(out.found);
  });

  it("web sitesi yok → no_website; Google verisi yok → needs_google (ağa çıkmaz); opt-out atlanır", async () => {
    const ids = await scanAndEnrich(6);
    const [a, b, c, d] = ids;
    const placeOf = async (id: number) =>
      (await db.select().from(leads).where(eq(leads.id, id)))[0]!.placeId!;
    await db
      .update(placeCache)
      .set({ website: null })
      .where(eq(placeCache.placeId, await placeOf(a!)));
    await db
      .update(placeCache)
      .set({ enrichedAt: null })
      .where(eq(placeCache.placeId, await placeOf(b!)));
    await db.update(leads).set({ status: "do_not_contact" }).where(eq(leads.id, c!));
    const fetchSpy = vi.fn(createDemoFetch());
    const out = await findEmailsForLeads(baseDeps({ fetch: fetchSpy as FetchFn }), [a!, b!, c!]);
    expect(out).toMatchObject({ noWebsite: 1, needsGoogle: 1, skippedOptOut: 1, processed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const st = async (id: number) =>
      (await db.select().from(leadEnrichment).where(eq(leadEnrichment.leadId, id)))[0];
    expect((await st(a!))?.status).toBe("no_website");
    expect((await st(b!))?.status).toBe("needs_google");
    expect(await st(c!)).toBeUndefined();
    void d;
  });

  it("taranmış lead'ler yeniden taranmaz; force ile taranır", async () => {
    const ids = await scanAndEnrich(10);
    await findEmailsForLeads(baseDeps(), ids);
    const spy = vi.fn(createDemoFetch());
    const again = await findEmailsForLeads(baseDeps({ fetch: spy as FetchFn }), ids);
    expect(again.skippedDone).toBeGreaterThan(0);
    const forced = await findEmailsForLeads(baseDeps({ fetch: spy as FetchFn }), ids, {
      force: true,
    });
    expect(forced.skippedDone).toBe(0);
    expect(spy).toHaveBeenCalled();
  });

  it("aynı siteyi paylaşan lead'ler (zincir) tek taramayla işlenir", async () => {
    const ids = await scanAndEnrich(4);
    const calls: string[] = [];
    const site = "https://chain-cafe.example/";
    const rows = await db.select().from(leads).where(eq(leads.id, ids[0]!));
    void rows;
    for (const id of ids.slice(0, 3)) {
      const pid = (await db.select().from(leads).where(eq(leads.id, id)))[0]!.placeId!;
      await db.update(placeCache).set({ website: site }).where(eq(placeCache.placeId, pid));
    }
    const out = await findEmailsForLeads(
      baseDeps({ fetch: async (u, o) => (calls.push(u), createDemoFetch()(u, o)) }),
      ids.slice(0, 3),
    );
    expect(out.processed).toBe(3);
    expect(calls.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1);
  });
});

describe("hata ve yeniden deneme politikası (FR-ENR-05)", () => {
  async function oneLead() {
    const ids = await scanAndEnrich(1);
    const pid = (await db.select().from(leads).where(eq(leads.id, ids[0]!)))[0]!.placeId!;
    await db
      .update(placeCache)
      .set({ website: "https://x-site.example/" })
      .where(eq(placeCache.placeId, pid));
    return ids[0]!;
  }
  const state = async (id: number) =>
    (await db.select().from(leadEnrichment).where(eq(leadEnrichment.leadId, id)))[0]!;

  it("geçici hata: 24 saat sonra bir kez yeniden denenir; ikinci hatadan sonra tekrar yok", async () => {
    const id = await oneLead();
    const failing: FetchFn = async (u) =>
      u.endsWith("/robots.txt") ? res(u, 404) : res(u, 503, "down");
    const retry = vi.fn(async () => undefined);
    const clock = { t: 1_800_000_000_000 };
    const first = await findEmailsForLeads(baseDeps({ fetch: failing, now: () => clock.t }), [id], {
      scheduleRetry: retry,
    });
    expect(first).toMatchObject({ failed: 1, retryScheduled: 1 });
    expect(retry).toHaveBeenCalledWith([id], clock.t + RETRY_DELAY_MS);
    const s1 = await state(id);
    expect(s1).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "http_5xx",
      nextRetryAt: clock.t + RETRY_DELAY_MS,
    });

    clock.t += RETRY_DELAY_MS;
    const second = await findEmailsForLeads(
      baseDeps({ fetch: failing, now: () => clock.t }),
      [id],
      { scheduleRetry: retry },
    );
    expect(second).toMatchObject({ failed: 1, retryScheduled: 0 });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await state(id)).toMatchObject({ status: "failed", attempts: 2, nextRetryAt: null });
  });

  it("yeniden denemede site düzelirse sonuç kaydedilir", async () => {
    const id = await oneLead();
    let n = 0;
    const flaky: FetchFn = async (u) => {
      if (u.endsWith("/robots.txt")) return res(u, 404);
      if (u.endsWith("/") && ++n === 1) return res(u, 502);
      return res(u, 200, `<a href="mailto:info@x-site.example">m</a>`);
    };
    await findEmailsForLeads(baseDeps({ fetch: flaky }), [id]);
    expect((await state(id)).status).toBe("failed");
    await findEmailsForLeads(baseDeps({ fetch: flaky }), [id]);
    expect(await state(id)).toMatchObject({
      status: "done",
      emailStatus: "generic",
      nextRetryAt: null,
    });
  });

  it("engel (robots/403) ve kalıcı hatalarda otomatik tekrar planlanmaz; durum 'blocked'/'failed'", async () => {
    const id = await oneLead();
    const retry = vi.fn(async () => undefined);
    const robots: FetchFn = async (u) =>
      res(
        u,
        u.endsWith("/robots.txt") ? 200 : 200,
        u.endsWith("/robots.txt") ? "User-agent: *\nDisallow: /\n" : "x",
        { "content-type": u.endsWith("/robots.txt") ? "text/plain" : "text/html" },
      );
    expect(
      await findEmailsForLeads(baseDeps({ fetch: robots }), [id], { scheduleRetry: retry }),
    ).toMatchObject({ blocked: 1, retryScheduled: 0 });
    expect(await state(id)).toMatchObject({
      status: "blocked",
      lastError: "robots_disallow",
      nextRetryAt: null,
    });
    // blocked yeniden taranmaz (force olmadıkça)
    expect((await findEmailsForLeads(baseDeps({ fetch: robots }), [id])).skippedDone).toBe(1);

    const gone: FetchFn = async (u) => res(u, u.endsWith("/robots.txt") ? 404 : 404);
    await findEmailsForLeads(baseDeps({ fetch: gone }), [id], {
      force: true,
      scheduleRetry: retry,
    });
    expect(await state(id)).toMatchObject({
      status: "failed",
      lastError: "http_404",
      nextRetryAt: null,
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("yeniden deneme zamanında Google verisi silinmişse (uygulama yeniden açıldı) 'needs_google' olur; ağa çıkılmaz", async () => {
    const id = await oneLead();
    const failing: FetchFn = async (u) => (u.endsWith("/robots.txt") ? res(u, 404) : res(u, 503));
    await findEmailsForLeads(baseDeps({ fetch: failing }), [id]);
    expect((await state(id)).nextRetryAt).not.toBeNull();
    await db.delete(placeCache); // yeniden açılış: Google verisi (web sitesi adresi) saklanmaz
    const spy = vi.fn(failing);
    expect(await findEmailsForLeads(baseDeps({ fetch: spy }), [id])).toMatchObject({
      needsGoogle: 1,
      processed: 0,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(await state(id)).toMatchObject({
      status: "needs_google",
      nextRetryAt: null,
      attempts: 1,
    });
  });

  it("geçersiz web sitesi adresi kalıcı hata sayılır", async () => {
    const id = await oneLead();
    const pid = (await db.select().from(leads).where(eq(leads.id, id)))[0]!.placeId!;
    await db
      .update(placeCache)
      .set({ website: "ftp://kötü adres" })
      .where(eq(placeCache.placeId, pid));
    expect(await findEmailsForLeads(baseDeps(), [id])).toMatchObject({ failed: 1 });
    expect(await state(id)).toMatchObject({
      status: "failed",
      lastError: "bad_url",
      nextRetryAt: null,
    });
  });
});

describe("eşzamanlılık ve durdurma", () => {
  it("aynı anda en fazla 4 site taranır; aynı sunucuya ardışık gidilir", async () => {
    const ids = await scanAndEnrich(14);
    for (const [i, id] of ids.entries()) {
      const pid = (await db.select().from(leads).where(eq(leads.id, id)))[0]!.placeId!;
      // İlk iki lead aynı sunucuda farklı yollar: ardışık olmalı
      const url =
        i < 2 ? `https://same-host.example/${i === 0 ? "a" : "b"}/` : `https://site-${i}.example/`;
      await db.update(placeCache).set({ website: url }).where(eq(placeCache.placeId, pid));
    }
    let active = 0;
    let max = 0;
    const perHost = new Map<string, number>();
    let hostOverlap = false;
    const slow: FetchFn = async (u, o) => {
      const host = new URL(u).hostname;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      if ((perHost.get(host) ?? 0) > 1 && host === "same-host.example" && active > 0) {
        /* aynı sunucuda eşzamanlı istek tespiti aşağıda */
      }
      active++;
      max = Math.max(max, active);
      if (host === "same-host.example") {
        hostActive++;
        if (hostActive > 1) hostOverlap = true;
      }
      await new Promise((r) => setTimeout(r, 4));
      const out = await createDemoFetch()(u, o);
      active--;
      if (host === "same-host.example") hostActive--;
      return out;
    };
    let hostActive = 0;
    await findEmailsForLeads(baseDeps({ fetch: slow, concurrency: 4 }), ids);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
    expect(hostOverlap).toBe(false);

    max = 0;
    await findEmailsForLeads(baseDeps({ fetch: slow, concurrency: 1 }), ids, { force: true });
    expect(max).toBe(1);
  });

  it("durdurma isteğinde işlenmeyenler 'kuyrukta' kalır (çalışıyor görünmez)", async () => {
    const ids = await scanAndEnrich(8);
    let calls = 0;
    const out = await findEmailsForLeads(
      baseDeps({
        shouldStop: () => calls > 6,
        fetch: async (u, o) => (calls++, createDemoFetch()(u, o)),
        concurrency: 1,
      }),
      ids,
    );
    expect(out.stopped).toBe(true);
    const states = await db.select().from(leadEnrichment);
    expect(states.some((s) => s.status === "running")).toBe(false);
    expect(states.some((s) => s.status === "queued")).toBe(true);
  });
});

describe("harici servis (Hunter) yedeği", () => {
  async function leadWithEmptySite() {
    const ids = await scanAndEnrich(1);
    const pid = (await db.select().from(leads).where(eq(leads.id, ids[0]!)))[0]!.placeId!;
    await db
      .update(placeCache)
      .set({ website: "https://empty-site.example/" })
      .where(eq(placeCache.placeId, pid));
    return ids[0]!;
  }
  const emptySite: FetchFn = async (u) =>
    res(u, u.endsWith("/robots.txt") ? 404 : 200, "<p>no email here</p>");

  it("yerelde bulunamazsa kullanılır; adresler 'external' kaynaklı, doğrulanmış ve düşük güvenliler elenmiş kaydedilir", async () => {
    const id = await leadWithEmptySite();
    const search = vi.fn(async () => [
      {
        email: "Owner@empty-site.example",
        confidence: 90,
        sourceUrl: "https://empty-site.example/about",
      },
      { email: "low@empty-site.example", confidence: 10, sourceUrl: null },
      {
        email: "agency@other-agency.example",
        confidence: 80,
        sourceUrl: "https://other-agency.example/x",
      },
    ]);
    const ext: ExternalEmailProvider = {
      id: "hunter",
      search,
      quota: async () => ({ remaining: 10, resetDate: null }),
    };
    const out = await findEmailsForLeads(baseDeps({ fetch: emptySite, external: ext }), [id]);
    expect(search).toHaveBeenCalledWith("empty-site.example");
    expect(out.externalUsed).toBe(1);
    const rows = await getLeadEmails(db, id);
    expect(rows.map((r) => r.email).sort()).toEqual([
      "agency@other-agency.example",
      "owner@empty-site.example",
    ]);
    expect(rows.every((r) => r.sourceType === "external")).toBe(true);
    const owner = rows.find((r) => r.email.startsWith("owner"))!;
    expect(owner).toMatchObject({ sourceUrl: "https://empty-site.example/about", siteMatch: true });
    expect(rows.find((r) => r.email.startsWith("agency"))).toMatchObject({
      sourceUrl: null,
      siteMatch: false,
    });
    expect((await db.select().from(leadEnrichment))[0]!.externalUsed).toBe(true);
  });

  it("yerelde adres bulunduysa harici servise gidilmez", async () => {
    const id = await leadWithEmptySite();
    const search = vi.fn(async () => []);
    const withMail: FetchFn = async (u) =>
      res(
        u,
        u.endsWith("/robots.txt") ? 404 : 200,
        `<a href="mailto:hello@empty-site.example">m</a>`,
      );
    const ext: ExternalEmailProvider = {
      id: "hunter",
      search,
      quota: async () => ({ remaining: null, resetDate: null }),
    };
    await findEmailsForLeads(baseDeps({ fetch: withMail, external: ext }), [id]);
    expect(search).not.toHaveBeenCalled();
  });

  it("yalnızca gmail gibi bireysel adres bulunduysa harici servis denenir", async () => {
    const id = await leadWithEmptySite();
    const search = vi.fn(async () => [
      { email: "info@empty-site.example", confidence: 70, sourceUrl: null },
    ]);
    const gmailOnly: FetchFn = async (u) =>
      res(u, u.endsWith("/robots.txt") ? 404 : 200, `<a href="mailto:annecafe@gmail.com">m</a>`);
    const ext: ExternalEmailProvider = {
      id: "hunter",
      search,
      quota: async () => ({ remaining: null, resetDate: null }),
    };
    await findEmailsForLeads(baseDeps({ fetch: gmailOnly, external: ext }), [id]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("kota/anahtar hatasında koşunun geri kalanında servis kullanılmaz; sonuçlar yine de kaydedilir", async () => {
    const ids = await scanAndEnrich(3);
    for (const [i, id] of ids.entries()) {
      const pid = (await db.select().from(leads).where(eq(leads.id, id)))[0]!.placeId!;
      await db
        .update(placeCache)
        .set({ website: `https://empty-${i}.example/` })
        .where(eq(placeCache.placeId, pid));
    }
    const search = vi.fn(async () => {
      throw new ExternalProviderError("quota", "Kota doldu");
    });
    const ext: ExternalEmailProvider = {
      id: "hunter",
      search,
      quota: async () => ({ remaining: 0, resetDate: null }),
    };
    const out = await findEmailsForLeads(
      baseDeps({ fetch: emptySite, external: ext, concurrency: 1 }),
      ids,
    );
    expect(search).toHaveBeenCalledTimes(1);
    expect(out.notFound).toBe(3);
    expect(out.externalUsed).toBe(0);
  });
});

describe("yinelenen kayıt tespiti ve birincil adres kalıcılığı", () => {
  it("aynı e-postayı veya aynı işletme alan adını paylaşan lead'ler bulunur; bireysel sağlayıcılar alan adı eşleşmesi sayılmaz", async () => {
    const ids = await scanAndEnrich(4);
    const [a, b, c, d] = ids as [number, number, number, number];
    const now = Date.now();
    const verified = { verifyStatus: "verified" as const, verifyReason: "ok_mx" };
    await saveEmails(
      db,
      a,
      [
        {
          email: "info@chain.example",
          sourceType: "mailto",
          sourceUrl: "https://chain.example/",
          siteHost: "chain.example",
          ...verified,
        },
      ],
      now,
    );
    await saveEmails(
      db,
      b,
      [
        {
          email: "info@chain.example",
          sourceType: "text",
          sourceUrl: "https://chain.example/b",
          siteHost: "chain.example",
          ...verified,
        },
      ],
      now,
    );
    await saveEmails(
      db,
      c,
      [
        {
          email: "london@chain.example",
          sourceType: "text",
          sourceUrl: "https://chain.example/c",
          siteHost: "chain.example",
          ...verified,
        },
      ],
      now,
    );
    await saveEmails(
      db,
      d,
      [
        {
          email: "x@gmail.com",
          sourceType: "text",
          sourceUrl: null,
          verifyStatus: "unverified",
          verifyReason: "consumer_domain",
        },
      ],
      now,
    );
    const dup = await findDuplicates(db, a, await getLeadEmails(db, a));
    expect(dup.map((x) => [x.leadId, x.reason]).sort()).toEqual(
      [
        [b, "same_email"],
        [c, "same_domain"],
      ].sort(),
    );
    expect(await findDuplicates(db, d, await getLeadEmails(db, d))).toEqual([]);
  });

  it("sabitlenen birincil, yeniden taramada değişmez; silinince otomatik seçime döner", async () => {
    const [id] = await scanAndEnrich(1);
    const now = Date.now();
    const v = { verifyStatus: "verified" as const, verifyReason: "ok_mx" };
    await saveEmails(
      db,
      id!,
      [
        {
          email: "info@keep.example",
          sourceType: "mailto",
          sourceUrl: "https://keep.example/",
          siteHost: "keep.example",
          ...v,
        },
        {
          email: "anna@keep.example",
          sourceType: "text",
          sourceUrl: "https://keep.example/c",
          siteHost: "keep.example",
          ...v,
        },
      ],
      now,
    );
    await refreshLeadSummary(db, id!);
    let rows = await getLeadEmails(db, id!);
    expect(rows.find((r) => r.isPrimary)?.email).toBe("info@keep.example");
    const anna = rows.find((r) => r.email.startsWith("anna"))!;
    await db.update(leadEmails).set({ primaryPinned: true }).where(eq(leadEmails.id, anna.id));
    await refreshLeadSummary(db, id!);
    rows = await getLeadEmails(db, id!);
    expect(rows.find((r) => r.isPrimary)?.email).toBe("anna@keep.example");
    await db.delete(leadEmails).where(and(eq(leadEmails.id, anna.id)));
    await refreshLeadSummary(db, id!);
    expect((await getLeadEmails(db, id!)).find((r) => r.isPrimary)?.email).toBe(
      "info@keep.example",
    );
  });
});

describe("kuyruk, işçi ve olay entegrasyonu", () => {
  it("enqueueEmailSearch lead'leri 'kuyrukta' işaretler ve 20'şerli iş ekler", async () => {
    const ids = await scanAndEnrich(45);
    expect(await enqueueEmailSearch(db, ids)).toBe(3);
    expect(
      (await db.select().from(jobs).where(eq(jobs.type, EMAIL_JOB)))
        .map((j) => (j.payload as { leadIds: number[] }).leadIds.length)
        .sort((a, b) => a - b),
    ).toEqual([5, 20, 20]);
    expect((await db.select().from(leadEnrichment)).every((s) => s.status === "queued")).toBe(true);
    // zamanlanmış yeniden deneme: durumu 'kuyrukta' yapmaz
    await db.update(leadEnrichment).set({ status: "failed" });
    await enqueueEmailSearch(db, ids.slice(0, 2), {
      runAt: Date.now() + RETRY_DELAY_MS,
      markQueued: false,
    });
    expect(
      (await db.select().from(leadEnrichment).where(eq(leadEnrichment.status, "queued"))).length,
    ).toBe(0);
    expect(await enqueueEmailSearch(db, [])).toBe(0);
  });

  it("işçi 'enrich.email' işini demo web ile uçtan uca yürütür", async () => {
    const ids = await scanAndEnrich(30);
    clearJobHandlers();
    registerCoreHandlers();
    registerEmailHandlers();
    await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
    await enqueueEmailSearch(db, ids);
    const worker = new Worker({ db, workerId: "w-test", log: () => undefined });
    while (await worker.tick()) {
      /* kuyruk boşalana kadar */
    }
    const states = await db.select().from(leadEnrichment);
    expect(states.length).toBe(30);
    expect(states.some((s) => s.status === "done")).toBe(true);
    expect(states.some((s) => s.status === "queued" || s.status === "running")).toBe(false);
  });

  it("onay verilmemişse e-posta işi çalışmaz (veri toplama kapısı)", async () => {
    const ids = await scanAndEnrich(3);
    clearJobHandlers();
    registerEmailHandlers();
    await db.update(jobs).set({ status: "done" });
    await enqueueEmailSearch(db, ids);
    const worker = new Worker({ db, workerId: "w-test", log: () => undefined });
    await worker.tick();
    const job = (await db.select().from(jobs).where(eq(jobs.type, EMAIL_JOB)))[0]!;
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("onay");
  });

  it("place.enriched olayı (findEmails) lead'leri e-posta aramasına yönlendirir", async () => {
    const cafes = (await db.select().from(categorySets))
      .filter((c) => c.key === "cafe")
      .map((c) => c.id);
    const { scanId } = await createAndStartScan(db, {
      region: { kind: "city", name: "London", countryCode: "GB", bbox: londonBox },
      categoryIds: cafes,
    });
    await runScan(
      {
        db,
        provider: provider(),
        getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
        minIntervalMs: 0,
      },
      scanId,
    );
    const placeIds = (await db.select({ id: places.placeId }).from(places).limit(5)).map(
      (r) => r.id,
    );
    bindEmailEvents();
    const deps = {
      db,
      provider: provider(),
      getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
      getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
      sleep: async () => undefined,
    };
    await enrichPlaces(deps, placeIds, "enrich"); // findEmails yok → iş eklenmez
    expect(await db.select().from(jobs).where(eq(jobs.type, EMAIL_JOB))).toHaveLength(0);
    await enrichPlaces(deps, placeIds, "enrich", { findEmails: true });
    const queued = await db.select().from(jobs).where(eq(jobs.type, EMAIL_JOB));
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as { leadIds: number[] }).leadIds).toHaveLength(5);
    expect(createDemoResolver).toBeDefined();
  });
});

describe("üretim bağımlılıkları (deps)", () => {
  it("User-Agent: belirteç, sürüm ve (varsa) şirket sitesi ile kimlik verir", () => {
    expect(buildUserAgent()).toMatch(
      new RegExp(`^${AGENT_TOKEN}/\\d+\\.\\d+\\.\\d+ \\(B2B business-contact lookup\\)$`),
    );
    expect(buildUserAgent("https://firma.example")).toContain("; +https://firma.example)");
    expect(buildUserAgent("firma.example")).toContain("; +https://firma.example)");
    expect(buildUserAgent("  ")).not.toContain("+");
  });

  it("demo: çevrimdışı web, bekleme yok, harici servis yok", async () => {
    const d = await createEmailDeps(db, { useExternal: true });
    expect(d.delayMs).toBe(0);
    expect(d.fetch).not.toBe(safeFetch);
    expect(d.external).toBeNull();
  });

  it("Google modu: güvenli HTTP istemcisi, ≥ 1 sn aralık, ≤ 6 istek, 4'ten fazla eşzamanlılık yok; harici servis yalnızca etkin + anahtar + istek varsa", async () => {
    await setSetting(db, "places.provider", "google");
    await setSetting(db, "company.profile", {
      legalName: "Örnek",
      address: "Ankara adres",
      taxId: "123",
      phone: "+90 312 000",
      contactName: "Ayşe",
      website: "https://ornek.example",
    });
    let d = await createEmailDeps(db, { useExternal: true });
    expect(d).toMatchObject({ delayMs: 1000, maxRequests: 6, timeoutMs: 10_000, concurrency: 4 });
    expect(d.fetch).toBe(safeFetch);
    expect(d.userAgent).toContain("+https://ornek.example");
    expect(d.external).toBeNull(); // ayar kapalı

    await setSetting(db, "enrichment.external", { enabled: true, provider: "hunter" });
    expect((await createEmailDeps(db, { useExternal: true })).external).toBeNull(); // anahtar yok
    await setSecret("hunter.apiKey", "hunter-test-key-1234567890");
    expect((await createEmailDeps(db, { useExternal: true })).external?.id).toBe("hunter");
    expect((await createEmailDeps(db, { useExternal: false })).external).toBeNull(); // bu aramada istenmedi

    await setSetting(db, "enrichment.concurrency", 2);
    d = await createEmailDeps(db, { concurrency: 3, delayMs: 5 });
    expect(d).toMatchObject({ concurrency: 3, delayMs: 5 });
    expect((await createEmailDeps(db)).concurrency).toBe(2);
  });
});
