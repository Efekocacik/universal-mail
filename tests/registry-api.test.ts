import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, jobs, leads, registryCompanies, registryRuns } from "@/lib/db/schema";
import { enqueueJob, failJob } from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/registry";
import { NonRetryableJobError } from "@/lib/jobs/registry";
import { handleRegistryFetch, handleRegistryMatch } from "@/lib/registry/jobs";
import {
  decodeCursor,
  encodeCursor,
  executeFetch,
  reapOrphanRuns,
  promoteToLead,
  refreshRunCounts,
  RegistryFetchInterrupted,
  registryHttp,
  runMatch,
  upsertCompanies,
} from "@/lib/registry/service";
import { RegistryProviderError, type RegistryProvider } from "@/lib/registry/types";
import { setSecret } from "@/lib/secrets/store";
import { setSetting } from "@/lib/settings";
import * as leadsRoute from "@/app/api/leads/route";
import * as companiesRoute from "@/app/api/registry/companies/route";
import * as leadRoute from "@/app/api/registry/companies/[id]/lead/route";
import * as matchRoute from "@/app/api/registry/match/route";
import * as runRoute from "@/app/api/registry/runs/[id]/route";
import * as runsRoute from "@/app/api/registry/runs/route";
import * as testRoute from "@/app/api/registry/test/route";
import {
  completeSetup,
  drainRegistryJobs,
  params,
  req,
  seedPlace,
} from "./fixtures/registry/helpers";
import { createTestDb, type TestDb } from "./helpers/db";

/** Uç nokta + iş entegrasyonu (geçici veritabanı, sahte HTTP, YAPAY adlar). */

let t: TestDb;
let db: Db;
const json = async (r: Response) => (await r.json()) as Record<string, any>;

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  registryHttp.deps = {};
  delete process.env.UM_INSEE_API_KEY;
  await t.cleanup();
});

const runPost = (body: unknown) =>
  runsRoute.POST(req("POST", "/api/registry/runs", body), undefined);
const companies = async (qs = "") =>
  json(await companiesRoute.GET(req("GET", `/api/registry/companies${qs}`), undefined));

async function liveSetup() {
  await completeSetup(db, "google");
  await setSecret("google.placesKey", "test-places-key-0001");
}

