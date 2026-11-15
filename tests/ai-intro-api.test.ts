import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as introRoute from "@/app/api/leads/[id]/intro/route";
import * as introItemRoute from "@/app/api/leads/[id]/intro/[introId]/route";
import * as aiTestRoute from "@/app/api/ai/test/route";
import * as aiUsageRoute from "@/app/api/ai/usage/route";
import * as secretsRoute from "@/app/api/secrets/route";
import { createClaudeIntroGenerator, type ClaudeFetch } from "@/lib/ai/claude";
import { aiUsage, generateLeadIntro, IntroError, INTRO_LIMITS } from "@/lib/ai/service";
import { getDb, type Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import { auditLog, leadEnrichment, leadIntros, leads, places } from "@/lib/db/schema";
import { buildRenderContext } from "@/lib/mail/render-context";
import { renderTemplate } from "@/lib/mail/template-engine";
import { previewTemplateDraft } from "@/lib/mail/template-service";
import { setSecret } from "@/lib/secrets/store";
import { setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Kişisel giriş uçları (geçici veritabanı, sahte HTTP): kapılar (kurulum, kapalı, anahtar), demo yaşam döngüsü
 * (üret → düzenle → onayla → ikinci onay öncekini indirir), `{{kisisel_giris}}` değeri (onaylı → metin; yalnızca taslak →
 * eksik/yedek), hız sınırı, kullanım özeti, anahtar sınaması ve Claude'a giden gövdede Google önbellek verisinin
 * OLMADIĞI (önbelleğe gözcü dizgi konur). Gerçek Anthropic API çağrılmaz.
 */

const ORIGIN = "http://127.0.0.1:3000";
const KEY = "sk-test-not-a-real-key-000000";
const SENTINEL = "GOOGLESENTINELNAME";
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const idp = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const itemp = (id: number, introId: number | string) => ({
  params: Promise.resolve({ id: String(id), introId: String(introId) }),
});
const post = (leadId: number, body: unknown = {}) =>
  introRoute.POST(req("POST", `/api/leads/${leadId}/intro`, body), idp(leadId));
const patch = (leadId: number, introId: number, body: unknown) =>
  introItemRoute.PATCH(
    req("PATCH", `/api/leads/${leadId}/intro/${introId}`, body),
    itemp(leadId, introId),
  );
const list = async (leadId: number) =>
  (await json(await introRoute.GET(req("GET", `/api/leads/${leadId}/intro`), idp(leadId))))
    .intros as Record<string, any>[];

async function setup(provider: "mock" | "google" = "mock", ai = true) {
  await setSetting(db, "places.provider", provider);
  if (provider === "google") await setSecret("google.placesKey", "places-test-key-0000000000");
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
  await setSetting(db, "targets.countries", ["GB"]);
  await setSetting(db, "setup.completed", true);
  if (ai)
    await setSetting(db, "ai.intro", {
      enabled: true,
      model: "claude-opus-5-5",
      costAckAt: Date.now(),
    });
}

async function addLead(o: Partial<typeof leads.$inferInsert> = {}): Promise<number> {
  const now = Date.now();
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "Leeds",
      categoryKey: "cafe",
      displayName: "Örnek Kahve Evi",
      createdAt: now,
      updatedAt: now,
      ...o,
    })
    .returning({ id: leads.id });
  return l!.id;
}

