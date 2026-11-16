import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { setSetting } from "@/lib/settings";
import {
  BACKUP_PASSPHRASE_SECRET,
  OAUTH_CLIENT_SECRET,
  channelKeySecretName,
  deleteSecret,
  getSecret,
  mailboxRefreshTokenName,
  secretExists,
  secretStatus,
  setSecret,
  unsubscribeKeySecretName,
} from "@/lib/secrets/store";
import { ensureSigningKey } from "@/lib/unsubscribe/keys";
import { ensureChannelKey } from "@/lib/unsubscribe/channel";
import * as secretsRoute from "@/app/api/secrets/route";
import * as settingsRoute from "@/app/api/settings/route";
import * as gmailClientRoute from "@/app/api/mailboxes/gmail-client/route";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 6 (paket G, yol haritası madde 8, NFR-02): gizli bilgiler diskte düz metin olarak BULUNMAZ.
 *
 * Her gizli bilgi türü gerçek yollardan (API uçları ve servisler) yazılır; ardından veri klasöründeki HER dosya (ana
 * veritabanı, WAL, oturum önbelleği, secrets.json, yedek klasörü…) düz metin baytları için taranır. Uçlar değerleri
 * yalnızca maskeli döndürür; Electron kipinde (`UM_REQUIRE_MASTER_KEY=1`) ana anahtar yoksa depo açılmaz.
 */

const ORIGIN = "http://127.0.0.1:3000";
let t: TestDb;
let db: Db;
const savedEnv = { ...process.env };

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Veri klasöründeki tüm dosyalar (alt klasörler dahil). */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Düz metnin (UTF-8 ve UTF-16LE) geçtiği dosyalar. */
function filesContaining(dir: string, plain: string): string[] {
  const needles = [Buffer.from(plain, "utf8"), Buffer.from(plain, "utf16le")];
  return allFiles(dir).filter((f) => {
    const data = fs.readFileSync(f);
    return needles.some((n) => data.includes(n));
  });
}

const rand = (prefix: string) => `${prefix}${crypto.randomBytes(12).toString("hex")}`;

beforeEach(async () => {
  t = await createTestDb();
  // Electron kipi: ana anahtar ortamdan gelir (anahtarlıkla korunur), dosyaya yazılmaz.
  process.env.UM_MASTER_KEY = crypto.randomBytes(32).toString("hex");
  process.env.UM_REQUIRE_MASTER_KEY = "1";
  for (const k of [
    "GOOGLE_PLACES_API_KEY",
    "GOOGLE_MAPS_BROWSER_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY",
    "HUNTER_API_KEY",
  ])
    delete process.env[k];
  await initDatabase();
  db = await getDb();
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Test" });
});

