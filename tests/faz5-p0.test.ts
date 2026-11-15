import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { AI_ERROR_CODES, AiError } from "@/lib/ai/types";
import { createDemoIntroGenerator } from "@/lib/ai/intro";
import { PUBLIC_SECRET_NAMES } from "@/lib/client/types";
import { getDb, type Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import { leads, places } from "@/lib/db/schema";
import {
  createDemoExternalProvider,
  DEMO_EXTERNAL_QUOTA,
  type EnrichmentProvider,
} from "@/lib/email/external";
import { websiteStates, type LeadInfo } from "@/lib/email/service";
import { en } from "@/lib/i18n/en";
import { TR_FRAGMENTS, tr } from "@/lib/i18n/tr";
import {
  detectImportFormat,
  IMPORT_ERROR_CODES,
  IMPORT_ERROR_STATUS,
  IMPORT_LIMITS,
  ImportError,
} from "@/lib/import/types";
import { createDemoRegistryProvider } from "@/lib/registry/demo";
import { registerRegistryJobs } from "@/lib/registry/jobs";
import {
  REGISTRY_COUNTRY,
  REGISTRY_RUN_ERROR_CODES,
  RegistryProviderError,
  registryWindow,
} from "@/lib/registry/types";
import { getSecret, SECRET_NAMES, secretStatus, setSecret } from "@/lib/secrets/store";
import { getSetting, SETTING_DEFAULTS, settingSchemas, USER_SETTING_KEYS } from "@/lib/settings";
import * as settingsRoute from "@/app/api/settings/route";
import { getJobHandler } from "@/lib/jobs/registry";
import { registerFaz5Handlers } from "@/worker/handlers";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 5 P0 temeli: yeni ayar anahtarları (varsayılan, doğrulama, onay kuralları), gizli adlar ve ÖNEKLİ ortam yedekleri,
 * hata kodu kataloğu, sözlük parçaları, paket sözleşmeleri (arayüzler + demo taslakları) ve e-posta bulmanın
 * `leads.website` yedeği. Gerçek dış API çağrılmaz; yalnızca geçici veritabanları.
 */

const ORIGIN = "http://127.0.0.1:3000";
const put = (body: unknown) =>
  settingsRoute.PUT(
    new Request(`${ORIGIN}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
      body: JSON.stringify(body),
    }),
    undefined,
  );

describe("Faz 5 ayarları: şemalar ve varsayılanlar", () => {
  it("varsayılanlar kapalı ve kendi şemalarından geçer; yeni anahtarlar kullanıcı anahtarıdır", () => {
    for (const k of [
      "registry.companiesHouse",
      "registry.insee",
      "ai.intro",
      "tracking.opens",
    ] as const) {
      expect(settingSchemas[k].safeParse(SETTING_DEFAULTS[k]).success, k).toBe(true);
      expect(USER_SETTING_KEYS as readonly string[]).toContain(k);
      expect((SETTING_DEFAULTS[k] as { enabled: boolean }).enabled, k).toBe(false);
    }
    expect(SETTING_DEFAULTS["registry.companiesHouse"].sicCodes).toEqual(["56102", "56302"]);
    expect(SETTING_DEFAULTS["registry.insee"]).toMatchObject({
      nafCodes: ["56.30Z"],
      scheme: "NAFRev2",
    });
    expect(SETTING_DEFAULTS["ai.intro"].model).toBe("claude-opus-5-5");
  });

  it("onay kuralları: yapay zekâ ve açılma izleme onaysız açılamaz", () => {
    const ai = settingSchemas["ai.intro"];
    expect(ai.safeParse({ enabled: true, model: "claude-opus-5-5", costAckAt: null }).success).toBe(
      false,
    );
    expect(ai.safeParse({ enabled: true, model: "claude-haiku-5-5", costAckAt: 1 }).success).toBe(
      true,
    );
    expect(
      ai.safeParse({ enabled: false, model: "claude-opus-5-5", costAckAt: null }).success,
    ).toBe(true);
    expect(ai.safeParse({ enabled: false, model: "gpt", costAckAt: null }).success).toBe(false);
    const tr = settingSchemas["tracking.opens"];
    expect(tr.safeParse({ enabled: true, ackAt: null }).success).toBe(false);
    expect(tr.safeParse({ enabled: true, ackAt: 5 }).success).toBe(true);
  });

  it("sicil kodları biçim, sayı ve pencere sınırlarıyla doğrulanır", () => {
    const ch = settingSchemas["registry.companiesHouse"];
    expect(ch.safeParse({ enabled: true, sicCodes: ["56102"], windowDays: 365 }).success).toBe(
      true,
    );
    expect(ch.safeParse({ enabled: true, sicCodes: [], windowDays: 30 }).success).toBe(false);
    expect(ch.safeParse({ enabled: true, sicCodes: ["5610"], windowDays: 30 }).success).toBe(false);
    expect(
      ch.safeParse({ enabled: true, sicCodes: Array(21).fill("56102"), windowDays: 30 }).success,
    ).toBe(false);
    expect(ch.safeParse({ enabled: true, sicCodes: ["56102"], windowDays: 0 }).success).toBe(false);
    const fr = settingSchemas["registry.insee"];
    expect(
      fr.safeParse({ enabled: true, nafCodes: ["56.30Z"], windowDays: 30, scheme: "NAF2025" })
        .success,
    ).toBe(true);
    expect(
      fr.safeParse({ enabled: true, nafCodes: ["5630Z"], windowDays: 30, scheme: "NAFRev2" })
        .success,
    ).toBe(false);
    expect(
      fr.safeParse({ enabled: true, nafCodes: ["56.30Z"], windowDays: 30, scheme: "NACE" }).success,
    ).toBe(false);
  });

  it("enrichment.external: eski Hunter kaydı aynen geçerli; Snov eklendi; bilinmeyen sağlayıcı reddedilir", () => {
    const ext = settingSchemas["enrichment.external"];
    expect(ext.parse({ enabled: true, provider: "hunter" })).toEqual({
      enabled: true,
      provider: "hunter",
    });
    expect(ext.safeParse({ enabled: false, provider: "snov" }).success).toBe(true);
    expect(ext.safeParse({ enabled: false, provider: "apollo" }).success).toBe(false);
  });
});

describe("Faz 5 ayarları: API", () => {
  let t: TestDb;
  let db: Db;
  const saved = { ...process.env };
  beforeEach(async () => {
    t = await createTestDb();
    await initDatabase();
    db = await getDb();
  });
  afterEach(async () => {
    await t.cleanup();
    process.env = { ...saved };
  });

  it("PUT onaysız açmayı 400 ile reddeder, onaylı açmayı kaydeder; GET yeni anahtarları ve maskeli gizli durumları döndürür", async () => {
    const bad = await put({
      "ai.intro": { enabled: true, model: "claude-opus-5-5", costAckAt: null },
    });
    expect(bad.status).toBe(400);
    expect((await put({ "tracking.opens": { enabled: true, ackAt: null } })).status).toBe(400);
    expect((await getSetting(db, "ai.intro")).enabled).toBe(false);
    const now = Date.now();
    expect(
      (
        await put({
          "ai.intro": { enabled: true, model: "claude-haiku-5-5", costAckAt: now },
          "tracking.opens": { enabled: true, ackAt: now },
          "registry.companiesHouse": { enabled: true, sicCodes: ["56102"], windowDays: 14 },
          "registry.insee": {
            enabled: false,
            nafCodes: ["56.30Z", "56.10A"],
            windowDays: 60,
            scheme: "NAFRev2",
          },
        })
      ).status,
    ).toBe(200);
    expect(await getSetting(db, "ai.intro")).toEqual({
      enabled: true,
      model: "claude-haiku-5-5",
      costAckAt: now,
    });

    const secretValue = "sk-test-faz5-0123456789";
    await setSecret("anthropic.apiKey", secretValue);
    const body = (await (
      await settingsRoute.GET(new Request(`${ORIGIN}/api/settings`), undefined)
    ).json()) as { settings: Record<string, unknown>; secrets: Record<string, unknown> };
    expect(body.settings["registry.companiesHouse"]).toEqual({
      enabled: true,
      sicCodes: ["56102"],
      windowDays: 14,
    });
    expect(body.settings["tracking.opens"]).toEqual({ enabled: true, ackAt: now });
    for (const k of [
      "companiesHouseKey",
      "inseeKey",
      "anthropicKey",
      "snovClientId",
      "snovClientSecret",
    ])
      expect(body.secrets[k], k).toMatchObject({ set: expect.any(Boolean) });
    expect(body.secrets.anthropicKey).toMatchObject({ set: true, source: "store" });
    expect(JSON.stringify(body)).not.toContain(secretValue);
  });
});

describe("Faz 5 gizli adları", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-sec5-"));
    process.env.UM_DATA_DIR = dir;
    delete process.env.UM_MASTER_KEY;
    delete process.env.UM_REQUIRE_MASTER_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("istemci listesi sunucu listesiyle aynı", () => {
    expect([...PUBLIC_SECRET_NAMES]).toEqual([...SECRET_NAMES]);
  });

  it("ortam yedeği yalnızca UM_ önekli değişkenden okunur (ANTHROPIC_API_KEY alınmaz)", async () => {
    delete process.env.UM_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-developer-key-123";
    expect(await getSecret("anthropic.apiKey")).toBeUndefined();
    expect(await secretStatus("anthropic.apiKey")).toMatchObject({ set: false });
    const env: Record<string, string> = {
      "registry.companiesHouseKey": "UM_COMPANIES_HOUSE_API_KEY",
      "registry.inseeKey": "UM_INSEE_API_KEY",
      "anthropic.apiKey": "UM_ANTHROPIC_API_KEY",
      "snov.clientId": "UM_SNOV_CLIENT_ID",
      "snov.clientSecret": "UM_SNOV_CLIENT_SECRET",
    };
    for (const [name, variable] of Object.entries(env)) {
      process.env[variable] = `value-for-${variable.toLowerCase()}`;
      expect(await getSecret(name as (typeof SECRET_NAMES)[number]), name).toBe(
        `value-for-${variable.toLowerCase()}`,
      );
      expect(await secretStatus(name as (typeof SECRET_NAMES)[number])).toMatchObject({
        set: true,
        source: "env",
      });
    }
  });
});

describe("Faz 5 hata kodları ve sözlük parçaları", () => {
  it("paket kodları API kataloğundadır ve iki dilde metni vardır", () => {
    const all = API_ERROR_CODES as readonly string[];
    const codes = [
      ...AI_ERROR_CODES,
      ...IMPORT_ERROR_CODES,
      ...REGISTRY_RUN_ERROR_CODES.filter(
        (c) => c !== "REGISTRY_BAD_RESPONSE" && c !== "REGISTRY_TOO_MANY",
      ),
    ];
    for (const c of codes) {
      expect(all, c).toContain(c);
      expect(`apiError.${c}` in tr, c).toBe(true);
      expect(`apiError.${c}` in en, c).toBe(true);
    }
    expect(Object.keys(IMPORT_ERROR_STATUS).sort()).toEqual([...IMPORT_ERROR_CODES].sort());
  });

  it("Faz 5 parçaları kayıtlı; her paketin hata metni kendi parçasında", () => {
    for (const f of ["sources", "registry", "variants", "ai", "imports"])
      expect(Object.keys(TR_FRAGMENTS)).toContain(f);
    const own = (frag: Record<string, string>, prefix: RegExp) =>
      Object.keys(frag)
        .filter((k) => k.startsWith("apiError."))
        .every((k) => prefix.test(k));
    expect(own(TR_FRAGMENTS.registry, /^apiError\.REGISTRY_/)).toBe(true);
    expect(own(TR_FRAGMENTS.imports, /^apiError\.IMPORT_/)).toBe(true);
    expect(own(TR_FRAGMENTS.ai, /^apiError\.(AI_|INTRO_|EXTERNAL_)/)).toBe(true);
    expect(own(TR_FRAGMENTS.variants, /^apiError\.(TEMPLATE_|CATEGORY_)/)).toBe(true);
  });
});

describe("Faz 5 paket sözleşmeleri (demo taslakları)", () => {
  it("sicil: ülke eşlemesi, UTC pencere, hata sınıfı, ağsız demo sağlayıcı", async () => {
    expect(REGISTRY_COUNTRY).toEqual({ companies_house: "GB", insee: "FR" });
    const now = Date.UTC(2026, 10, 15, 23, 30);
    expect(registryWindow(30, now)).toEqual({ from: "2026-10-16", to: "2026-11-15" });
    expect(() => registryWindow(0, now)).toThrow(RangeError);
    expect(() => registryWindow(366, now)).toThrow(RangeError);
    const e = new RegistryProviderError("REGISTRY_RATE", "429", 5000);
    expect([e.code, e.retryAfterMs, e.name]).toEqual([
      "REGISTRY_RATE",
      5000,
      "RegistryProviderError",
    ]);
    const p = createDemoRegistryProvider("insee");
    expect([p.source, p.isDemo]).toEqual(["insee", true]);
    await expect(p.test()).resolves.toBeUndefined();
    // Paket R demo üreticiyi doldurdu (ayrıntı: tests/registry-demo.test.ts): ağsız, FR kayıtları, pencere içinde.
    const page = await p.search({
      scheme: "NAFRev2",
      activityCodes: ["56.30Z"],
      incorporatedFrom: "2026-10-01",
      incorporatedTo: "2026-10-31",
      locality: null,
      cursor: null,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((i) => i.countryCode === "FR")).toBe(true);
  });

  it("işler: Faz 5 kayıt yuvası çağrılabilir; paket R sicil işleyicilerini kaydeder", () => {
    registerRegistryJobs();
    registerFaz5Handlers();
    expect(getJobHandler("registry.fetch")).toBeDefined();
    expect(getJobHandler("registry.match")).toBeDefined();
  });

  it("yapay zekâ: demo üretici ağsız, ücretsiz, model 'demo'; hata sınıfı kod taşır", async () => {
    const g = createDemoIntroGenerator();
    const r = await g.generate({
      displayName: "Örnek",
      city: "Leeds",
      categoryLabel: "cafe",
      language: "en",
      siteExcerpt: null,
      sourceDomain: null,
    });
    expect([g.isDemo, r.model, r.estCostUsd, r.inputTokens]).toEqual([true, "demo", 0, 0]);
    expect(r.text).toContain("Leeds");
    expect(new AiError("AI_REFUSED", "x").code).toBe("AI_REFUSED");
  });

  it("harici e-posta: demo sağlayıcı yalnızca .example alan adlarında sonuç verir; kota sabit", async () => {
    const p: EnrichmentProvider = createDemoExternalProvider("snov");
    expect(p.id).toBe("snov");
    expect(createDemoExternalProvider().id).toBe("hunter");
    expect(await p.search("Cafe-One.example")).toEqual([
      { email: "contact@cafe-one.example", confidence: 60, sourceUrl: null },
    ]);
    expect(await p.search("cafe.example.com")).toEqual([]);
    expect(await p.search("example")).toEqual([]);
    expect(await p.quota()).toEqual(DEMO_EXTERNAL_QUOTA);
  });

  it("içe aktarma: biçim uzantı VE imzayla belirlenir; sınırlar ve hata sınıfı", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    const text = new TextEncoder().encode("name,country\n");
    expect(detectImportFormat("liste.XLSX", zip)).toBe("xlsx");
    expect(detectImportFormat("liste.xlsx", text)).toBeNull();
    expect(detectImportFormat("liste.csv", text)).toBe("csv");
    expect(detectImportFormat("liste.csv", zip)).toBeNull();
    expect(detectImportFormat("liste.xls", zip)).toBeNull();
    expect(detectImportFormat("liste", text)).toBeNull();
    expect(IMPORT_LIMITS).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxRows: 5000 });
    expect(new ImportError("IMPORT_PARSE", "x").code).toBe("IMPORT_PARSE");
  });
});

describe("e-posta bulma: leads.website yedeği (Faz 5)", () => {
  let t: TestDb;
  let db: Db;
  beforeEach(async () => {
    t = await createTestDb();
    await initDatabase();
    db = await getDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("önbellek sitesi önceliklidir; yoksa veya yer kaydı yoksa kullanıcının sitesi; ikisi de yoksa doğru durum", async () => {
    const now = Date.now();
    await db.insert(places).values(
      ["p-site", "p-nosite", "p-unloaded", "p-own"].map((placeId) => ({
        placeId,
        source: "demo" as const,
        coordsFetchedAt: now,
        firstSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(placeCache).values([
      {
        placeId: "p-site",
        name: "A",
        types: [],
        fetchedAt: now,
        enrichedAt: now,
        website: " https://a.example/ ",
      },
      { placeId: "p-nosite", name: "B", types: [], fetchedAt: now, enrichedAt: now, website: null },
      {
        placeId: "p-own",
        name: "D",
        types: [],
        fetchedAt: now,
        enrichedAt: now,
        website: "https://google.example/",
      },
    ]);
    const info = (id: number, placeId: string | null, website: string | null): LeadInfo => ({
      id,
      placeId,
      status: "new",
      countryCode: "GB",
      website,
    });
    const states = await websiteStates(db, [
      info(1, "p-site", "https://own.example/"),
      info(2, "p-nosite", null),
      info(3, "p-unloaded", null),
      info(4, "p-unloaded", "https://own-unloaded.example/"),
      info(5, null, " https://imported.example/path "),
      info(6, null, null),
      info(7, "p-nosite", "https://own-nosite.example/"),
      info(8, "p-own", "https://own.example/"),
    ]);
    expect(Object.fromEntries(states)).toEqual({
      1: { kind: "site", url: "https://a.example/" },
      2: { kind: "no_website" },
      3: { kind: "needs_google" },
      4: { kind: "site", url: "https://own-unloaded.example/" },
      5: { kind: "site", url: "https://imported.example/path" },
      6: { kind: "no_website" },
      7: { kind: "site", url: "https://own-nosite.example/" },
      8: { kind: "site", url: "https://google.example/" },
    });
    // Kalıcı tabloya Google sitesi yazılmaz: sütun yalnızca kullanıcının verdiği değeri taşır.
    expect(await db.select({ w: leads.website }).from(leads)).toEqual([]);
  });
});
