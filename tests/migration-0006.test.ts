import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { maintenancePathFor } from "@/lib/db/maintenance";
import { runMigrations } from "@/lib/db/migrate";
import { RollbackError } from "@/lib/db/rollback-0003";
import {
  AUDIT_ACTION_0006,
  executeRollback0006,
  FAZ6_INDEXES,
  FAZ6_TABLES,
  planRollback0006,
  rollbackFaz6,
} from "@/lib/db/rollback-0006";
import { seedLeads } from "./helpers/seed-leads";

/**
 * Migrasyon 0006 (Faz 6 P0): YALNIZCA EKLEME (`backups` tablosu + indeksleri, `leads_retention_idx`). Dolu bir 0005
 * veritabanında veri korunur, kısıtlar (tek süren yedek, ok/failed tutarlılığı, yol ayırıcısız dosya adı) veritabanı
 * düzeyinde çalışır, eski sürüm yazımları çalışır ve geri alma 0005 şemasını bire bir geri getirir (yedek DOSYALARINA
 * dokunmadan). Ayrıca schema.ts ↔ son anlık görüntü denetimi burada. Yalnızca GEÇİCİ veritabanları.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(tmpBase);
const REPO = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(REPO, "drizzle");
const T = 1_796_000_000_000;

function partialMigrations(count: number): string {
  const d = fs.mkdtempSync(path.join(tmpBase, "um-mig6-"));
  fs.mkdirSync(path.join(d, "meta"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(d, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[])
    fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(d, `${e.tag}.sql`));
  return d;
}

const UPTO_0005 = partialMigrations(6);
afterAll(() => fs.rmSync(UPTO_0005, { recursive: true, force: true }));

let dir: string;
let file: string;
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-m6-"));
  file = path.join(dir, "test.db");
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = file;
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows'ta geçici dosya silme hatası (bilinen ortam sorunu) */
  }
});

