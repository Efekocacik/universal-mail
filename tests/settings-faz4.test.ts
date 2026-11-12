import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { settings as settingsTable } from "@/lib/db/schema";
import {
  getSetting,
  getSettings,
  SETTING_DEFAULTS,
  settingSchemas,
  setSetting,
  USER_SETTING_KEYS,
  type SettingKey,
} from "@/lib/settings";
import {
  DEMO_MAP_ID,
  effectiveMapId,
  isValidMapId,
  MAP_ID_MAX,
  mapIdProblem,
  mapIdSchema,
} from "@/lib/settings/map-id";
import * as configRoute from "@/app/api/config/route";
import * as settingsRoute from "@/app/api/settings/route";
import { createTestDb, type TestDb } from "./helpers/db";

/** Faz 4 P0: yeni ayar anahtarları, Map ID doğrulayıcısı (hata düzeltmesi) ve ayarlar PUT'unun anahtar listesi. */

describe("Map ID doğrulayıcısı", () => {
  it("Google biçimli kimlikleri ve boş değeri kabul eder", () => {
    for (const ok of [
      "",
      "8e0a97af9386fef",
      "4504f8b37365c3d0",
      "DEMO_MAP_ID",
      "a-b_c",
      "x".repeat(64),
    ])
      expect(isValidMapId(ok), ok).toBe(true);
  });

  it("e-posta, boşluk, URL, çok uzun ve ayraçla başlayan değerleri reddeder", () => {
    for (const bad of [
      "ali@firma.com",
      "harita kimliği",
      "https://maps.example/x",
      "abc.def",
      "-abc",
      "_abc",
      "x".repeat(MAP_ID_MAX + 1),
      "İstanbul",
    ])
      expect(isValidMapId(bad), bad).toBe(false);
  });

  it("ret nedeni kodu verir ve baş/son boşluğu kırpar", () => {
    expect(mapIdProblem("  8e0a97af9386fef  ")).toBeNull();
    expect(mapIdProblem("ali@firma.com")).toBe("email");
    expect(mapIdProblem("x".repeat(65))).toBe("too_long");
    expect(mapIdProblem("a b")).toBe("invalid");
    expect(mapIdSchema.parse("  abc123  ")).toBe("abc123");
    expect(mapIdSchema.safeParse("ali@firma.com").success).toBe(false);
  });

  it("tarayıcıya giden kimlik: geçersiz/boş → demo kimliği", () => {
    expect(effectiveMapId("")).toBe(DEMO_MAP_ID);
    expect(effectiveMapId("ali@firma.com")).toBe(DEMO_MAP_ID);
    expect(effectiveMapId(42)).toBe(DEMO_MAP_ID);
    expect(effectiveMapId(" 8e0a97af9386fef ")).toBe("8e0a97af9386fef");
  });
});

describe("ayar şemaları", () => {
  it("her varsayılan kendi şemasına uyar (yeni Faz 4 anahtarları dahil)", () => {
    for (const key of Object.keys(settingSchemas) as SettingKey[])
      expect(settingSchemas[key].safeParse(SETTING_DEFAULTS[key]).success, key).toBe(true);
  });

  it("Faz 4 varsayılanları belgelenen değerlerdir", () => {
    expect(SETTING_DEFAULTS["ui.theme"]).toBe("system");
    expect(SETTING_DEFAULTS["app.openAtLogin"]).toBe(false);
    expect(SETTING_DEFAULTS["notifications.os"]).toBe(true);
    expect(SETTING_DEFAULTS["novelty.rdap"]).toEqual({ enabled: true });
    expect(SETTING_DEFAULTS["novelty.rdapBootstrap"]).toBeNull();
    expect(SETTING_DEFAULTS["novelty.domainYoungDays"]).toBe(183);
    expect(SETTING_DEFAULTS["novelty.futureWatch"]).toEqual({
      enabled: true,
      everyDays: 7,
      maxPerRun: 100,
    });
    expect(SETTING_DEFAULTS["google.derivedFlagsDays"]).toBeNull();
    expect(SETTING_DEFAULTS["mail.dispatch.wakeRequestedAt"]).toBeNull();
  });

  it("iç anahtarlar kullanıcı listesinde yoktur", () => {
    const user = new Set<string>(USER_SETTING_KEYS);
    for (const internal of [
      "consent",
      "setup.completed",
      "seed.faz3",
      "mock.epoch",
      "novelty.rdapBootstrap",
      "mail.dispatch.wakeRequestedAt",
      "mail.mailboxHalts",
      "mail.unsubscribeKeys",
    ])
      expect(user.has(internal), internal).toBe(false);
  });
});