function fakeCh(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: URL[] = [];
  registryHttp.deps = {
    sleep: async () => undefined,
    fetchImpl: (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch,
  };
  return calls;
}

describe("kapılar ve doğrulama", () => {
  it("kurulum yoksa 400 SETUP_REQUIRED; geçersiz gövde VALIDATION", async () => {
    const r = await runPost({ source: "companies_house" });
    expect((await json(r)).code).toBe("SETUP_REQUIRED");
    await completeSetup(db);
    expect((await json(await runPost({ source: "ch" }))).code).toBe("VALIDATION");
    expect((await json(await runPost({ source: "insee", extra: 1 }))).code).toBe("VALIDATION");
    expect((await json(await runPost({ source: "insee", windowDays: 0 }))).code).toBe("VALIDATION");
    // Kod biçimi kaynağa göre: NAF kodu Companies House'ta geçersiz.
    const bad = await runPost({ source: "companies_house", codes: ["56.30Z"] });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("VALIDATION");
  });

  it("canlı: kapalı → REGISTRY_DISABLED, anahtarsız → REGISTRY_KEY_MISSING, NAF2025 → REGISTRY_SCHEME_UNAVAILABLE", async () => {
    await liveSetup();
    expect((await json(await runPost({ source: "companies_house" }))).code).toBe(
      "REGISTRY_DISABLED",
    );
    await setSetting(db, "registry.companiesHouse", {
      enabled: true,
      sicCodes: ["56102"],
      windowDays: 30,
    });
    expect((await json(await runPost({ source: "companies_house" }))).code).toBe(
      "REGISTRY_KEY_MISSING",
    );
    await setSetting(db, "registry.insee", {
      enabled: true,
      nafCodes: ["56.30Z"],
      windowDays: 30,
      scheme: "NAF2025",
    });
    const r = await runPost({ source: "insee" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("REGISTRY_SCHEME_UNAVAILABLE");
  });

  it("çalışma/şirket bulunamadı ve geçersiz kimlik", async () => {
    await completeSetup(db);
    expect(
      (await json(await runRoute.GET(req("GET", "/api/registry/runs/9"), params(9)))).code,
    ).toBe("NOT_FOUND");
    expect(
      (await json(await runRoute.GET(req("GET", "/api/registry/runs/x"), params("x")))).code,
    ).toBe("INVALID_ID");
    const r = await leadRoute.POST(req("POST", "/api/registry/companies/7/lead", {}), params(7));
    expect(r.status).toBe(404);
    expect(
      (
        await json(
          await companiesRoute.GET(req("GET", "/api/registry/companies?cursor=%%%"), undefined),
        )
      ).code,
    ).toBe("VALIDATION");
    expect(
      (
        await json(
          await companiesRoute.GET(req("GET", "/api/registry/companies?match=bogus"), undefined),
        )
      ).code,
    ).toBe("VALIDATION");
    expect(
      (
        await json(
          await matchRoute.POST(req("POST", "/api/registry/match", { runId: 99 }), undefined),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });
});

describe("demo akışı: çalışma → çekme → eşleştirme → lead", () => {
  it("202 + iş; ikinci çalışma 409; işler sayaçları doldurur; lead'e dönüştürme ve süzgeçler", async () => {
    await completeSetup(db);
    // Önbellekte Londra yerleri yoksa her şey "bekliyor" (no_cache) kalır.
    const created = await runPost({
      source: "companies_house",
      locality: "London",
      codes: ["56102"],
    });
    expect(created.status).toBe(202);
    const { run, jobId } = await json(created);
    expect(run).toMatchObject({
      status: "queued",
      isDemo: true,
      activityScheme: "SIC2007",
      activityCodes: ["56102"],
    });
    expect(jobId).toBeGreaterThan(0);
    const again = await runPost({ source: "companies_house" });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("REGISTRY_RUN_ACTIVE");

    expect(await drainRegistryJobs(db)).toEqual(["registry.fetch", "registry.match"]);
    const after = await json(
      await runRoute.GET(req("GET", `/api/registry/runs/${run.id}`), params(run.id)),
    );
    expect(after.run.status).toBe("done");
    expect(after.run.fetchedCount).toBeGreaterThan(10);
    expect(after.run.newCount).toBe(after.run.fetchedCount);
    expect(after.run.pendingCount).toBe(after.run.fetchedCount);
    const first = await companies();
    expect(first.stats).toMatchObject({ matched: 0, pending: first.stats.total });
    expect(first.items[0].matchReason).toBe("no_cache");

    // Bir demo kaydın adıyla haritada yer olsun → yeniden eşleştir.
    const target = first.items.find(
      (c: { name: string }) => !/BIRCH|COBALT|JUNIPER|MARLOW|PEBBLE|QUILL|ROWAN|TIDAL/.test(c.name),
    );
    const [row] = await db
      .select()
      .from(registryCompanies)
      .where(eq(registryCompanies.id, target.id));
    const place = await seedPlace(db, {
      name: row!.name.replace(/ LTD$/, "").toLowerCase(),
      city: row!.locality!,
      address: `${row!.addressLine}, ${row!.locality}`,
    });
    const m = await matchRoute.POST(req("POST", "/api/registry/match", {}), undefined);
    expect(m.status).toBe(202);
    expect(
      (await json(await matchRoute.POST(req("POST", "/api/registry/match", {}), undefined))).code,
    ).toBe("REGISTRY_MATCH_ACTIVE");
    const listing = await json(
      await runsRoute.GET(req("GET", "/api/registry/runs?limit=5"), undefined),
    );
    expect(listing.matchActive).toBe(true);
    await drainRegistryJobs(db);
    const matched = await companies("?match=matched");
    expect(matched.items).toHaveLength(1);
    expect(matched.items[0]).toMatchObject({
      id: target.id,
      matchedPlaceId: place.placeId,
      matchedLeadId: place.leadId,
      matchReason: "name_address",
    });
    expect(
      (await companies(`?leadId=${place.leadId}`)).items.map((c: { id: number }) => c.id),
    ).toEqual([target.id]);

    // Eşleşen kayıt lead'e dönüştürülemez (yerin lead'i döner).
    const dup = await leadRoute.POST(
      req("POST", `/api/registry/companies/${target.id}/lead`, {}),
      params(target.id),
    );
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ code: "REGISTRY_MATCHED", leadId: place.leadId });

    // Eşleşmeyen kayıt → lead (yer kimliksiz); ikinci kez 409.
    const open = await companies("?match=unmatched,pending&limit=5");
    const pick = open.items[0];
    const promoted = await leadRoute.POST(
      req("POST", `/api/registry/companies/${pick.id}/lead`, {}),
      params(pick.id),
    );
    expect(promoted.status).toBe(201);
    const { leadId } = await json(promoted);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({
      source: "registry",
      placeId: null,
      countryCode: "GB",
      categoryKey: "cafe",
    });
    const twice = await leadRoute.POST(
      req("POST", `/api/registry/companies/${pick.id}/lead`, {}),
      params(pick.id),
    );
    expect(await json(twice)).toMatchObject({ code: "REGISTRY_ALREADY_LEAD", leadId });
    expect((await companies(`?leadId=${leadId}`)).items[0].leadId).toBe(leadId);

    // /api/leads: yer kimliksiz lead listelenir; kaynak ve sicil eşleşmesi süzgeçleri.
    const list = async (qs: string) =>
      json(await leadsRoute.GET(req("GET", `/api/leads?${qs}`), undefined));
    const reg = await list("source=registry");
    expect(reg.rows.map((r: { leadId: number }) => r.leadId)).toEqual([leadId]);
    expect(reg.rows[0]).toMatchObject({
      placeId: null,
      name: lead!.displayName,
      businessStatus: "OPERATIONAL",
    });
    const yes = await list("registryMatch=1");
    expect(yes.rows.map((r: { leadId: number }) => r.leadId).sort()).toEqual(
      [place.leadId, leadId].sort(),
    );
    const no = await list("registryMatch=0");
    expect(no.total).toBe(0);
    expect((await list("source=import")).total).toBe(0);
    expect((await list("source=nope")).code).toBe("FILTER_INVALID");

    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "registry.run_create",
        "registry.match_enqueue",
        "registry.lead_create",
      ]),
    );
  });

  it("anahtar kümesi sayfalama: sırayla, tekrarsız; arama", async () => {
    await completeSetup(db);
    await runPost({ source: "companies_house", codes: ["56102", "56302"] });
    await drainRegistryJobs(db);
    const all = await companies("?limit=100");
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await companies(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((c: { id: number }) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((c: { id: number }) => c.id));
    expect(new Set(seen).size).toBe(seen.length);
    const firstWord = all.items[0].name.split(" ")[0];
    const found = await companies(`?q=${encodeURIComponent(firstWord.toLowerCase())}`);
    expect(found.items.length).toBeGreaterThan(0);
    expect((await companies("?q=%25_nothing")).items).toHaveLength(0);
    expect((await companies("?source=insee&country=FR")).stats.total).toBe(0);
    expect(decodeCursor(encodeCursor("2026-11-01", 5))).toEqual({ inc: "2026-11-01", id: 5 });
    expect(decodeCursor(Buffer.from("x|y").toString("base64url"))).toBeNull();
  });

  it("FR demo: tabela adı ve NAF; sına uç noktası demo", async () => {
    await completeSetup(db);
    const r = await runPost({ source: "insee", locality: "Paris" });
    expect(r.status).toBe(202);
    await drainRegistryJobs(db);
    const fr = await companies("?country=FR&limit=3");
    expect(fr.items[0]).toMatchObject({ countryCode: "FR", isDemo: true });
    expect(fr.items[0].tradingName).toBeTruthy();
    const test = await testRoute.POST(
      req("POST", "/api/registry/test", { source: "insee" }),
      undefined,
    );
    expect(await json(test)).toEqual({ ok: true, demo: true });
  });
});

describe("canlı akış (sahte HTTP)", () => {
  async function enableCh() {
    await liveSetup();
    await setSetting(db, "registry.companiesHouse", {
      enabled: true,
      sicCodes: ["56102"],
      windowDays: 14,
    });
    await setSecret("registry.companiesHouseKey", "test-ch-key-0001");
  }

  it("çekme sayfalar, upsert idempotenttir; tekrar çalışma mevcutları yeni saymaz", async () => {
    await enableCh();
    const item = (n: number) => ({
      company_number: `7000000${n}`,
      company_name: `SAMPLE ${n} CAFE LTD`,
      date_of_creation: "2026-11-10",
      sic_codes: ["56102"],
      registered_office_address: { locality: "London", postal_code: "EC1A 1ZZ" },
    });
    fakeCh({ hits: 2, items: [item(1), item(2)] });
    expect((await runPost({ source: "companies_house" })).status).toBe(202);
    await drainRegistryJobs(db);
    const [r1] = await db.select().from(registryRuns);
    expect(r1).toMatchObject({ status: "done", isDemo: false, fetchedCount: 2, newCount: 2 });
    fakeCh({ hits: 3, items: [item(1), item(2), item(3)] });
    await runPost({ source: "companies_house" });
    await drainRegistryJobs(db);
    const runs = await db.select().from(registryRuns).orderBy(registryRuns.id);
    expect(runs[1]).toMatchObject({ fetchedCount: 3, newCount: 1 });
    expect((await db.select().from(registryCompanies)).length).toBe(3);
    // Önceki çalışmanın kayıtları yeni çalışmaya geçti (`last_run_id`). Sayaçlar anlık görüntüdür: genel yeniden sayım
    // yalnızca kaynağın EN YENİ çalışmasını günceller; eski çalışmanın geçmişi 0/0/0'a düşmez.
    await refreshRunCounts(db, null);
    await refreshRunCounts(db, runs[0]!.id);
    const after = await db.select().from(registryRuns).orderBy(registryRuns.id);
    expect(after[0]).toMatchObject({ fetchedCount: 2, pendingCount: 2 });
    expect(after[1]).toMatchObject({ fetchedCount: 3, pendingCount: 3 });
  });

  it("geçici hatadan sonra yeniden deneme: ilk denemede eklenen kayıtlar da yeni sayılır", async () => {
    await enableCh();
    const item = (n: number) => ({
      company_number: `7100000${n}`,
      company_name: `RETRY ${n} CAFE LTD`,
      date_of_creation: "2026-11-10",
      sic_codes: ["56102"],
      registered_office_address: { locality: "London", postal_code: "EC1A 1ZZ" },
    });
    // Önceden görülmüş bir kayıt yeni sayılmamalı.
    fakeCh({ hits: 1, items: [item(9)] });
    await runPost({ source: "companies_house" });
    await drainRegistryJobs(db);
    // İkinci çalışma: ilk sayfa gelir, ikinci sayfa 503 → iş yeniden denenir.
    let calls = 0;
    registryHttp.deps = {
      sleep: async () => undefined,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls++;
        const start = Number(new URL(String(input)).searchParams.get("start_index") ?? 0);
        if (calls === 2) return new Response("{}", { status: 503 });
        const body =
          start === 0
            ? { hits: 4, items: [item(1), item(2)] }
            : { hits: 4, items: [item(3), item(9)] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    };
    await runPost({ source: "companies_house" });
    const [, run2] = await db.select().from(registryRuns).orderBy(registryRuns.id);
    const ctx = { shouldStop: () => false, log: () => undefined };
    await expect(executeFetch(db, run2!.id, { ...ctx, finalAttempt: false })).rejects.toThrow();
    expect(await executeFetch(db, run2!.id, { ...ctx, finalAttempt: false })).toBe("done");
    const [done] = await db.select().from(registryRuns).where(eq(registryRuns.id, run2!.id));
    expect(done).toMatchObject({ status: "done", fetchedCount: 4, newCount: 3 });
  });

  it("401 → çalışma failed REGISTRY_AUTH, iş yeniden denenmez; sına uç noktası 400", async () => {
    await enableCh();
    fakeCh({}, 401);
    await runPost({ source: "companies_house" });
    await drainRegistryJobs(db);
    const [run] = await db.select().from(registryRuns);
    expect(run).toMatchObject({ status: "failed", errorCode: "REGISTRY_AUTH" });
    expect(run!.finishedAt).not.toBeNull();
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "registry.fetch"));
    expect(job!.status).toBe("failed");
    const test = await testRoute.POST(
      req("POST", "/api/registry/test", { source: "companies_house" }),
      undefined,
    );
    expect(test.status).toBe(400);
    expect((await json(test)).code).toBe("REGISTRY_AUTH");
    // Hata kalıcıdır; yeni çalışma başlatılabilir (etkin çalışma kalmadı).
    expect((await runPost({ source: "companies_house" })).status).toBe(202);
  });

  it("429: Retry-After kadar beklenir (≤ 60 sn) ve sayfa yeniden denenir; sürerse geçici hata", async () => {
    await enableCh();
    const waits: number[] = [];
    let n = 0;
    registryHttp.deps = {
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: (async () => {
        n++;
        if (n === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "120" } });
        return new Response(JSON.stringify({ hits: 0, items: [] }), { status: 200 });
      }) as typeof fetch,
    };
    await runPost({ source: "companies_house" });
    await drainRegistryJobs(db);
    expect(waits).toContain(60_000);
    const [run] = await db.select().from(registryRuns);
    expect(run!.status).toBe("done");

    // Sürekli 429: iş geçici hatayla yeniden kuyruğa; son denemede çalışma failed REGISTRY_RATE.
    const provider: RegistryProvider = {
      source: "companies_house",
      isDemo: false,
      search: async () => {
        throw new RegistryProviderError("REGISTRY_RATE", "x", 1);
      },
      test: async () => undefined,
    };
    const [r2] = await db
      .insert(registryRuns)
      .values({
        source: "insee",
        activityScheme: "NAFRev2",
        activityCodes: ["56.30Z"],
        windowFrom: "2026-11-01",
        windowTo: "2026-11-15",
        createdAt: Date.now(),
      })
      .returning();
    const ctx = {
      shouldStop: () => false,
      log: () => undefined,
      provider,
      sleep: async () => undefined,
    };
    await expect(executeFetch(db, r2!.id, { ...ctx, finalAttempt: false })).rejects.toBeInstanceOf(
      RegistryProviderError,
    );
    expect(
      (await db.select().from(registryRuns).where(eq(registryRuns.id, r2!.id)))[0]!.status,
    ).toBe("running");
    await expect(executeFetch(db, r2!.id, { ...ctx, finalAttempt: true })).rejects.toThrow(
      /REGISTRY_RATE/,
    );
    expect(
      (await db.select().from(registryRuns).where(eq(registryRuns.id, r2!.id)))[0],
    ).toMatchObject({
      status: "failed",
      errorCode: "REGISTRY_RATE",
    });
    // Bitmiş çalışma yeniden teslimde atlanır (idempotent).
    expect(await executeFetch(db, r2!.id, { ...ctx, finalAttempt: false })).toBe("skipped");
  });

  it("işçi kapanışı deneme hakkı harcamaz: son denemede bile çalışma failed olmaz, iş gecikmesiz yeniden kuyruğa", async () => {
    await enableCh();
    await runPost({ source: "companies_house" });
    const [run] = await db.select().from(registryRuns);
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "registry.fetch"));
    // Döngü işi kaparken `attempts`'ı artırır: bu son deneme (3/3).
    await db.update(jobs).set({ status: "running", attempts: 3 }).where(eq(jobs.id, job!.id));
    const logs: string[] = [];
    const ctx: JobContext = {
      job: { ...job!, status: "running", attempts: 3 },
      payload: job!.payload,
      db,
      shouldStop: () => true,
      log: (m) => void logs.push(m),
    };
    const err = await handleRegistryFetch(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryFetchInterrupted);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect(ctx.job.attempts).toBe(2);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.attempts).toBe(2);
    // Döngünün yaptığı: failJob(ctx.job) → deneme hakkı kaldığı için yeniden kuyruğa.
    expect(await failJob(db, ctx.job, String(err))).toBe("queued");
    expect((await db.select().from(registryRuns))[0]).toMatchObject({
      status: "running",
      errorCode: null,
    });
    expect(logs.join(" ")).not.toMatch(/REGISTRY_/);
    // Sonraki açılışta iş sürer ve çalışma tamamlanır.
    fakeCh({ hits: 0, items: [] });
    await db.update(jobs).set({ runAt: 0 }).where(eq(jobs.id, job!.id));
    await drainRegistryJobs(db);
    expect((await db.select().from(registryRuns))[0]!.id).toBe(run!.id);
    expect((await db.select().from(registryRuns))[0]!.status).toBe("done");
  });

  it("işçi kapanırken iş yeniden denenir; çalışma açık kalır", async () => {
    await enableCh();
    await runPost({ source: "companies_house" });
    const [run] = await db.select().from(registryRuns);
    await expect(
      executeFetch(db, run!.id, {
        shouldStop: () => true,
        log: () => undefined,
        finalAttempt: false,
      }),
    ).rejects.toThrow(/kapanıyor/);
    expect((await db.select().from(registryRuns))[0]!.status).toBe("running");
  });

  it("öksüz çalışma (işi yok) yeni çalışmayı kilitlemez", async () => {
    await completeSetup(db);
    const old = Date.now() - 5 * 60_000;
    await db.insert(registryRuns).values({
      source: "companies_house",
      status: "running",
      activityScheme: "SIC2007",
      activityCodes: ["56102"],
      windowFrom: "2026-11-01",
      windowTo: "2026-11-15",
      createdAt: old,
    });
    expect((await runPost({ source: "companies_house" })).status).toBe(202);
    const rows = await db.select().from(registryRuns).orderBy(registryRuns.id);
    expect(rows[0]).toMatchObject({ status: "failed", errorCode: "REGISTRY_UPSTREAM" });
    // İşi canlı olan çalışma biçilmez.
    expect(await reapOrphanRuns(db, "companies_house", Date.now() + 5 * 60_000)).toBe(0);
  });

  it("sına: anahtar yok → REGISTRY_KEY_MISSING; ortam değişkeni anahtarı sayılır; canlı başarı", async () => {
    await liveSetup();
    const miss = await testRoute.POST(
      req("POST", "/api/registry/test", { source: "insee" }),
      undefined,
    );
    expect((await json(miss)).code).toBe("REGISTRY_KEY_MISSING");
    process.env.UM_INSEE_API_KEY = "test-insee-env-key-01";
    fakeCh({}, 404);
    const ok = await testRoute.POST(
      req("POST", "/api/registry/test", { source: "insee" }),
      undefined,
    );
    expect(await json(ok)).toEqual({ ok: true, demo: false });
    fakeCh({}, 503);
    const down = await testRoute.POST(
      req("POST", "/api/registry/test", { source: "insee" }),
      undefined,
    );
    expect(down.status).toBe(502);
  });
});