async function handle(f = file) {
  const h = await openDatabase(f);
  clients.push(h.client);
  return h;
}
async function rows(c: Client, sql: string): Promise<Record<string, unknown>[]> {
  return (await c.execute(sql)).rows.map((r) => ({ ...r }));
}
const num = async (c: Client, sql: string) => Number((await c.execute(sql)).rows[0]?.[0] ?? 0);
async function tryx(c: Client, sql: string): Promise<string> {
  try {
    await c.execute(sql);
    return "OK";
  } catch (e) {
    return String((e as Error).message);
  }
}
const norm = (s: unknown) =>
  String(s ?? "")
    .replace(/["`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function dump(c: Client): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const names = (
    await rows(
      c,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
  ).map((r) => String(r.name));
  for (const t of names) out[t] = await rows(c, `SELECT * FROM "${t}" ORDER BY rowid`);
  out.__seq = await rows(c, "SELECT name, seq FROM sqlite_sequence ORDER BY name");
  return out;
}
async function schema(c: Client): Promise<string[]> {
  return (
    await rows(
      c,
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND sql IS NOT NULL ORDER BY type, name",
    )
  ).map((r) => `${r.type}:${r.name}:${norm(r.sql)}`);
}

/** 0005 şemasında (ilk 6 geçiş) veritabanı. */
async function build0005(f = file) {
  const h = await handle(f);
  process.env.UM_MIGRATIONS_DIR = UPTO_0005;
  await runMigrations(h.db, h.client);
  return h;
}
async function upgrade(h: Awaited<ReturnType<typeof handle>>) {
  process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
  return runMigrations(h.db, h.client);
}

/** Faz 1–5 verisi: belirlenimci lead kümesi + ayar + denetim satırı (oturum önbelleği dökümden hariç: ayrı dosya). */
async function seed0005(c: Client): Promise<void> {
  await seedLeads(c, { n: 300, seed: 6, now: T });
  await c.batch(
    [
      `INSERT INTO settings(key,value,updated_at) VALUES ('ui.language','"en"',${T})`,
      `INSERT INTO audit_log(at,action,entity,entity_id,detail) VALUES (${T},'consent.accepted','consent','1','{}')`,
      "DELETE FROM leads WHERE id = 300",
    ],
    "write",
  );
}

const okRow = (name: string) =>
  `INSERT INTO backups(kind,status,file_name,folder,size_bytes,sha256,app_version,schema_migrations,created_at,finished_at) VALUES ('manual','ok','${name}','/tmp/x',10,'${"a".repeat(64)}','0.1.0',7,${T},${T + 1})`;

describe.skipIf(unsafeTmp)("0006: veri korunur, şema", () => {
  it("dolu 0005 veritabanında hiçbir satır kaybolmaz/değişmez; yeni tablo boş; şema taze kurulumla aynı", async () => {
    const h = await build0005();
    await seed0005(h.client);
    const before = await dump(h.client);
    const res = await upgrade(h);
    expect(res.pending).toBe(1);
    expect(res.backupPath && fs.existsSync(res.backupPath)).toBe(true);
    const after = await dump(h.client);
    for (const t of Object.keys(before)) expect(after[t], t).toEqual(before[t]);
    for (const t of FAZ6_TABLES) expect(after[t], t).toEqual([]);
    expect(before.leads!.length).toBeGreaterThan(250);

    const fresh = await handle(path.join(dir, "fresh.db"));
    process.env.UM_DB_PATH = path.join(dir, "fresh.db");
    await runMigrations(fresh.db, fresh.client);
    process.env.UM_DB_PATH = file;
    expect(await schema(h.client)).toEqual(await schema(fresh.client));
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(h.client, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("migrasyon SQL'i yalnızca ekler; adlar tekil; günlük ve anlık görüntü tutarlı", () => {
    const text = fs.readFileSync(path.join(MIGRATIONS, "0006_faz6.sql"), "utf8");
    const statements = text
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((l) => !l.startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(statements.join("\n")).not.toMatch(
      /\bDROP\b|__new|\bINSERT\b|\bRENAME\b|\bPRAGMA\b|^\s*UPDATE\b|\bALTER\b/im,
    );
    for (const s of statements)
      expect(s).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/);
    const names = [...text.matchAll(/INDEX IF NOT EXISTS `([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const i of FAZ6_INDEXES) expect(names).toContain(i);
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.map((e) => e.tag).slice(-1)).toEqual(["0006_faz6"]);
    expect(journal.entries[6]!.idx).toBe(6);
    expect(journal.entries[6]!.when).toBeGreaterThan(journal.entries[5]!.when);
    const snap = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "0006_snapshot.json"), "utf8"),
    ) as { tables: Record<string, { indexes: Record<string, unknown> }>; prevId: string };
    const prev = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "0005_snapshot.json"), "utf8"),
    ) as { id: string };
    expect(snap.prevId).toBe(prev.id);
    for (const t of FAZ6_TABLES) expect(Object.keys(snap.tables)).toContain(t);
    expect(Object.keys(snap.tables.leads!.indexes)).toContain("leads_retention_idx");
  });

  it("yarıda kalan 0006 hiçbir iz bırakmaz (tek işlem); engel kalkınca yeniden uygulanır", async () => {
    const h = await build0005();
    await seed0005(h.client);
    // Son ifadelerden birini bozacak çakışma: aynı adlı ama farklı tabloda bir indeks (IF NOT EXISTS atlar → yanlış
    // şema) yerine, ad çakışması TABLO olarak: `leads_retention_idx` adında tablo varken indeks kurulamaz.
    await h.client.execute("CREATE TABLE `leads_retention_idx` (x int)");
    const before = await schema(h.client);
    const dBefore = await dump(h.client);
    await expect(upgrade(h)).rejects.toThrow(/already exists|leads_retention_idx/i);
    expect(await schema(h.client)).toEqual(before);
    expect(await dump(h.client)).toEqual(dBefore);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    await h.client.execute("DROP TABLE `leads_retention_idx`");
    expect((await upgrade(h)).pending).toBe(1);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(7);
  });

  it("şema (schema.ts) ile son anlık görüntü aynı: drizzle-kit generate yeni migrasyon üretmez", () => {
    // Elle yazılmış 0006'nın schema.ts ile kaymadığının kanıtı. Kopya klasörde çalışır; depodaki drizzle/ değişmez.
    const work = fs.mkdtempSync(path.join(tmpBase, "um-dk-"));
    try {
      fs.cpSync(MIGRATIONS, path.join(work, "drizzle"), { recursive: true });
      const out = path.relative(REPO, path.join(work, "drizzle"));
      const r = spawnSync(
        process.execPath,
        [
          path.join(REPO, "node_modules", "drizzle-kit", "bin.cjs"),
          "generate",
          "--dialect",
          "sqlite",
          "--schema",
          "./src/lib/db/schema.ts",
          "--out",
          out,
        ],
        { cwd: REPO, encoding: "utf8", timeout: 60_000 },
      );
      const output = `${r.stdout}\n${r.stderr}`;
      expect(r.status, output).toBe(0);
      expect(output).toMatch(/No schema changes/);
      expect(fs.readdirSync(path.join(work, "drizzle")).filter((f) => f.endsWith(".sql"))).toEqual(
        fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")),
      );
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it("boş veritabanında ve ikinci çalıştırmada etkisiz", async () => {
    const h = await handle();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    expect((await runMigrations(h.db, h.client)).pending).toBe(7);
    expect((await runMigrations(h.db, h.client)).pending).toBe(0);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(7);
  });
});

describe.skipIf(unsafeTmp)("0006: kısıtlar veritabanı düzeyinde", () => {
  let c: Client;
  beforeEach(async () => {
    const h = await build0005();
    await upgrade(h);
    c = h.client;
  });

  it("geçerli satırlar: ok, failed, running", async () => {
    expect(await tryx(c, okRow("universal-mail-20261116-101010-manual.umbk"))).toBe("OK");
    expect(
      await tryx(
        c,
        `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,error_code,created_at,finished_at) VALUES ('weekly','failed','universal-mail-20261116-101011-weekly.umbk','/tmp/x','0.1.0',7,'BACKUP_DISK_FULL',${T},${T})`,
      ),
    ).toBe("OK");
    expect(
      await tryx(
        c,
        `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('startup','running','universal-mail-20261116-101012-startup.umbk','/tmp/x','0.1.0',7,${T})`,
      ),
    ).toBe("OK");
    expect(await num(c, "SELECT includes_secrets FROM backups WHERE kind='startup'")).toBe(0);
  });

  it("aynı anda en çok bir 'running' yedek; biri bitince yenisi başlayabilir", async () => {
    const run = (n: number) =>
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','running','universal-mail-2026111${n}-000000-manual.umbk','/tmp/x','0.1.0',7,${T})`;
    expect(await tryx(c, run(1))).toBe("OK");
    expect(await tryx(c, run(2))).toMatch(/UNIQUE/);
    await c.execute(
      `UPDATE backups SET status='failed', error_code='INTERRUPTED', finished_at=${T} WHERE status='running'`,
    );
    expect(await tryx(c, run(3))).toBe("OK");
  });

  it("CHECK ve tekillik ihlalleri reddedilir", async () => {
    const good = "universal-mail-20261116-101010-manual.umbk";
    expect(await tryx(c, okRow(good))).toBe("OK");
    const bad = [
      okRow(good), // aynı dosya adı
      okRow("../../etc/passwd-xxxx"),
      okRow("a\\b-windows-path.umbk"),
      okRow("s.umbk"),
      okRow("x".repeat(121)),
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('daily','running','universal-mail-20261116-1-x.umbk','/tmp/x','0.1.0',7,${T})`,
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','done','universal-mail-20261116-2-x.umbk','/tmp/x','0.1.0',7,${T})`,
      // ok ama boyut/özet/bitiş yok
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','ok','universal-mail-20261116-3-x.umbk','/tmp/x','0.1.0',7,${T})`,
      // failed ama kod yok
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','failed','universal-mail-20261116-4-x.umbk','/tmp/x','0.1.0',7,${T})`,
      // küçük harfli/boşluklu hata kodu
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,error_code,created_at) VALUES ('manual','failed','universal-mail-20261116-5-x.umbk','/tmp/x','0.1.0',7,'disk full',${T})`,
      // kısa özet, negatif boyut, negatif şema, boş klasör, geçersiz gizli bayrağı
      `INSERT INTO backups(kind,status,file_name,folder,size_bytes,sha256,app_version,schema_migrations,created_at,finished_at) VALUES ('manual','ok','universal-mail-20261116-6-x.umbk','/tmp/x',1,'abc','0.1.0',7,${T},${T})`,
      `INSERT INTO backups(kind,status,file_name,folder,size_bytes,app_version,schema_migrations,created_at) VALUES ('manual','running','universal-mail-20261116-7-x.umbk','/tmp/x',-1,'0.1.0',7,${T})`,
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','running','universal-mail-20261116-8-x.umbk','/tmp/x','0.1.0',-1,${T})`,
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,created_at) VALUES ('manual','running','universal-mail-20261116-9-x.umbk','','0.1.0',7,${T})`,
      `INSERT INTO backups(kind,status,file_name,folder,app_version,schema_migrations,includes_secrets,created_at) VALUES ('manual','running','universal-mail-20261116-10-x.umbk','/tmp/x','0.1.0',7,2,${T})`,
    ];
    for (const s of bad) expect(await tryx(c, s), s).not.toBe("OK");
    expect(await num(c, "SELECT COUNT(*) FROM backups")).toBe(1);
  });

  it("saklama sorgusu kısmi indeksi INDEXED BY ile kullanır (planlayıcı tahmini yanıltıcı)", async () => {
    await seedLeads(c, { n: 2000, seed: 3, now: T });
    await c.execute("ANALYZE");
    // sqlite_stat1, `last_contacted_at` için seçici bir eşitlik tahmin eder (çoğu değer farklı zaman damgası) ve satırların
    // ~%95'i NULL olsa da `leads_last_contacted_idx`'i seçer. Bu yüzden saklama önizlemesi/silmesi (paket Y) indeksi
    // AÇIKÇA adlandırır; indeks yoksa veya koşulla kullanılamazsa sorgu hata verir (sessizce tam tarama olmaz).
    const sqlText = `SELECT COUNT(*) FROM leads INDEXED BY leads_retention_idx WHERE last_contacted_at IS NULL AND created_at < ${T - 365 * 86_400_000}`;
    const plan = (await rows(c, `EXPLAIN QUERY PLAN ${sqlText}`))
      .map((r) => String(r.detail))
      .join(" | ");
    expect(plan).toMatch(/USING INDEX leads_retention_idx \(created_at<\?\)/);
    expect(await num(c, sqlText)).toBe(
      await num(
        c,
        `SELECT COUNT(*) FROM leads NOT INDEXED WHERE last_contacted_at IS NULL AND created_at < ${T - 365 * 86_400_000}`,
      ),
    );
    // Koşulda `last_contacted_at IS NULL` yoksa kısmi indeks kullanılamaz: hata, sessiz tam tarama değil.
    expect(
      await tryx(
        c,
        `SELECT COUNT(*) FROM leads INDEXED BY leads_retention_idx WHERE created_at < ${T}`,
      ),
    ).toMatch(/no query solution/);
    const b = (
      await rows(
        c,
        "EXPLAIN QUERY PLAN SELECT * FROM backups WHERE kind = 'startup' ORDER BY created_at DESC",
      )
    )
      .map((r) => String(r.detail))
      .join(" | ");
    expect(b).toMatch(/backups_kind_created_idx/);
  });
});

describe.skipIf(unsafeTmp)("0006: eski sürüm uyumu", () => {
  it("eski migrator yükseltilmiş veritabanını atlar; eski biçimli yazımlar çalışır", async () => {
    const h = await build0005();
    await seed0005(h.client);
    await upgrade(h);
    const c = h.client;
    await migrate(drizzle(c), { migrationsFolder: UPTO_0005 });
    expect(await num(c, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(7);
    expect(
      await tryx(
        c,
        `INSERT INTO leads(place_id,source,display_name,status,created_at,updated_at) VALUES (NULL,'demo','Eski lead','new',${T},${T})`,
      ),
    ).toBe("OK");
    expect(await tryx(c, "DELETE FROM leads WHERE display_name = 'Eski lead'")).toBe("OK");
  });
});

describe.skipIf(unsafeTmp)("0006: geri alma (iki aşamalı, onaylı)", () => {
  const noAudit = (d: Record<string, Record<string, unknown>[]>) => {
    const { audit_log: _a, ...rest } = d;
    void _a;
    return { ...rest, __seq: rest.__seq!.filter((x) => x.name !== "audit_log") };
  };

  it("yedek kaydı yoksa: yukarı → aşağı → 0005 ile bire bir aynı; yeniden yükseltme çalışır", async () => {
    const h = await build0005();
    await seed0005(h.client);
    const sBefore = await schema(h.client);
    const dBefore = await dump(h.client);
    await upgrade(h);
    const plan = await planRollback0006(file, { migrationsFolder: MIGRATIONS });
    expect(plan.blockers).toEqual([]);
    expect(plan.code).toMatch(/^RB6-[0-9A-F]{16}$/);
    expect(plan.backupRows).toBe(0);
    expect(plan.requirements.join(" ")).not.toMatch(/accept-data-loss/);
    const r = await rollbackFaz6(h.client, {
      dbFile: file,
      expectedCode: plan.code,
      migrationsFolder: MIGRATIONS,
    });
    expect(fs.existsSync(r.backupPath)).toBe(true);
    expect(await schema(h.client)).toEqual(sBefore);
    expect(noAudit(await dump(h.client))).toEqual(noAudit(dBefore));
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    expect(
      await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action='${AUDIT_ACTION_0006}'`),
    ).toBe(1);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    expect((await upgrade(h)).pending).toBe(1);
  });

  it("yedek kayıtları varsa onaysız uygulanmaz; onayla kayıtlar silinir, DOSYALAR kalır ve planda listelenir", async () => {
    const h = await build0005();
    await upgrade(h);
    const folder = path.join(dir, "yedekler");
    fs.mkdirSync(folder);
    const name = "universal-mail-20261116-101010-manual.umbk";
    fs.writeFileSync(path.join(folder, name), "UMBACKUP-test");
    await h.client.execute(
      `INSERT INTO backups(kind,status,file_name,folder,size_bytes,sha256,app_version,schema_migrations,created_at,finished_at) VALUES ('manual','ok','${name}','${folder.replace(/'/g, "''")}',13,'${"b".repeat(64)}','0.1.0',7,${T},${T})`,
    );
    await h.client.execute(okRow("universal-mail-20261116-101011-manual.umbk")); // dosyası yok
    const plan = await planRollback0006(file, { migrationsFolder: MIGRATIONS });
    expect(plan.backupRows).toBe(2);
    expect(plan.keptFiles).toEqual([{ folder, fileName: name }]);
    expect(plan.requirements.join(" ")).toMatch(/accept-data-loss/);
    await expect(
      rollbackFaz6(h.client, {
        dbFile: file,
        expectedCode: plan.code,
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toThrow(/accept-data-loss/);
    expect(await num(h.client, "SELECT COUNT(*) FROM backups")).toBe(2);
    const r = await rollbackFaz6(h.client, {
      dbFile: file,
      expectedCode: plan.code,
      migrationsFolder: MIGRATIONS,
      acceptDataLoss: true,
    });
    expect(r.backupRows).toBe(2);
    expect(fs.readFileSync(path.join(folder, name), "utf8")).toBe("UMBACKUP-test");
    expect(await num(h.client, "SELECT COUNT(*) FROM sqlite_master WHERE name='backups'")).toBe(0);
  });

  it("korumalar: son geçiş değilse plan engeller; kod uyuşmazsa ve gerçek veride izin yoksa hiçbir şey değişmez", async () => {
    const h = await build0005();
    const p0 = await planRollback0006(file, { migrationsFolder: MIGRATIONS });
    expect(p0.blockers.join(" ")).toMatch(/SON uygulanan/);
    await expect(
      executeRollback0006(file, { confirmCode: "RB6-X", migrationsFolder: MIGRATIONS }),
    ).rejects.toBeInstanceOf(RollbackError);
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const p1 = await planRollback0006(file, { migrationsFolder: MIGRATIONS });
    expect((await planRollback0006(file, { migrationsFolder: MIGRATIONS })).code).toBe(p1.code);
    await expect(
      executeRollback0006(file, { confirmCode: "RB6-WRONG", migrationsFolder: MIGRATIONS }),
    ).rejects.toThrow(/kod/i);
    await expect(
      executeRollback0006(file, {
        confirmCode: p1.code,
        migrationsFolder: MIGRATIONS,
        tempRoots: [path.join(dir, "baska")],
      }),
    ).rejects.toThrow(/allow-live-data/);
    await expect(
      executeRollback0006(file, {
        confirmCode: p1.code,
        migrationsFolder: MIGRATIONS,
        tempRoots: [path.join(dir, "baska")],
        allowLiveData: true,
        typedDbName: "yanlis.db",
      }),
    ).rejects.toThrow(/type-db-name/);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(7);
    // Doğru kod: geçici dizinde izin gerekmez.
    const r = await executeRollback0006(file, {
      confirmCode: p1.code,
      migrationsFolder: MIGRATIONS,
    });
    expect(fs.existsSync(r.backupPath)).toBe(true);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    await expect(
      executeRollback0006(path.join(dir, "yok.db"), { confirmCode: "x" }),
    ).rejects.toThrow(/bulunamadı/);
  });
});

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "rollback-0006.ts"), ...args],
      { cwd: REPO, env: { ...process.env, UM_MIGRATIONS_DIR: MIGRATIONS, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe.skipIf(unsafeTmp)("rollback-0006 betiği (gerçek süreç)", () => {
  it("--db zorunlu; plan kod üretir ve hiçbir şeyi değiştirmez; kodla uygulanır", async () => {
    const h = await build0005();
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const none = await runCli([], { UM_DB_PATH: file });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/--db .* zorunlu/);
    const plan = await runCli(["--db", file]);
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain("hiçbir şey değiştirilmedi");
    const code = /RB6-[0-9A-F]{16}/.exec(plan.out)?.[0];
    expect(code).toBeDefined();
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(7);
    const ok = await runCli(["--db", file, "--confirm", code!]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("db.rollback_0006");
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
  }, 60_000);
});