let t: TestDb;
let db: Db;
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

describe("ayarlar API'si (Faz 4)", () => {
  beforeEach(async () => {
    t = await createTestDb();
    await initDatabase();
    db = await getDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("Map ID: e-posta 400 MAP_ID_INVALID ve kaydedilmez; geçerli değer kırpılıp kaydedilir; boş temizler", async () => {
    const bad = await put({ "maps.mapId": "ali@firma.com" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "MAP_ID_INVALID", reason: "email" });
    expect(await getSetting(db, "maps.mapId")).toBe("");

    expect((await put({ "maps.mapId": "  8e0a97af9386fef " })).status).toBe(200);
    expect(await getSetting(db, "maps.mapId")).toBe("8e0a97af9386fef");
    const cfg = (await (
      await configRoute.GET(new Request(`${ORIGIN}/api/config`), undefined)
    ).json()) as {
      mapId: string;
      theme: string;
    };
    expect(cfg.mapId).toBe("8e0a97af9386fef");
    expect(cfg.theme).toBe("system");

    expect((await put({ "maps.mapId": "" })).status).toBe(200);
    expect(await getSetting(db, "maps.mapId")).toBe("");
  });

  it("eskiden kaydedilmiş geçersiz Map ID okunurken yok sayılır ve Google'a gönderilmez", async () => {
    await db
      .insert(settingsTable)
      .values({ key: "maps.mapId", value: "ali@firma.com", updatedAt: Date.now() });
    expect(await getSetting(db, "maps.mapId")).toBe("");
    const cfg = (await (
      await configRoute.GET(new Request(`${ORIGIN}/api/config`), undefined)
    ).json()) as {
      mapId: string;
    };
    expect(cfg.mapId).toBe(DEMO_MAP_ID);
  });

  it("yeni kullanıcı anahtarları kaydedilir ve GET'te döner; geçersiz değer 400", async () => {
    const res = await put({
      "ui.theme": "dark",
      "app.openAtLogin": true,
      "notifications.os": false,
      "novelty.rdap": { enabled: false },
      "novelty.domainYoungDays": 200,
      "novelty.futureWatch": { enabled: false, everyDays: 14, maxPerRun: 50 },
      "google.derivedFlagsDays": 365,
    });
    expect(res.status).toBe(200);
    const s = await getSettings(db, USER_SETTING_KEYS);
    expect(s).toMatchObject({
      "ui.theme": "dark",
      "app.openAtLogin": true,
      "notifications.os": false,
      "novelty.rdap": { enabled: false },
      "novelty.domainYoungDays": 200,
      "novelty.futureWatch": { enabled: false, everyDays: 14, maxPerRun: 50 },
      "google.derivedFlagsDays": 365,
    });
    const got = (await (
      await settingsRoute.GET(new Request(`${ORIGIN}/api/settings`), undefined)
    ).json()) as {
      settings: Record<string, unknown>;
    };
    expect(got.settings["ui.theme"]).toBe("dark");
    expect(got.settings["mock.epoch"]).toBe(0);
    expect((await put({ "ui.theme": "neon" })).status).toBe(400);
    expect((await put({ "novelty.domainYoungDays": 5 })).status).toBe(400);
    expect((await put({ "google.derivedFlagsDays": null })).status).toBe(200);
    expect(await getSetting(db, "google.derivedFlagsDays")).toBeNull();
  });

  it("iç anahtarlar API'den yazılamaz (strict gövde)", async () => {
    for (const body of [
      { "novelty.rdapBootstrap": null },
      { "mail.dispatch.wakeRequestedAt": 1 },
      { "mock.epoch": 3 },
      { "seed.faz3": { templates: 0, demoMailbox: 0 } },
    ])
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
  });

  it("birden çok anahtar tek işlemde yazılır ve tek denetim kaydı oluşur", async () => {
    await setSetting(db, "budget.monthlyUsd", 30);
    expect((await put({ "budget.monthlyUsd": 55, "ui.theme": "light" })).status).toBe(200);
    expect(await getSetting(db, "budget.monthlyUsd")).toBe(55);
    expect(await getSetting(db, "ui.theme")).toBe("light");
  });
});