describe("iş işleyicileri", () => {
  const ctxFor = async (type: string, payload: unknown): Promise<JobContext> => {
    const id = (await enqueueJob(db, type, payload))!;
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    return { job: job!, payload, db, shouldStop: () => false, log: () => undefined };
  };

  it("geçersiz yük kalıcı hatadır; olmayan çalışma atlanır; eşleştirme boş veriyle çalışır", async () => {
    await expect(
      handleRegistryFetch(await ctxFor("registry.fetch", { runId: "x" })),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    await expect(handleRegistryMatch(await ctxFor("registry.match", {}))).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    await expect(
      handleRegistryFetch(await ctxFor("registry.fetch", { runId: 404 })),
    ).resolves.toBeUndefined();
    await expect(
      handleRegistryMatch(await ctxFor("registry.match", { runId: null })),
    ).resolves.toBeUndefined();
    expect(await runMatch(db, null)).toEqual({
      considered: 0,
      matched: 0,
      unmatched: 0,
      pending: 0,
    });
  });

  it("elle/ret kararlarına dokunulmaz; yeri silinmiş eşleşme yeniden denenir", async () => {
    await completeSetup(db);
    const p = await seedPlace(db, { name: "Lantern Kettle", city: "York" });
    const [run] = await db
      .insert(registryRuns)
      .values({
        source: "companies_house",
        status: "done",
        activityScheme: "SIC2007",
        activityCodes: ["56102"],
        windowFrom: "2026-11-01",
        windowTo: "2026-11-15",
        createdAt: Date.now(),
        finishedAt: Date.now(),
      })
      .returning();
    const base = {
      countryCode: "GB" as const,
      activityScheme: "SIC2007" as const,
      activityCodes: ["56102"],
      incorporatedOn: "2026-11-05",
      postcode: null,
      locality: "York",
      addressLine: null,
      registryStatus: "active",
      tradingName: null,
    };
    await upsertCompanies(
      db,
      [
        { ...base, externalId: "M1", name: "LANTERN KETTLE LTD" },
        { ...base, externalId: "M2", name: "LANTERN KETTLE LIMITED" },
        { ...base, externalId: "M3", name: "LANTERN KETTLE CO" },
      ],
      { source: "companies_house", isDemo: false, runId: run!.id, now: Date.now() },
    );
    await db
      .update(registryCompanies)
      .set({ matchStatus: "rejected" })
      .where(eq(registryCompanies.externalId, "M1"));
    await db
      .update(registryCompanies)
      .set({ matchStatus: "matched", matchedPlaceId: null })
      .where(eq(registryCompanies.externalId, "M2"));
    await db
      .update(registryCompanies)
      .set({ matchStatus: "manual" })
      .where(eq(registryCompanies.externalId, "M3"));
    const s = await runMatch(db, run!.id);
    expect(s).toEqual({ considered: 1, matched: 1, unmatched: 0, pending: 0 });
    const rows = await db.select().from(registryCompanies).orderBy(registryCompanies.externalId);
    expect(rows.map((r) => [r.externalId, r.matchStatus, r.matchedPlaceId])).toEqual([
      ["M1", "rejected", null],
      ["M2", "matched", p.placeId],
      ["M3", "manual", null],
    ]);
    const [counted] = await db.select().from(registryRuns).where(eq(registryRuns.id, run!.id));
    expect(counted).toMatchObject({ matchedCount: 2, unmatchedCount: 1, pendingCount: 0 });
  });
});

describe("sicilden oluşturulan lead ile harita lead'i çakışmaz", () => {
  const base = {
    countryCode: "GB" as const,
    activityScheme: "SIC2007" as const,
    activityCodes: ["56102"],
    incorporatedOn: "2026-11-05",
    postcode: null,
    locality: "Leeds",
    addressLine: null,
    registryStatus: "active",
    tradingName: null,
  };
  async function doneRun() {
    const [run] = await db
      .insert(registryRuns)
      .values({
        source: "companies_house",
        status: "done",
        activityScheme: "SIC2007",
        activityCodes: ["56102"],
        windowFrom: "2026-11-01",
        windowTo: "2026-11-15",
        createdAt: Date.now(),
        finishedAt: Date.now(),
      })
      .returning();
    return run!;
  }

  it("lead'e dönüştür → o şehirde tarama → yeniden eşleştir: kayıt yere bağlanmaz, tek lead kalır", async () => {
    await completeSetup(db);
    const run = await doneRun();
    await upsertCompanies(
      db,
      [
        { ...base, externalId: "D1", name: "FERN HOLLOW CAFE LTD" },
        { ...base, externalId: "D2", name: "QUARTZ LANE BAKERY LTD" },
      ],
      { source: "companies_house", isDemo: false, runId: run.id, now: Date.now() },
    );
    // Önbellekte Leeds yok → ikisi de bekliyor; biri lead'e dönüştürülür.
    await runMatch(db, null);
    const [d1] = await db
      .select()
      .from(registryCompanies)
      .where(eq(registryCompanies.externalId, "D1"));
    const { leadId } = await promoteToLead(db, d1!.id);
    // Sonra kullanıcı Leeds'i tarar: aynı işletmeler haritada da bulunur.
    const p1 = await seedPlace(db, { name: "Fern Hollow Cafe", city: "Leeds" });
    const p2 = await seedPlace(db, { name: "Quartz Lane Bakery", city: "Leeds" });
    const s = await runMatch(db, null);
    expect(s).toMatchObject({ considered: 1, matched: 1 });
    const rows = await db.select().from(registryCompanies).orderBy(registryCompanies.externalId);
    expect(rows.map((r) => [r.externalId, r.leadId, r.matchStatus, r.matchedPlaceId])).toEqual([
      ["D1", leadId, "pending", null],
      ["D2", null, "matched", p2.placeId],
    ]);
    // Rozet sorgusu: sicil lead'i kendi kaydını, harita lead'i yalnızca eşleşen kaydı görür.
    expect((await companies(`?leadId=${leadId}`)).items.map((c: { id: number }) => c.id)).toEqual([
      d1!.id,
    ]);
    expect((await companies(`?leadId=${p1.leadId}`)).items).toHaveLength(0);
  });

  it("REGISTRY_MATCHED arşivlenmiş lead'i göstermez", async () => {
    await completeSetup(db);
    const run = await doneRun();
    const p = await seedPlace(db, { name: "Amber Wick", city: "Leeds" });
    await upsertCompanies(db, [{ ...base, externalId: "A1", name: "AMBER WICK LTD" }], {
      source: "companies_house",
      isDemo: false,
      runId: run.id,
      now: Date.now(),
    });
    await runMatch(db, run.id);
    const [c] = await db.select().from(registryCompanies);
    expect(c!.matchedPlaceId).toBe(p.placeId);
    await db.update(leads).set({ archivedAt: Date.now() }).where(eq(leads.id, p.leadId));
    const r = await leadRoute.POST(
      req("POST", `/api/registry/companies/${c!.id}/lead`, {}),
      params(c!.id),
    );
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ code: "REGISTRY_MATCHED", leadId: null });
  });
});