/** Google önbelleğinde gözcü dizgili bir işletme ve ona bağlı lead (ad/web/telefon Claude'a GİTMEMELİ). */
async function addGoogleLead(): Promise<number> {
  const now = Date.now();
  await db.insert(places).values({
    placeId: "p-sentinel",
    source: "demo",
    coordsFetchedAt: now,
    firstSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(placeCache).values({
    placeId: "p-sentinel",
    name: `${SENTINEL} Cafe`,
    formattedAddress: `${SENTINEL} Street 1`,
    types: ["cafe"],
    website: `https://${SENTINEL.toLowerCase()}.example`,
    phone: "+44 113 496 0001",
    fetchedAt: now,
  });
  return addLead({ placeId: "p-sentinel", displayName: null });
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.cleanup();
});

describe("POST /api/leads/:id/intro — kapılar", () => {
  it("lead yok 404, kurulum eksik 403, kapalı 400, bağlam yok 422, geçersiz dil 400", async () => {
    await setup("mock", false);
    expect((await json(await post(9999))).code).toBe("NOT_FOUND");
    const leadId = await addLead();
    const off = await post(leadId);
    expect(off.status).toBe(400);
    expect((await json(off)).code).toBe("AI_DISABLED");

    await setSetting(db, "ai.intro", { enabled: true, model: "claude-opus-5-5", costAckAt: 1 });
    const bare = await addLead({ displayName: null, city: null, categoryKey: null });
    const noCtx = await post(bare);
    expect(noCtx.status).toBe(422);
    expect((await json(noCtx)).code).toBe("AI_NO_CONTEXT");
    expect((await post(leadId, { language: "xx" })).status).toBe(400);
    expect((await post(leadId, { language: "en", extra: 1 })).status).toBe(400);

    await setSetting(db, "setup.completed", false);
    const setupRes = await post(leadId);
    expect(setupRes.status).toBe(403);
    expect((await json(setupRes)).code).toBe("SETUP_REQUIRED");
    expect(await db.select().from(leadIntros)).toHaveLength(0);
  });

  it("canlı kipte anahtar yoksa AI_KEY_MISSING; ağa çıkılmaz", async () => {
    await setup("google");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const leadId = await addLead();
    const r = await post(leadId);
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("AI_KEY_MISSING");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("demo yaşam döngüsü ve {{kisisel_giris}}", () => {
  it("üret → düzenle → onayla; ikinci onay öncekini reddedilene indirir; tek onaylı satır", async () => {
    await setup("mock");
    const leadId = await addLead();
    const r1 = await post(leadId); // dil verilmedi → GB → en
    expect(r1.status).toBe(201);
    const i1 = (await json(r1)).intro;
    expect(i1).toMatchObject({
      leadId,
      language: "en",
      status: "draft",
      model: "demo",
      estCostUsd: 0,
      approvedAt: null,
    });
    expect(i1.text).toContain("Leeds");

    // Yalnızca taslak varken değişken eksiktir: yedek kullanılır, yedeksiz ileti gönderilemez
    let ctx = await buildRenderContext(db, leadId, "en");
    expect(ctx.values.kisisel_giris).toBeNull();
    expect(ctx.introPending).toBe(true);
    const tpl = { subject: "Merhaba", bodyHtml: "<p>{{kisisel_giris}}</p>" };
    expect(renderTemplate(tpl, ctx.values).missing).toEqual(["kisisel_giris"]);
    expect(
      renderTemplate({ ...tpl, bodyHtml: "<p>{{kisisel_giris|Merhaba}}</p>" }, ctx.values).html,
    ).toContain("Merhaba");
    // Ön izleme "eksik" değil "onay bekliyor" der ve bunu yanıtta işaretler
    const pending = await previewTemplateDraft(
      db,
      { name: "P", language: "en", kind: "initial", subject: "Hello", bodyHtml: tpl.bodyHtml },
      leadId,
    );
    expect(pending.ok && pending.composed.introPending).toBe(true);
    expect(pending.ok && pending.composed.html).toContain("[onay bekliyor: kisisel_giris]");
    expect(pending.ok && pending.composed.html).not.toContain("[eksik: kisisel_giris]");

    const edited = "We noticed your café in Leeds and would love to send you some samples.";
    const saved = await patch(leadId, i1.id, { action: "save", text: `  ${edited} ` });
    expect(saved.status).toBe(200);
    expect((await json(saved)).intro).toMatchObject({ text: edited, status: "draft" });

    const ap = await patch(leadId, i1.id, { action: "approve" });
    expect((await json(ap)).intro).toMatchObject({ status: "approved", text: edited });
    ctx = await buildRenderContext(db, leadId, "en");
    expect(ctx.values.kisisel_giris).toBe(edited);
    expect(ctx.introPending).toBe(false);
    expect(renderTemplate(tpl, ctx.values)).toMatchObject({ missing: [] });
    // Başka dilde onaylı giriş yok
    expect((await buildRenderContext(db, leadId, "tr")).values.kisisel_giris).toBeNull();

    // Ön izleme gerçek lead üzerinden onaylı metni gösterir
    const pv = await previewTemplateDraft(
      db,
      { name: "P", language: "en", kind: "initial", subject: "Hello", bodyHtml: tpl.bodyHtml },
      leadId,
    );
    expect(pv.ok && pv.composed.html).toContain("would love to send you some samples");
    expect(pv.ok && pv.composed.introPending).toBe(false);

    // İkinci taslak onaylanınca ilki reddedilene iner
    const i2 = (await json(await post(leadId, { language: "en" }))).intro;
    const ap2 = await patch(leadId, i2.id, { action: "approve" });
    expect(ap2.status).toBe(200);
    const rows = await list(leadId);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [i2.id, "approved"],
      [i1.id, "rejected"],
    ]);
    expect(rows.find((r) => r.id === i1.id)!.approvedAt).toBeNull();
    expect((await buildRenderContext(db, leadId, "en")).values.kisisel_giris).toBe(i2.text);

    // Onaylıyı reddetmek değişkeni boşaltır; onaylı satırı düzenlemek onayı kaldırır
    await patch(leadId, i2.id, { action: "reject" });
    expect((await buildRenderContext(db, leadId, "en")).values.kisisel_giris).toBeNull();

    // Denetim kaydı metni içermez
    const audits = await db.select().from(auditLog);
    expect(audits.some((a) => a.action === "ai.intro.generated")).toBe(true);
    expect(audits.some((a) => a.action === "ai.intro.approve")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("send you some samples");
  });

  it("PATCH: geçersiz metin 400 INTRO_TEXT_INVALID; metinsiz save 400; başka lead'in girişi 404; katı gövde", async () => {
    await setup("mock");
    const a = await addLead();
    const b = await addLead({ displayName: "Başka Kafe" });
    const i = (await json(await post(a, { language: "tr" }))).intro;
    expect(i.text).toContain("Leeds bölgesindeki");
    for (const text of [
      "Visit https://x.example now please.",
      "Kuruluş 1999, hemen arayın lütfen.",
      "{{isletme_adi}} merhaba, tanışalım mı?",
    ]) {
      const r = await patch(a, i.id, { action: "approve", text });
      expect(r.status).toBe(400);
      expect((await json(r)).code).toBe("INTRO_TEXT_INVALID");
    }
    expect((await json(await patch(a, i.id, { action: "save" }))).code).toBe("INTRO_TEXT_INVALID");
    expect((await patch(b, i.id, { action: "approve" })).status).toBe(404);
    expect((await patch(a, 99999, { action: "approve" })).status).toBe(404);
    expect((await patch(a, i.id, { action: "publish" })).status).toBe(400);
    expect((await patch(a, i.id, { action: "approve", status: "approved" })).status).toBe(400);
    expect(
      (await introItemRoute.PATCH(req("PATCH", "/x", { action: "approve" }), itemp(a, "abc")))
        .status,
    ).toBe(400);
    // Hiçbir şey değişmedi
    expect((await list(a))[0]).toMatchObject({ status: "draft", text: i.text });
    expect((await introRoute.GET(req("GET", "/x"), idp(99999))).status).toBe(404);
  });

  it("hız sınırı: bir lead için saatte en çok 5 üretim (429 RATE_LIMITED)", async () => {
    await setup("mock");
    const leadId = await addLead();
    for (let i = 0; i < INTRO_LIMITS.perLeadPerHour; i++)
      expect((await post(leadId)).status).toBe(201);
    const r = await post(leadId);
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe("RATE_LIMITED");
    expect(await list(leadId)).toHaveLength(INTRO_LIMITS.perLeadPerHour);
  });
});

describe("canlı Claude (sahte fetch)", () => {
  const reply = (text: string, usage = { input_tokens: 900, output_tokens: 300 }) => ({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage,
  });

  it("Claude'a giden gövde yalnızca bizim verimizi içerir: Google önbellek alanları, e-posta, telefon yok", async () => {
    await setup("google");
    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "anthropic.apiKey", value: KEY }),
      undefined,
    );
    const leadId = await addGoogleLead();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        bodies.push(init.body ?? "");
        return {
          status: 200,
          json: async () => reply("We noticed your café in Leeds and wanted to say hello."),
        };
      }),
    );
    const r = await post(leadId);
    expect(r.status).toBe(201);
    const intro = (await json(r)).intro;
    expect(intro).toMatchObject({
      model: "claude-opus-5-5",
      status: "draft",
      inputTokens: 900,
      outputTokens: 300,
    });
    expect(intro.estCostUsd).toBeCloseTo(0.0096, 6);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(SENTINEL);
    expect(bodies[0]!.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
    expect(bodies[0]).not.toContain("496");
    expect(bodies[0]).toContain("Leeds");
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(KEY);

    const usage = await json(await aiUsageRoute.GET(req("GET", "/api/ai/usage"), undefined));
    expect(usage).toMatchObject({ requests: 1, inputTokens: 900, outputTokens: 300 });
    expect(usage.month).toMatch(/^\d{4}-\d{2}$/);
    expect(usage.estUsd).toBeCloseTo(0.0096, 4);
  });

  it("Claude hataları kodlu döner ve satır yazılmaz; red/kesik/kural dışı çıktı ayrı kodlar", async () => {
    await setup("google");
    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "anthropic.apiKey", value: KEY }),
      undefined,
    );
    const leadId = await addLead();
    const cases: [number, unknown, number, string][] = [
      [401, { error: { type: "authentication_error" } }, 400, "AI_AUTH"],
      [429, { error: { type: "rate_limit_error" } }, 429, "AI_RATE_LIMITED"],
      [529, { error: { type: "overloaded_error" } }, 502, "AI_UPSTREAM"],
      [200, { ...reply("x"), stop_reason: "refusal" }, 422, "AI_REFUSED"],
      [200, { ...reply("We"), stop_reason: "max_tokens" }, 502, "AI_TRUNCATED"],
      [200, reply("Since 1999 we offer 20% off, call +44 20 7946 0000."), 422, "AI_OUTPUT_INVALID"],
    ];
    for (const [status, body, http, code] of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status, json: async () => body })),
      );
      const r = await post(leadId);
      expect(r.status, code).toBe(http);
      expect((await json(r)).code).toBe(code);
    }
    expect(await db.select().from(leadIntros)).toHaveLength(0);
    const failed = (await db.select().from(auditLog)).filter((a) => a.action === "ai.intro.failed");
    expect(failed).toHaveLength(cases.length);
    // HTTP hataları faturalanmaz; red/kesik/kural dışı çıktı 200 yanıttır ve belirteci faturalanır: kullanıma sayılır.
    const billed = failed.filter((a) => (a.detail as { billed?: boolean }).billed === true);
    expect(billed.map((a) => (a.detail as { code: string }).code)).toEqual([
      "AI_REFUSED",
      "AI_TRUNCATED",
      "AI_OUTPUT_INVALID",
    ]);
    expect(billed[0]!.detail).toMatchObject({ inputTokens: 900, outputTokens: 300 });
    const usage = await aiUsage(db);
    expect(usage).toMatchObject({ requests: 3, inputTokens: 2700, outputTokens: 900 });
    expect(usage.estUsd).toBeCloseTo(3 * 0.0096, 4);
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it("faturalanmış başarısız üretimler hız sınırına sayılır: 'Yeniden oluştur'a art arda basmak sınırsız ücretli çağrı yapamaz", async () => {
    await setup("google");
    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "anthropic.apiKey", value: KEY }),
      undefined,
    );
    const leadId = await addLead();
    const calls = vi.fn(async () => ({
      status: 200,
      json: async () => reply("Since 1999 we offer 20% off, call +44 20 7946 0000."),
    }));
    vi.stubGlobal("fetch", calls);
    for (let i = 0; i < INTRO_LIMITS.perLeadPerHour; i++) {
      const r = await post(leadId);
      expect((await json(r)).code).toBe("AI_OUTPUT_INVALID");
    }
    const r = await post(leadId);
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe("RATE_LIMITED");
    expect(calls).toHaveBeenCalledTimes(INTRO_LIMITS.perLeadPerHour);
    expect((await aiUsage(db)).requests).toBe(INTRO_LIMITS.perLeadPerHour);
  });

  it("site metni yalnızca kendi taramamızın site_domain'inden; robots ve güvenli istemci üzerinden; kaynak alan adı kaydedilir", async () => {
    await setup("google");
    const leadId = await addLead();
    const now = Date.now();
    await db.insert(leadEnrichment).values({
      leadId,
      status: "done",
      siteDomain: "kahve.example",
      createdAt: now,
      updatedAt: now,
    } as typeof leadEnrichment.$inferInsert);
    const bodies: string[] = [];
    const fetchImpl: ClaudeFetch = async (_u, init) => {
      bodies.push(init.body ?? "");
      return {
        status: 200,
        json: async () => reply("We loved reading about your fresh pastries in Leeds."),
      };
    };
    const siteCalls: string[] = [];
    const intro = await generateLeadIntro(db, leadId, "en", {
      generator: createClaudeIntroGenerator({ apiKey: KEY, model: "claude-opus-5-5", fetchImpl }),
      site: {
        userAgent: "UniversalMail/test",
        agentToken: "UniversalMail",
        fetch: async (url) => {
          siteCalls.push(url);
          return url.endsWith("/robots.txt")
            ? { url, status: 404, headers: {}, body: "", skippedBody: false, truncated: false }
            : {
                url,
                status: 200,
                headers: {},
                skippedBody: false,
                truncated: false,
                body: "<body><p>Fresh pastries baked every morning by the river. Mail: owner@kahve.example</p></body>",
              };
        },
      },
    });
    expect(siteCalls).toEqual(["https://kahve.example/robots.txt", "https://kahve.example/"]);
    expect(intro.sourceDomain).toBe("kahve.example");
    expect(bodies[0]).toContain("Fresh pastries baked every morning");
    expect(bodies[0]).toContain("<website_text");
    expect(bodies[0]).not.toContain("owner@");
    // Demo üreticide site hiç okunmaz
    await setSetting(db, "places.provider", "mock");
    const calls2: string[] = [];
    const demo = await generateLeadIntro(db, leadId, "en", {
      site: {
        userAgent: "u",
        agentToken: "u",
        fetch: async (url) => (
          calls2.push(url),
          { url, status: 200, headers: {}, body: "", skippedBody: false, truncated: false }
        ),
      },
    });
    expect(demo.model).toBe("demo");
    expect(calls2).toHaveLength(0);
  });

  it("aynı (lead, dil) için eşzamanlı ikinci üretim CONFLICT; kilit sonra bırakılır", async () => {
    await setup("mock");
    const leadId = await addLead();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      model: "demo" as const,
      isDemo: true,
      generate: async () => {
        await gate;
        return {
          text: "We noticed your café in Leeds and wanted to say hello.",
          model: "demo" as const,
          inputTokens: 0,
          outputTokens: 0,
          estCostUsd: 0,
          sourceDomain: null,
        };
      },
    };
    const first = generateLeadIntro(db, leadId, "en", { generator: slow });
    await new Promise((r) => setTimeout(r, 10));
    await expect(generateLeadIntro(db, leadId, "en", { generator: slow })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    release();
    await first;
    expect((await generateLeadIntro(db, leadId, "en")).status).toBe("draft");
    await expect(generateLeadIntro(db, 424242, "en")).rejects.toBeInstanceOf(IntroError);
  });
});

