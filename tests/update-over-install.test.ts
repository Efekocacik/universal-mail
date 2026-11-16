import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { readMigrateResult } from "@/lib/db/migrate-result";
import { runMigrations } from "@/lib/db/migrate";
import { BACKUP_PASSPHRASE_SECRET, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { partialMigrations, SOURCE_MIGRATIONS, TOTAL_MIGRATIONS } from "./helpers/migration-dirs";

/**
 * Faz 6 (sözleşme K.3, NFR-10): "yeni sürümü eskisinin üzerine kur" senaryosu. Eski sürümün (şema 0005) kullanıcı veri
 * klasörü — veritabanı, verisi ve ana anahtar X ile şifrelenmiş `secrets.json` — geçici bir "userData" altında kurulur.
 * Sonra YENİ sürümün gerçek açılış adımı (`scripts/migrate.ts`, Electron'un çalıştırdığı alt süreç) aynı ana anahtarla
 * çalıştırılır. Beklenen: ayarlar, lead'ler, kampanya verisi ve gizli bilgiler (aynı anahtarla) korunur; geçiş öncesi
 * yedek alınır; `migrate-result.json` OK; userData kökündeki dosyalara dokunulmaz; ikinci açılış hiçbir şey yapmaz.
 * Gerçek `.data` veya uygulama klasörü KULLANILMAZ; ağ yok.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const REPO = path.resolve(__dirname, "..");
const SOURCE = SOURCE_MIGRATIONS;
const FIXTURES = path.join(__dirname, "fixtures", "schema");
const TOTAL = TOTAL_MIGRATIONS;
const KEY_X = crypto.randomBytes(32).toString("hex");
const PLACES_KEY = "AIzaFixtureKey-0000000000000000000000";
const PASSPHRASE = "uzun ve gizli bir yedek parolası";

const ENV = [
  "UM_DATA_DIR",
  "UM_DB_PATH",
  "UM_MIGRATIONS_DIR",
  "UM_MASTER_KEY",
  "UM_REQUIRE_MASTER_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
let userData = "";
let dataDir = "";
let oldMigrations = "";

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  userData = fs.mkdtempSync(path.join(tmpBase, "um-uoi-"));
  dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(userData, { recursive: true, force: true });
  if (oldMigrations) fs.rmSync(oldMigrations, { recursive: true, force: true });
});

/** Eski sürümün bıraktığı userData: 0005 veritabanı + veri + X anahtarıyla şifreli secrets.json + kök dosyalar. */
async function installOldVersion(): Promise<void> {
  oldMigrations = partialMigrations(6, "um-uoi-mig-");
  process.env.UM_DATA_DIR = dataDir;
  process.env.UM_DB_PATH = path.join(dataDir, "universal-mail.db");
  process.env.UM_MIGRATIONS_DIR = oldMigrations;
  process.env.UM_MASTER_KEY = KEY_X;
  process.env.UM_REQUIRE_MASTER_KEY = "1";
  const h = await openDatabase(process.env.UM_DB_PATH);
  try {
    expect((await runMigrations(h.db, h.client)).pending).toBe(6);
    for (let k = 0; k <= 5; k++)
      await h.client.executeMultiple(fs.readFileSync(path.join(FIXTURES, `000${k}.sql`), "utf8"));
  } finally {
    h.client.close();
  }
  await setSecret("google.placesKey", PLACES_KEY);
  await setSecret(BACKUP_PASSPHRASE_SECRET, PASSPHRASE);
  // Electron ana sürecinin userData kökündeki dosyaları (içerik önemsiz; dokunulmamalı).
  fs.writeFileSync(path.join(userData, "master.key.enc"), "encrypted-by-os-keystore");
  fs.writeFileSync(path.join(userData, "ui-prefs.json"), '{"theme":"dark","language":"en"}');
  delete process.env.UM_DB_PATH; // Electron'da veritabanı yolu veri klasöründen türetilir.
}

/** Yeni sürümün açılış adımı: Electron'un çalıştırdığı şema geçişi alt süreci (gerçek `scripts/migrate.ts`). */
function launchNewVersion(): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("UM_")) env[k] = v;
  Object.assign(env, {
    UM_DATA_DIR: dataDir,
    UM_MIGRATIONS_DIR: SOURCE,
    UM_STATIC_DATA_DIR: path.join(REPO, "data"),
    UM_MASTER_KEY: KEY_X,
    UM_REQUIRE_MASTER_KEY: "1",
    UM_WIPE_SESSION: "1",
  });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "migrate.ts")],
      { cwd: REPO, env: env as NodeJS.ProcessEnv },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

