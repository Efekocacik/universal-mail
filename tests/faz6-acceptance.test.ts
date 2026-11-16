import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSetupState } from "@/lib/app/state";
import { scheduleRestore, verifyAndStage } from "@/lib/backup/restore";
import { backupFilePath, backupOverview, createBackup } from "@/lib/backup/service";
import { closeDb, openDatabase, type Db } from "@/lib/db/client";
import { PRE_MIGRATE_RE, runMigrations, VERIFY_PENDING_FILENAME } from "@/lib/db/migrate";
import { readMigrateResult } from "@/lib/db/migrate-result";
import { countLeadIds, queryFacets, queryLeads, queryPoints } from "@/lib/leads/query";
import { readResult } from "@/lib/lifecycle/pending";
import { currentPending, scheduleWipe } from "@/lib/lifecycle/service";
import { PLAIN_COPY_RE, wipeDataDir } from "@/lib/lifecycle/wipe";
import { getOnboardingChecklist } from "@/lib/onboarding/checklist";
import { BACKUP_PASSPHRASE_SECRET, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { dumpTables, insertLead } from "./helpers/backup-env";
import { partialMigrations, TOTAL_MIGRATIONS } from "./helpers/migration-dirs";
import { LONDON_BBOX, medianMs } from "./helpers/perf-cases";
import { seedLeads } from "./helpers/seed-leads";

/**
 * KABUL (Faz 6, paketler arası dikişler; docs/02 Faz 6). Otomatikleştirilebilen kabul maddeleri, uygulamanın GERÇEK
 * açılış yolu (`scripts/migrate.ts`: bekleyen işlem → şema geçişi → yedek listesi eşitleme → sonuç dosyası) ayrı bir
 * süreçte ve ağ çıkışı bekçisi (`scripts/egress-guard.cjs`, engelleme kipi) yüklüyken çalıştırılarak sınanır:
 *
 *  1. Temiz veri klasörü → açılış → ilk kurulum durumu (kurulum listesi boş, yedek yok, güncelleme öncesi kopya yok).
 *  2. En eski fikstür şemasından (0000) güncellemede veri korunur; güncelleme öncesi kopya (K) yedek ekranında (Y)
 *     sayılır; "tüm verilerimi sil" (Y) bu kopyayı ve doğrulama işaretini (K) de siler, şifreli yedek kalır ve listeye
 *     geri eklenir.
 *  3. Yedek → değişiklik → geri yükleme gidiş-dönüşü açılış betiğiyle uygulanır; veriler, gizli bilgiler ve şema bire
 *     bir döner; kurulum listesinin (K) yedek adımı geri yüklenen yedek kaydıyla (Y) tamamlanır.
 *  4. 100.000 lead'de Keşfet açılış sorguları < 300 ms (CI'da gerileme koruması; ayrıntılı ölçüm perf-100k.test.ts).
 *  5. Demo kipinde bir ilk gün (kurulum, tarama, e-posta bulma, yedek, kurulum listesi) hiçbir dış bağlantı denemesi
 *     yapmaz. Arayüz dahil tam akış e2e/privacy.spec.ts'tedir.
 *
 * Yalnızca geçici klasörler; gerçek `.data` ve kullanıcı klasörü kullanılmaz; ağa çıkılmaz.
 */

const REPO = path.resolve(__dirname, "..");
const GUARD = path.join(REPO, "scripts", "egress-guard.cjs");
const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const PASS = "kabul-testi-parolası-42";
const KEYS = [
  "UM_DATA_DIR",
  "UM_DB_PATH",
  "UM_MIGRATIONS_DIR",
  "UM_STATIC_DATA_DIR",
  "UM_MASTER_KEY",
  "UM_BACKUP_KDF_LOG2N",
  "UM_REQUIRE_MASTER_KEY",
  "UM_PRE_MIGRATE_BACKUP",
] as const;

interface EgressEntry {
  proc: string;
  kind: string;
  host: string;
}
interface ChildRun {
  code: number;
  out: string;
  err: string;
  egress: EgressEntry[];
}

/** Ağ bekçisi (engelleme kipi) yüklü bir Node alt süreci; ortam bu testin geçici klasörünü gösterir. */
function runGuarded(args: string[], proc: string): Promise<ChildRun> {
  const log = path.join(dir, `egress-${proc}-${Date.now()}.jsonl`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", GUARD, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        UM_EGRESS_LOG: log,
        UM_EGRESS_MODE: "block",
        UM_EGRESS_PROC: proc,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const egress = fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as EgressEntry)
        : [];
      fs.rmSync(log, { force: true });
      resolve({ code: code ?? -1, out, err, egress });
    });
  });
}