describe("POST /api/ai/test ve kullanım", () => {
  it("demo: ağa çıkmadan ok; canlı: anahtar yok 400, geçerli 200, reddedilen 400 AI_AUTH, ulaşılamaz 502", async () => {
    await setup("mock");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await json(await aiTestRoute.POST(req("POST", "/api/ai/test", {}), undefined))).toEqual({
      ok: true,
      model: "claude-opus-5-5",
      demo: true,
    });
    expect(spy).not.toHaveBeenCalled();

    await setSetting(db, "places.provider", "google");
    const missing = await aiTestRoute.POST(req("POST", "/x", {}), undefined);
    expect(missing.status).toBe(400);
    expect((await json(missing)).code).toBe("AI_KEY_MISSING");

    await secretsRoute.POST(
      req("POST", "/api/secrets", { name: "anthropic.apiKey", value: KEY }),
      undefined,
    );
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
        urls.push(`${init.method} ${url} ${init.headers["anthropic-version"]}`);
        return { status: 200, json: async () => ({ id: "claude-opus-5-5", type: "model" }) };
      }),
    );
    const good = await json(await aiTestRoute.POST(req("POST", "/x", {}), undefined));
    expect(good).toEqual({ ok: true, model: "claude-opus-5-5", demo: false });
    expect(JSON.stringify(good)).not.toContain(KEY);
    expect(urls).toEqual(["GET https://api.anthropic.com/v1/models/claude-opus-5-5 2026-10-21"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, json: async () => ({}) })),
    );
    const bad = await aiTestRoute.POST(req("POST", "/x", {}), undefined);
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("AI_AUTH");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const down = await aiTestRoute.POST(req("POST", "/x", {}), undefined);
    expect(down.status).toBe(502);
    expect((await json(down)).code).toBe("AI_UPSTREAM");
  });

  it("kullanım: yalnızca bu ayın canlı satırları; demo satırları ve geçen ay sayılmaz", async () => {
    await setup("mock");
    const leadId = await addLead();
    const now = Date.UTC(2026, 10, 15, 12);
    const row = (o: Partial<typeof leadIntros.$inferInsert>) => ({
      leadId,
      language: "en",
      text: "We noticed your café in Leeds and wanted to say hello.",
      status: "draft" as const,
      model: "claude-opus-5-5" as const,
      inputTokens: 1000,
      outputTokens: 100,
      estCostUsd: 0.006,
      createdAt: now,
      updatedAt: now,
      ...o,
    });
    await db
      .insert(leadIntros)
      .values([
        row({}),
        row({ model: "claude-haiku-5-5", estCostUsd: 0.0002 }),
        row({ model: "demo", inputTokens: 0, outputTokens: 0, estCostUsd: 0 }),
        row({ createdAt: Date.UTC(2026, 9, 31, 23, 59) }),
      ]);
    expect(await aiUsage(db, now)).toEqual({
      month: "2026-11",
      requests: 2,
      inputTokens: 2000,
      outputTokens: 200,
      estUsd: 0.0062,
    });
    expect(await aiUsage(db, Date.UTC(2026, 11, 1))).toMatchObject({
      month: "2026-12",
      requests: 0,
      estUsd: 0,
    });
    // Kayıt silinince (lead silme) girişler de silinir
    await db.delete(leads).where(eq(leads.id, leadId));
    expect(await db.select().from(leadIntros)).toHaveLength(0);
  });
});