afterEach(async () => {
  await t.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("gizli bilgiler diskte düz metin değildir", () => {
  it("her gizli bilgi türü yazıldıktan sonra veri klasöründeki hiçbir dosyada düz metin yoktur", async () => {
    const plain: Record<string, string> = {};
    // 1) Genel API anahtarları: /api/secrets ucu (arayüzün kullandığı yol).
    for (const name of [
      "google.placesKey",
      "google.mapsKey",
      "hunter.apiKey",
      "registry.companiesHouseKey",
      "registry.inseeKey",
      "anthropic.apiKey",
      "snov.clientId",
      "snov.clientSecret",
    ] as const) {
      const value = rand("Sk");
      plain[name] = value;
      const res = await secretsRoute.POST(req("POST", "/api/secrets", { name, value }), undefined);
      expect(res.status, name).toBe(200);
      const body = (await res.json()) as { status: { masked: string } };
      expect(JSON.stringify(body)).not.toContain(value);
    }
    // 2) Gmail OAuth istemci sırrı: posta kutusu ucu.
    const oauthSecret = rand("GOCSPX-");
    plain[OAUTH_CLIENT_SECRET] = oauthSecret;
    const put = await gmailClientRoute.PUT(
      req("PUT", "/api/mailboxes/gmail-client", {
        clientId: "123456789-abcdefgh12345678.apps.googleusercontent.com",
        clientSecret: oauthSecret,
      }),
      undefined,
    );
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain(oauthSecret);
    // 3) Posta kutusu yenileme belirteci (OAuth geri çağrısı bunu depoya yazar).
    const refresh = rand("1//0g");
    plain["refresh"] = refresh;
    await setSecret(mailboxRefreshTokenName(1), refresh);
    // 4) Abonelikten çıkış imza ve kanal anahtarları (uygulama üretir).
    const { kid } = await ensureSigningKey(db);
    const { kid: channelKid } = await ensureChannelKey(db);
    plain["signing"] = (await getSecret(unsubscribeKeySecretName(kid)))!;
    plain["channel"] = (await getSecret(channelKeySecretName(channelKid)))!;
    expect(plain["signing"]).toBeTruthy();
    expect(plain["channel"]).toBeTruthy();
    // 5) Yedek parolası (paket Y'nin servisi aynı depoyu kullanır).
    const passphrase = "uzun ve gizli yedek parolası 4711";
    plain[BACKUP_PASSPHRASE_SECRET] = passphrase;
    await setSecret(BACKUP_PASSPHRASE_SECRET, passphrase);

    // Veritabanı ve WAL dosyası birlikte taranır (denetim kaydı vb. henüz WAL'da olabilir).
    const files = allFiles(t.dir);
    expect(files.some((f) => f.endsWith("secrets.json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".db"))).toBe(true);
    for (const [name, value] of Object.entries(plain)) {
      expect(filesContaining(t.dir, value), name).toEqual([]);
    }
    // Ana anahtar Electron kipinde dosyaya yazılmaz.
    expect(fs.existsSync(path.join(t.dir, "master.key"))).toBe(false);
    expect(filesContaining(t.dir, process.env.UM_MASTER_KEY!)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "secrets.json ve geliştirme ana anahtarı yalnızca sahibince okunur (0600)",
    async () => {
      await setSecret("google.placesKey", rand("Sk"));
      expect(fs.statSync(path.join(t.dir, "secrets.json")).mode & 0o777).toBe(0o600);
      // Geliştirme kipi: ana anahtar dosyası 0600 ile oluşturulur.
      delete process.env.UM_MASTER_KEY;
      delete process.env.UM_REQUIRE_MASTER_KEY;
      await setSecret("hunter.apiKey", rand("Hk"));
      expect(fs.statSync(path.join(t.dir, "master.key")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(t.dir, "secrets.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("uçlar değerleri yalnızca maskeli döndürür; yedek parolası ve OAuth sırrı hiç görünmez", async () => {
    const places = rand("AIza");
    await setSecret("google.placesKey", places);
    await setSecret(BACKUP_PASSPHRASE_SECRET, "başka bir uzun parola 1234");
    await setSecret(OAUTH_CLIENT_SECRET, rand("GOCSPX-"));
    const res = await settingsRoute.GET(req("GET", "/api/settings"), undefined);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(places);
    expect(text).toContain(`${places.slice(0, 4)}••••${places.slice(-4)}`);
    expect(text).not.toContain("başka bir uzun parola");
    expect(text).not.toContain("GOCSPX-");
    expect(text).not.toContain(process.env.UM_MASTER_KEY!);
    const gc = await gmailClientRoute.GET(req("GET", "/api/mailboxes/gmail-client"), undefined);
    expect(await gc.text()).not.toContain("GOCSPX-");
    // /api/secrets yalnızca genel anahtar adlarını kabul eder; dahili adlar (yedek parolası, OAuth sırrı) yazılamaz.
    for (const name of [BACKUP_PASSPHRASE_SECRET, OAUTH_CLIENT_SECRET, "gmail.refreshToken.1"]) {
      const r = await secretsRoute.POST(
        req("POST", "/api/secrets", { name, value: "abcdefgh12345678" }),
        undefined,
      );
      expect(r.status, name).toBe(400);
    }
  });

  it("UM_REQUIRE_MASTER_KEY=1 ve ana anahtar yoksa depo açılmaz, anahtar dosyası da üretilmez", async () => {
    await setSecret("google.placesKey", rand("Sk"));
    delete process.env.UM_MASTER_KEY;
    await expect(setSecret("hunter.apiKey", rand("Hk"))).rejects.toThrow(/UM_MASTER_KEY/);
    expect(await getSecret("google.placesKey")).toBeUndefined();
    expect(await secretExists("google.placesKey")).toBe(false);
    expect((await secretStatus("google.placesKey")).set).toBe(false);
    expect(fs.existsSync(path.join(t.dir, "master.key"))).toBe(false);
  });

  it("başka bir bilgisayara kopyalanan secrets.json başka ana anahtarla çözülemez", async () => {
    const v = rand("Sk");
    await setSecret("google.placesKey", v);
    expect(await getSecret("google.placesKey")).toBe(v);
    process.env.UM_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    expect(await getSecret("google.placesKey")).toBeUndefined();
    expect(await secretExists("google.placesKey")).toBe(false);
    // Bozuk ana anahtar biçimi reddedilir (sessizce zayıf anahtar kullanılmaz).
    process.env.UM_MASTER_KEY = "kisa";
    await expect(setSecret("google.placesKey", v)).rejects.toThrow(/64/);
  });

  it("silinen gizli bilgi dosyadan da kalkar", async () => {
    const v = rand("Sk");
    await setSecret("hunter.apiKey", v);
    await deleteSecret("hunter.apiKey");
    expect(await secretExists("hunter.apiKey")).toBe(false);
    const raw = JSON.parse(fs.readFileSync(path.join(t.dir, "secrets.json"), "utf8")) as {
      items: Record<string, unknown>;
    };
    expect(Object.keys(raw.items)).not.toContain("hunter.apiKey");
  });
});