/** Uygulamanın açılış adımı (Electron'un çalıştırdığı betik). */
const startup = () =>
  runGuarded(["--import", "tsx", path.join(REPO, "scripts", "migrate.ts")], "migrate");

let dir = "";
let dbFile = "";
const saved: Record<string, string | undefined> = {};
let handle: { db: Db; client: Client } | null = null;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-f6acc-"));
  dbFile = path.join(dir, "universal-mail.db");
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = dbFile;
  process.env.UM_MIGRATIONS_DIR = path.join(REPO, "drizzle");
  process.env.UM_STATIC_DATA_DIR = path.join(REPO, "data");
  process.env.UM_MASTER_KEY = "ef".repeat(32);
  process.env.UM_BACKUP_KDF_LOG2N = "14";
  delete process.env.UM_REQUIRE_MASTER_KEY;
  delete process.env.UM_PRE_MIGRATE_BACKUP;
});

afterEach(async () => {
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Test sürecinden veritabanını açar (açılış betiği kapandıktan sonra; geçiş yapmaz). */
async function open(): Promise<{ db: Db; client: Client }> {
  await close();
  handle = await openDatabase(dbFile);
  return handle;
}
async function close(): Promise<void> {
  handle?.client.close();
  handle = null;
  await closeDb();
}

const count = async (c: Client, sql: string) => Number((await c.execute(sql)).rows[0]![0]);
const backupFiles = () => {
  try {
    return fs.readdirSync(path.join(dir, "backups")).sort();
  } catch {
    return [];
  }
};
async function schema(c: Client): Promise<string[]> {
  const r = await c.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  return r.rows.map((x) => `${String(x.type)} ${String(x.name)} ${String(x.sql)}`);
}

/** Açılış başarılı, sonuç dosyası OK ve hiçbir dış bağlantı denemesi yok. */
async function expectCleanStartup(applied: number): Promise<void> {
  const r = await startup();
  expect(r.code, r.err).toBe(0);
  expect(r.egress).toEqual([]);
  expect(readMigrateResult(dir)).toMatchObject({
    ok: true,
    code: "OK",
    applied,
    total: TOTAL_MIGRATIONS,
  });
  expect(fs.existsSync(path.join(dir, VERIFY_PENDING_FILENAME))).toBe(false);
}

describe("bekçi düzeneği (pozitif kontrol)", () => {
  it("alt süreçteki dış DNS denemesi kayda geçer ve engellenir", async () => {
    const r = await runGuarded(
      [
        "-e",
        "require('node:dns').lookup('kabul.example', (e) => { process.stdout.write(String(e && e.code)); })",
      ],
      "control",
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("ENOTFOUND");
    expect(r.egress).toMatchObject([
      { proc: "control", kind: "dns.lookup", host: "kabul.example" },
    ]);
  });
});

describe("1. temiz kurulum → ilk açılış", () => {
  it("tüm geçişler uygulanır; ilk kurulum durumu; yedek ve güncelleme öncesi kopya yok; ikinci açılış boş geçer", async () => {
    await expectCleanStartup(TOTAL_MIGRATIONS);
    expect(readMigrateResult(dir)?.backupPath).toBeUndefined();
    expect(backupFiles().filter((f) => PRE_MIGRATE_RE.test(f))).toEqual([]);

    const { db, client } = await open();
    expect(await count(client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(TOTAL_MIGRATIONS);
    expect((await client.execute("PRAGMA integrity_check")).rows[0]![0]).toBe("ok");
    expect((await getSetupState(db)).completed).toBe(false);
    expect(await count(client, "SELECT COUNT(*) FROM leads")).toBe(0);
    expect(await count(client, "SELECT COUNT(*) FROM category_sets")).toBeGreaterThan(0);

    const list = await getOnboardingChecklist(db);
    expect(list.dismissedAt).toBeNull();
    expect(list.allDone).toBe(false);
    expect(list.items.find((i) => i.id === "setup")!.done).toBe(false);
    expect(list.items.find((i) => i.id === "backup")!.done).toBe(false);

    const overview = await backupOverview(db);
    expect(overview).toMatchObject({ backups: [], passphraseSet: false, preMigrateCount: 0 });
    expect(currentPending()).toBeNull();
    await close();

    await expectCleanStartup(0);
  }, 60_000);
});

describe("2. güncelleme: en eski şemadan (0000) güncel sürüme", () => {
  const partialDirs: string[] = [];
  afterAll(() => {
    for (const d of partialDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("veri korunur; güncelleme öncesi kopya yedek ekranında sayılır; verileri silme kopyayı da siler, şifreli yedek kalır", async () => {
    // Faz 1 kurulumu: yalnızca 0000 geçişi + o sürümün temsilî verisi.
    const old = partialMigrations(1, "um-f6acc-mig-");
    partialDirs.push(old);
    process.env.UM_MIGRATIONS_DIR = old;
    {
      const { db, client } = await open();
      await runMigrations(db, client);
      await client.executeMultiple(
        fs.readFileSync(path.join(__dirname, "fixtures", "schema", "0000.sql"), "utf8"),
      );
      await close();
    }
    process.env.UM_MIGRATIONS_DIR = path.join(REPO, "drizzle");
    const LEADS_SQL =
      "SELECT id, place_id, display_name, novelty_score, novelty_label, notes, tags FROM leads ORDER BY id";
    const SETTINGS_SQL =
      "SELECT key, value FROM settings WHERE key IN ('setup.completed','budget.monthlyUsd','places.provider','targets.countries') ORDER BY key";

    // Yeni sürümün ilk açılışı.
    await expectCleanStartup(TOTAL_MIGRATIONS - 1);
    const pre = readMigrateResult(dir)!.backupPath!;
    expect(path.dirname(pre)).toBe(path.join(dir, "backups"));
    expect(PRE_MIGRATE_RE.test(path.basename(pre))).toBe(true);

    let { db, client } = await open();
    expect((await client.execute(LEADS_SQL)).rows.map((r) => [...Object.values(r)])).toEqual([
      [1, "fx-place-1", "Kafe 0001", 72, "high", "Not: kapı sağda", '["vip"]'],
      [2, "fx-place-2", "Kafe 0002", 90, "future_opening", null, "[]"],
      [3, "fx-place-3", "Kafe 0003", 10, "low", null, "[]"],
    ]);
    expect((await client.execute(SETTINGS_SQL)).rows.map((r) => [...Object.values(r)])).toEqual([
      ["budget.monthlyUsd", "25"],
      ["places.provider", '"mock"'],
      ["setup.completed", "true"],
      ["targets.countries", '["GB","NL"]'],
    ]);
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    // K'nin kopyası Y'nin yedek ekranında görünür (ayrı satır olarak değil, sayı olarak).
    expect(await backupOverview(db)).toMatchObject({ backups: [], preMigrateCount: 1 });
    // Güncellenmiş veritabanında şifreli yedek alınabilir.
    await setSecret(BACKUP_PASSPHRASE_SECRET, PASS);
    const made = await createBackup(db, { kind: "manual" });
    expect(made.backup.status).toBe("ok");
    const umbk = path.basename(backupFilePath(made.backup)!);

    // Tüm verilerimi sil (yedekler kalsın) → yeniden açılış.
    await scheduleWipe(db, { confirm: "VERİLERİMİ SİL", deleteBackups: false });
    await close();
    await expectCleanStartup(TOTAL_MIGRATIONS);
    expect(readResult(dir)).toMatchObject({ kind: "wipe", ok: true });
    // Düz (şifresiz) güncelleme öncesi kopya kişisel veri taşır: silinir. Şifreli yedek kalır.
    expect(backupFiles().filter((f) => PLAIN_COPY_RE.test(f))).toEqual([]);
    expect(backupFiles()).toContain(umbk);

    ({ db, client } = await open());
    expect(await count(client, "SELECT COUNT(*) FROM leads")).toBe(0);
    expect((await getSetupState(db)).completed).toBe(false);
    // Diskte kalan şifreli yedek, açılışta başlığından okunup listeye geri eklenir (geri yüklenebilir).
    const after = await backupOverview(db);
    expect(after.preMigrateCount).toBe(0);
    expect(after.backups.map((b) => b.fileName)).toEqual([umbk]);
  }, 90_000);

  it("verileri silme, K'nin yarım kopyalarını ve doğrulama işaretini de kaldırır", () => {
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups, { recursive: true });
    const leftovers = [
      "pre-migrate-2026-11-16T10-00-00-000Z.db.tmp",
      "pre-migrate-2026-11-16T10-00-00-000Z.db-wal.tmp",
      "failed-migrate-2026-11-16T10-00-00-000Z.db",
    ];
    for (const f of leftovers) fs.writeFileSync(path.join(backups, f), "x");
    fs.writeFileSync(path.join(dir, VERIFY_PENDING_FILENAME), "{}");
    fs.writeFileSync(path.join(backups, "baska-dosya.txt"), "kalmalı");
    const r = wipeDataDir({ dataDir: dir, deleteBackups: false });
    expect(r.failed).toEqual([]);
    expect(fs.readdirSync(backups)).toEqual(["baska-dosya.txt"]);
    expect(fs.existsSync(path.join(dir, VERIFY_PENDING_FILENAME))).toBe(false);
  });
});

describe("3. yedek → geri yükleme gidiş-dönüşü (gerçek açılış yolu)", () => {
  it("veriler, gizli bilgiler ve şema bire bir döner; kurulum listesinin yedek adımı tamam", async () => {
    await expectCleanStartup(TOTAL_MIGRATIONS);
    let { db, client } = await open();
    const fresh = await schema(client);
    for (let i = 0; i < 30; i++)
      await insertLead(client, { createdAt: Date.UTC(2026, 10, 1) + i * 1000, name: `Kafe ${i}` });
    await setSetting(db, "budget.monthlyUsd", 77);
    await setSecret("google.placesKey", "AIza-kabul-gidis-donus");
    await setSecret(BACKUP_PASSPHRASE_SECRET, PASS);
    const made = await createBackup(db, { kind: "manual" });
    const before = await dumpTables(client);

    // Yedekten sonra değişiklikler (geri yüklemede kaybolmalı).
    await client.execute("DELETE FROM leads");
    await setSetting(db, "budget.monthlyUsd", 999);
    await setSecret("google.placesKey", "AIza-sonradan-degisti");

    const v = await verifyAndStage(db, {
      source: { kind: "path", path: backupFilePath(made.backup)! },
      passphrase: PASS,
    });
    expect(v.summary.counts.leads).toBe(30);
    await scheduleRestore(db, { stageId: v.stageId, confirm: true, restoreSecrets: true });
    await close();

    // Geri yükleme bir sonraki açılışta, veritabanı açılmadan uygulanır.
    await expectCleanStartup(0);
    expect(readResult(dir)).toMatchObject({ kind: "restore", ok: true, secretsRestored: true });

    ({ db, client } = await open());
    expect(await dumpTables(client)).toEqual(before);
    expect(await schema(client)).toEqual(fresh);
    expect(await getSetting(db, "budget.monthlyUsd")).toBe(77);
    expect(await getSecret("google.placesKey")).toBe("AIza-kabul-gidis-donus");
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBe(PASS);
    expect((await client.execute("PRAGMA integrity_check")).rows[0]![0]).toBe("ok");
    // Anlık görüntüdeki "running" yedek satırı açılışta tamamlandı; K'nin listesi bunu başarılı yedek sayar.
    const list = await getOnboardingChecklist(db);
    expect(list.items.find((i) => i.id === "backup")!.done).toBe(true);
    expect(currentPending()).toBeNull();
  }, 90_000);
});

describe("4. 100.000 lead'de Keşfet açılış sorguları", () => {
  const N = Number(process.env.UM_PERF_N ?? 100_000);
  const CONTRACT_MS = 300;
  const STRICT = process.env.UM_PERF_STRICT === "1" || !process.env.CI;
  const LIMIT_MS = STRICT ? CONTRACT_MS : 3 * CONTRACT_MS;

  it(`açılış ekranının sorguları < ${CONTRACT_MS} ms (CI'da ${3 * CONTRACT_MS} ms gerileme koruması)`, async () => {
    const { db, client } = await open();
    await runMigrations(db, client);
    const seeded = await seedLeads(client, { n: N, seed: 7 });
    expect(seeded.leads).toBe(N);
    // Keşfet ekranı açılırken çalışan sorgular + en ağır birleşim + derin sayfa.
    const cases: [string, () => Promise<unknown>][] = [
      ["liste (varsayılan)", () => queryLeads(db, {}, { limit: 80 })],
      ["süzgeç sayıları", () => queryFacets(db, {})],
      ["harita noktaları", () => queryPoints(db, {})],
      ["toplu seçim sayısı", () => countLeadIds(db, {})],
      ["liste derin sayfa", () => queryLeads(db, {}, { limit: 80, offset: N / 2 })],
      [
        "harita kutusu + yenilik + ad sırası",
        () =>
          queryLeads(
            db,
            { bbox: LONDON_BBOX, novelty: ["high", "likely"] },
            { sort: "name", limit: 80 },
          ),
      ],
    ];
    const best = new Map<string, number>();
    let pending = cases;
    for (let round = 0; round < 3 && pending.length; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, 1500));
      for (const [name, run] of pending)
        best.set(name, Math.min(best.get(name) ?? Infinity, await medianMs(run, 3)));
      pending = pending.filter(([name]) => best.get(name)! >= LIMIT_MS);
    }
    console.info(
      `[perf] faz6 kabul: ${[...best].map(([n, ms]) => `${n} ${ms.toFixed(0)} ms`).join("; ")}`,
    );
    expect(pending.map(([name]) => `${name}: ${best.get(name)!.toFixed(0)} ms`)).toEqual([]);
  }, 240_000);
});

describe("5. demo kipinde ilk gün: dışarıya bağlantı yok", () => {
  it("kurulum → demo tarama → e-posta bulma → yedek → kurulum listesi; bekçi kaydı boş", async () => {
    await expectCleanStartup(TOTAL_MIGRATIONS);
    const r = await runGuarded(
      ["--import", "tsx", path.join(__dirname, "helpers", "demo-day-child.ts")],
      "demo-day",
    );
    expect(r.code, r.err).toBe(0);
    expect(r.egress).toEqual([]);
    const res = JSON.parse(r.out.trim().split("\n").pop()!) as {
      outcome: string;
      leads: number;
      enriched: number;
      emailLeads: number;
      emailProcessed: number;
      emailFound: number;
      emailFailed: number;
      backupStatus: string;
      backups: number;
      checklist: Record<string, { done: boolean; demo: boolean }>;
    };
    expect(res.outcome).toBe("completed");
    expect(res.leads).toBeGreaterThan(0);
    expect(res.enriched).toBe(res.emailLeads);
    expect(res.emailProcessed).toBe(res.emailLeads);
    expect(res.emailFound).toBeGreaterThan(0);
    // Demo siteleri bilinçli olarak çeşitli sonuçlar üretir (403, zaman aşımı…); hiçbiri ağa çıkmaz (bekçi kaydı boş).
    expect(res.emailFailed).toBeLessThan(res.emailLeads);
    expect(res).toMatchObject({ backupStatus: "ok", backups: 1 });
    expect(res.checklist).toMatchObject({
      setup: { done: true },
      dataSource: { done: true, demo: true },
      firstScan: { done: true, demo: true },
      mailbox: { done: false },
      backup: { done: true },
    });
    // Ardından açılış (ör. ertesi gün) da dışarıya bağlanmaz.
    await expectCleanStartup(0);
  }, 120_000);
});

describe("paketler arası dikişler (statik)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

  it("kaldırırken 'verilerimi de sil' (K) ile uygulama içi silme (Y) aynı veri klasörünü hedefler", () => {
    const main = read("electron/main.ts");
    const nsh = read("build/installer.nsh");
    // Uygulamanın kullanıcı klasörü = %APPDATA%\<ad>; ad electron-builder productName ve main.ts app.setName ile aynı.
    const name = /app\.setName\("([^"]+)"\)/.exec(main)![1]!;
    expect(read("electron-builder.config.cjs")).toContain(`productName: "${name}"`);
    expect(nsh).toContain(`RMDir /r "$APPDATA\\${name}"`);
    // NSIS başka bir klasör silmez.
    expect(nsh.match(/RMDir/g)).toHaveLength(1);
    // Uygulama içi silme: veri klasörü = <userData>/data; kullanıcı klasörü = userData (ana anahtar, tercihler, günlükler).
    expect(main).toMatch(/path\.join\(app\.getPath\("userData"\), "data"\)/);
    expect(main).toMatch(
      /applyPendingLifecycleInMain\(\{\s*userDataDir: app\.getPath\("userData"\),\s*dataDir: dataDir\(\)/,
    );
  });

  it("silme sonrası ana süreç adımı bağlı: oturum öğesi kaldırılır, Chromium depolaması temizlenir", () => {
    const main = read("electron/main.ts");
    const hook = main.slice(main.indexOf("afterWipe:"), main.indexOf("afterWipe:") + 700);
    expect(hook).toMatch(/setLoginItemSettings\(\{ openAtLogin: false \}\)/);
    expect(hook).toMatch(/session\.defaultSession\.clearStorageData\(\)/);
    expect(hook).toMatch(/prefs = parseStoredPrefs\(null\)/);
  });

  it("güncelleme öncesi kopya adları: K'nin deseni Y'nin silme desenine dahil", () => {
    for (const name of [
      "pre-migrate-2026-11-16T10-00-00-000Z.db",
      "pre-migrate-2026-11-16T10-00-00-000Z.db-wal",
      "pre-migrate-2026-11-16T10-00-00-000Z.db.tmp",
    ])
      expect(PLAIN_COPY_RE.test(name), name).toBe(true);
    expect(PRE_MIGRATE_RE.test("pre-migrate-2026-11-16T10-00-00-000Z.db.tmp")).toBe(false);
  });
});