describe("eski sürümün üzerine yeni sürüm kurulumu", () => {
  it("veriler, ayarlar ve gizli bilgiler korunur; yedek alınır; sonuç dosyası OK", async () => {
    await installOldVersion();
    const secretsHash = sha(path.join(dataDir, "secrets.json"));
    const rootFiles = {
      key: sha(path.join(userData, "master.key.enc")),
      prefs: sha(path.join(userData, "ui-prefs.json")),
    };

    const first = await launchNewVersion();
    expect(first.code, first.err).toBe(0);
    const result = readMigrateResult(dataDir);
    expect(result).toMatchObject({ ok: true, code: "OK", applied: TOTAL - 6, total: TOTAL });
    expect(result!.backupPath).toBeTruthy();
    expect(path.dirname(result!.backupPath!)).toBe(path.join(dataDir, "backups"));
    expect(fs.existsSync(result!.backupPath!)).toBe(true);

    // Gizli bilgi dosyası değişmedi ve aynı ana anahtarla okunuyor.
    expect(sha(path.join(dataDir, "secrets.json"))).toBe(secretsHash);
    process.env.UM_DATA_DIR = dataDir;
    process.env.UM_MASTER_KEY = KEY_X;
    process.env.UM_REQUIRE_MASTER_KEY = "1";
    expect(await getSecret("google.placesKey")).toBe(PLACES_KEY);
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBe(PASSPHRASE);
    // Başka bir makinedeki (farklı) anahtarla okunamaz: kopyalanmış secrets.json işe yaramaz.
    process.env.UM_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBeUndefined();
    process.env.UM_MASTER_KEY = KEY_X;

    // userData kökündeki dosyalara dokunulmadı; geliştirme anahtar dosyası oluşturulmadı.
    expect(sha(path.join(userData, "master.key.enc"))).toBe(rootFiles.key);
    expect(sha(path.join(userData, "ui-prefs.json"))).toBe(rootFiles.prefs);
    expect(fs.existsSync(path.join(dataDir, "master.key"))).toBe(false);

    // Veritabanı: ayarlar, lead'ler, kampanya ve ileti geçmişi korunur; yeni tablo hazır.
    const h = await openDatabase(path.join(dataDir, "universal-mail.db"));
    try {
      expect(await getSetting(h.db, "budget.monthlyUsd")).toBe(25);
      expect(await getSetting(h.db, "places.provider")).toBe("mock");
      expect(await getSetting(h.db, "setup.completed")).toBe(true);
      expect(await getSetting(h.db, "targets.countries")).toEqual(["GB", "NL"]);
      const one = async (sql: string) => (await h.client.execute(sql)).rows[0]?.[0];
      expect(await one("SELECT COUNT(*) FROM leads")).toBe(4);
      expect(await one("SELECT display_name FROM leads WHERE id = 1")).toBe("Kafe 0001");
      expect(await one("SELECT status FROM campaigns WHERE id = 1")).toBe("running");
      expect(await one("SELECT COUNT(*) FROM campaign_leads")).toBe(2);
      expect(await one("SELECT COUNT(*) FROM messages")).toBe(4);
      expect(await one("SELECT COUNT(*) FROM suppressions WHERE lifted_at IS NULL")).toBe(2);
      expect(await one("SELECT COUNT(*) FROM registry_companies")).toBe(1);
      expect(await one("SELECT COUNT(*) FROM backups")).toBe(0);
      expect(await one("SELECT COUNT(*) FROM __drizzle_migrations")).toBe(TOTAL);
      expect(await one("PRAGMA integrity_check")).toBe("ok");
      // Var olan demo kutusu korunur; açılış seed'i ikinci bir demo kutusu eklemez.
      expect(await one("SELECT COUNT(*) FROM mailboxes WHERE provider = 'demo'")).toBe(1);
    } finally {
      h.client.close();
    }

    // İkinci açılış: uygulanacak geçiş yok, yeni yedek yok.
    const backups = fs.readdirSync(path.join(dataDir, "backups")).sort();
    const second = await launchNewVersion();
    expect(second.code, second.err).toBe(0);
    expect(readMigrateResult(dataDir)).toMatchObject({ ok: true, code: "OK", applied: 0 });
    expect(readMigrateResult(dataDir)!.backupPath).toBeUndefined();
    expect(fs.readdirSync(path.join(dataDir, "backups")).sort()).toEqual(backups);
  }, 90_000);
});
