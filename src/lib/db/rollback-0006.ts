import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { isBusyConnectionError, openDatabase } from "./client";
import { activeMaintenance, acquireMaintenance } from "./maintenance";
import { fingerprint, isLiveTarget, RollbackError } from "./rollback-0003";

/**
 * Migrasyon 0006'nın (Faz 6 P0 temeli) geri alınması. Yalnızca `scripts/rollback-0006.ts` ve testler kullanır; uygulamanın
 * normal çalışma yolu (web, çalışan, Electron, başlatıcılar) bu modülü ASLA içe aktarmaz (testle doğrulanır). Geri
 * alındıktan sonra veritabanı 0005 şemasındadır ve yalnızca Faz 6 öncesi sürümle açılmalıdır.
 *
 * GÜVENLİK, 0005 geri almasıyla aynı iki aşamalı kalıptır: hedef açıkça verilir (`--db`), varsayılan işlem yalnızca
 * PLAN'dır, uygulama plana ve veritabanı durumuna bağlı tek kullanımlık kod ister, gerçek veride (geçici dizin dışı)
 * ayrıca `allowLiveData` + dosya adı istenir, yedek alınıp DOĞRULANMADAN geri alma başlamaz ve denetim kaydı aynı işlemde
 * yazılır.
 *
 * VERİ SÖZLEŞMESİ:
 * - 0006'nın tek tablosu `backups` (yedek KAYITLARI) ve indeksleri ile `leads_retention_idx` silinir. Kayıt varsa plan
 *   sayıyı gösterir ve uygulama `acceptDataLoss` olmadan REDDEDİLİR.
 * - Diskteki yedek DOSYALARI (.umbk) SİLİNMEZ ve plan bunları (klasör + ad) listeler: Faz 6 öncesi sürüm onları
 *   tanımaz, ama Faz 6 sürümü yeniden kurulunca "Dosyadan geri yükle" ile açılabilir.
 * - Başka hiçbir tabloya dokunulmaz; bekçiler (satır sayıları, tablo/indeks kümesi, migrasyon sayısı, denetim, yabancı
 *   anahtar) başarısız olursa işlemin tamamı geri alınır. 0006 kaydı `__drizzle_migrations` tablosundan silinir.
 */

const BAD = "abs(-9223372036854775808)";
const guard = (cond: string) => `SELECT CASE WHEN ${cond} THEN ${BAD} END`;
const TAG_0006 = "0006_faz6";
export const AUDIT_ACTION_0006 = "db.rollback_0006";

/** 0006'nın eklediği tablolar. */
export const FAZ6_TABLES = ["backups"] as const;
/** 0006'nın mevcut tablolara eklediği indeksler (tablo silinince kendi indeksleri de gider). */
export const FAZ6_INDEXES = ["leads_retention_idx"] as const;

/** Korunan Faz 6 öncesi tablolar: satır sayısı geri almadan önce ve sonra aynı olmalı. */
const KEPT_TABLES = ["leads", "places", "messages", "campaigns", "campaign_leads", "suppressions"];

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function readJournal(folder: string): JournalEntry[] {
  return (
    JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    }
  ).entries;
}

export interface AuditDetail0006 {
  backup: string;
  planCode: string;
  backupRows: number;
  live: boolean;
}

export function buildRollback0006Statements(
  when0006: number,
  audit?: { at: number; detail: AuditDetail0006 },
): InStatement[] {
  const g = (k: string) => `(SELECT \`v\` FROM \`__um_0006\` WHERE \`k\` = '${k}')`;
  const counts = KEPT_TABLES.map((t) => `('${t}', (SELECT COUNT(*) FROM \`${t}\`))`).join(", ");
  const names = [...FAZ6_TABLES, ...FAZ6_INDEXES].map((n) => `'${n}'`).join(", ");
  const stmts: InStatement[] = [
    "CREATE TEMP TABLE `__um_0006` (`k` text PRIMARY KEY, `v` integer)",
    `INSERT INTO \`__um_0006\` VALUES ${counts}, ('audit', (SELECT COUNT(*) FROM \`audit_log\`))`,
    ...FAZ6_INDEXES.map((i) => `DROP INDEX IF EXISTS \`${i}\``),
    ...FAZ6_TABLES.map((t) => `DROP TABLE IF EXISTS \`${t}\``),
    `DELETE FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${Math.trunc(when0006)}`,
  ];
  if (audit) {
    stmts.push({
      sql: "INSERT INTO `audit_log` (`at`, `action`, `entity`, `entity_id`, `detail`) VALUES (?, ?, 'database', NULL, ?)",
      args: [audit.at, AUDIT_ACTION_0006, JSON.stringify(audit.detail)],
    });
  }
  stmts.push(
    ...KEPT_TABLES.map((t) => guard(`(SELECT COUNT(*) FROM \`${t}\`) <> ${g(t)}`)),
    guard(`(SELECT COUNT(*) FROM \`sqlite_master\` WHERE \`name\` IN (${names})) <> 0`),
    guard("(SELECT COUNT(*) FROM `sqlite_master` WHERE `tbl_name` = 'backups') <> 0"),
    guard("(SELECT COUNT(*) FROM `__drizzle_migrations`) <> 6"),
    guard(`(SELECT COUNT(*) FROM \`audit_log\`) <> ${g("audit")} + ${audit ? 1 : 0}`),
    guard("EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    "DROP TABLE `__um_0006`",
  );
  return stmts;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

/** Diskte KALACAK yedek dosyaları (kayıtlardan; yalnızca var olanlar). */
export interface KeptBackupFile {
  folder: string;
  fileName: string;
}

async function backupRows(client: Client): Promise<{ count: number; files: KeptBackupFile[] }> {
  const rows = (await client.execute("SELECT folder, file_name FROM backups ORDER BY id")).rows.map(
    (r) => ({ folder: String(r.folder), fileName: String(r.file_name) }),
  );
  return {
    count: rows.length,
    files: rows.filter((f) => {
      try {
        return fs.statSync(path.join(f.folder, f.fileName)).isFile();
      } catch {
        return false;
      }
    }),
  };
}

const keyOf = (file: string): string => {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
};

function makeCode(file: string, fp: Record<string, unknown>, migrations: number[]): string {
  const h = crypto
    .createHash("sha256")
    .update(JSON.stringify({ v: 1, tag: TAG_0006, db: keyOf(file), fp, migrations }))
    .digest("hex");
  return `RB6-${h.slice(0, 16).toUpperCase()}`;
}

export interface Rollback0006Plan {
  dbFile: string;
  live: boolean;
  sizeBytes: number;
  appliedMigrations: number;
  lastIsFaz6: boolean;
  /** Geri almayla silinecek yedek KAYDI sayısı. */
  backupRows: number;
  /** Diskte KALAN yedek dosyaları (geri alma dosyalara dokunmaz). */
  keptFiles: KeptBackupFile[];
  code: string;
  blockers: string[];
  requirements: string[];
  notes: string[];
}

const LAST_ONLY =
  "Geri alma yalnızca 0006'nın SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 7 kayıt, sonuncusu 0006).";

function openReadOnly(file: string): Client {
  if (!fs.existsSync(file))
    throw new RollbackError("Veritabanı dosyası bulunamadı (oluşturulmaz).");
  if (!fs.statSync(file).isFile()) throw new RollbackError("Hedef bir dosya değil.");
  return createClient({ url: toLibsqlUrl(file) });
}

/** Geri alma PLANI: hiçbir veriyi değiştirmez (yalnızca okuma; yedek, kilit veya dosya oluşturmaz). */
export async function planRollback0006(
  dbFile: string,
  opts: { migrationsFolder?: string; tempRoots?: string[] } = {},
): Promise<Rollback0006Plan> {
  const file = path.resolve(dbFile);
  const client = openReadOnly(file);
  try {
    const folder = opts.migrationsFolder ?? migrationsDir();
    const e6 = readJournal(folder).find((e) => e.tag === TAG_0006);
    if (!e6) throw new RollbackError("Bu sürümde 0006 geçişi yok.");
    const blockers: string[] = [];
    let times: number[] = [];
    try {
      times = (
        await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      ).rows.map((r) => Number(r.created_at));
    } catch {
      blockers.push("Bu dosya bir Universal Mail veritabanı değil (migrasyon tablosu yok).");
    }
    const lastIsFaz6 = times.length === 7 && times[6] === e6.when;
    if (!blockers.length && !lastIsFaz6) blockers.push(LAST_ONLY);
    const m = activeMaintenance(file);
    if (m) blockers.push(`Başka bir süreç (pid ${m.pid}) şu anda şema bakımında: ${m.purpose}.`);
    const live = isLiveTarget(file, opts.tempRoots);
    const requirements = live
      ? [
          "Hedef geçici dizinde DEĞİL (gerçek veri): --allow-live-data gerekir.",
          `Hedef dosya adı elle yazılmalı: --type-db-name ${path.basename(file)}`,
        ]
      : [];
    const notes: string[] = [];
    let fp: Record<string, unknown> = {};
    let rows = { count: 0, files: [] as KeptBackupFile[] };
    if (!blockers.length) {
      fp = await fingerprint(client);
      rows = await backupRows(client);
      if (rows.count > 0)
        requirements.push(
          `${rows.count} yedek kaydı SİLİNECEK (dosyalar kalır): --accept-data-loss gerekir.`,
        );
      if (rows.files.length > 0)
        notes.push(
          `Diskteki ${rows.files.length} yedek dosyası SİLİNMEZ; Faz 6 sürümüyle "Dosyadan geri yükle" ile açılabilir.`,
        );
    }
    return {
      dbFile: file,
      live,
      sizeBytes: fs.statSync(file).size,
      appliedMigrations: times.length,
      lastIsFaz6,
      backupRows: rows.count,
      keptFiles: rows.files,
      code: blockers.length ? "" : makeCode(file, fp, times),
      blockers,
      requirements,
      notes,
    };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Uygulama

async function verifyBackup(backupPath: string, expected: Record<string, number>): Promise<void> {
  const b = createClient({ url: toLibsqlUrl(backupPath) });
  try {
    if ((await b.execute("PRAGMA quick_check")).rows[0]?.[0] !== "ok")
      throw new RollbackError("Yedek bütünlük denetiminden (quick_check) geçemedi.");
    for (const [t, n] of Object.entries(expected)) {
      const got = Number((await b.execute(`SELECT COUNT(*) FROM "${t}"`)).rows[0]?.[0] ?? -1);
      if (got !== n)
        throw new RollbackError("Yedekteki satır sayıları kaynak veritabanıyla uyuşmuyor.");
    }
  } catch (e) {
    if (e instanceof RollbackError) throw e;
    throw new RollbackError(`Yedek açılamadı veya okunamadı: ${(e as Error).message}`);
  } finally {
    b.close();
  }
}

export interface Rollback0006Result {
  backupPath: string;
  backupRows: number;
  keptFiles: KeptBackupFile[];
}

/** Çekirdek: kilit, yazıcı yoklaması, parmak izi = kod, yedek + doğrulama, sonra işlem içinde geri alma + denetim. */
export async function rollbackFaz6(
  client: Client,
  opts: {
    dbFile: string;
    expectedCode: string;
    acceptDataLoss?: boolean;
    migrationsFolder?: string;
    backupDir?: string;
    live?: boolean;
  },
): Promise<Rollback0006Result> {
  const folder = opts.migrationsFolder ?? migrationsDir();
  const e6 = readJournal(folder).find((e) => e.tag === TAG_0006);
  if (!e6) throw new RollbackError("Bu sürümde 0006 geçişi yok.");
  if (!fs.existsSync(opts.dbFile)) throw new RollbackError("Veritabanı dosyası bulunamadı.");
  if (!opts.expectedCode) throw new RollbackError("Doğrulama kodu gerekli.");

  const lock = await acquireMaintenance(opts.dbFile, "rollback-0006", 30_000);
  try {
    try {
      await client.execute("PRAGMA busy_timeout = 0");
      const tx = await client.transaction("write");
      await tx.rollback();
    } catch (e) {
      if (isBusyConnectionError(e))
        throw new RollbackError(
          "Veritabanına başka bir süreç yazıyor; uygulamayı kapatıp yeniden deneyin. Hiçbir değişiklik yapılmadı.",
        );
      throw e;
    } finally {
      await client.execute("PRAGMA busy_timeout = 8000");
    }

    const times = (
      await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
    ).rows.map((r) => Number(r.created_at));
    if (times.length !== 7 || times[6] !== e6.when) throw new RollbackError(LAST_ONLY);
    const fp = await fingerprint(client);
    if (makeCode(opts.dbFile, fp, times) !== opts.expectedCode)
      throw new RollbackError(
        "Doğrulama kodu uyuşmuyor: plan çıkarıldıktan sonra veritabanı değişti veya kod başka bir hedefe/duruma ait. " +
          "Hiçbir değişiklik yapılmadı; planı yeniden çıkarın.",
      );
    const rows = await backupRows(client);
    if (rows.count > 0 && !opts.acceptDataLoss)
      throw new RollbackError(
        "Yedek kayıtları var ve geri almayla silinir (dosyalar kalır). Hiçbir değişiklik yapılmadı: açık onay için --accept-data-loss gerekir.",
      );

    const counts: Record<string, number> = {};
    for (const t of [...KEPT_TABLES, ...FAZ6_TABLES])
      counts[t] = Number((await client.execute(`SELECT COUNT(*) FROM "${t}"`)).rows[0]?.[0] ?? 0);

    const dir = opts.backupDir ?? path.join(path.dirname(opts.dbFile), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `pre-rollback-0006-${stamp}.db`);
    fs.copyFileSync(opts.dbFile, backupPath);
    if (Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${opts.dbFile}-wal`))
      fs.copyFileSync(`${opts.dbFile}-wal`, `${backupPath}-wal`);
    await verifyBackup(backupPath, counts);

    await client.migrate(
      buildRollback0006Statements(e6.when, {
        at: Date.now(),
        detail: {
          backup: path.basename(backupPath),
          planCode: opts.expectedCode,
          backupRows: rows.count,
          live: opts.live ?? false,
        },
      }),
    );
    const fk = await client.execute("PRAGMA foreign_key_check");
    if (fk.rows.length > 0)
      throw new RollbackError(
        `Geri alma sonrası ${fk.rows.length} yabancı anahtar ihlali. Yedek: ${backupPath}`,
      );
    return { backupPath, backupRows: rows.count, keptFiles: rows.files };
  } finally {
    lock.release();
  }
}

export interface Execute0006Options {
  confirmCode: string;
  allowLiveData?: boolean;
  typedDbName?: string;
  acceptDataLoss?: boolean;
  migrationsFolder?: string;
  backupDir?: string;
  /** Yalnızca testler: geçici dizin kökleri. */
  tempRoots?: string[];
}

/** Korumalı uygulama: gerçek veri izinleri → plan kodu → çekirdek. Hedef ortamdan veya varsayılandan SEÇİLMEZ. */
export async function executeRollback0006(
  dbFile: string,
  opts: Execute0006Options,
): Promise<Rollback0006Result> {
  const file = path.resolve(dbFile);
  if (!fs.existsSync(file))
    throw new RollbackError("Veritabanı dosyası bulunamadı (oluşturulmaz).");
  const live = isLiveTarget(file, opts.tempRoots);
  if (live) {
    if (!opts.allowLiveData)
      throw new RollbackError(
        "Hedef geçici dizinde değil (gerçek veri). Hiçbir değişiklik yapılmadı: açık izin için --allow-live-data gerekir.",
      );
    if (opts.typedDbName !== path.basename(file))
      throw new RollbackError(
        `Hedef dosya adı doğrulanamadı. Hiçbir değişiklik yapılmadı: --type-db-name ${path.basename(file)} yazın.`,
      );
  }
  const plan = await planRollback0006(file, {
    migrationsFolder: opts.migrationsFolder,
    tempRoots: opts.tempRoots,
  });
  if (plan.blockers.length) throw new RollbackError(plan.blockers.join(" "));
  if (!opts.confirmCode || plan.code !== opts.confirmCode)
    throw new RollbackError(
      "Doğrulama kodu uyuşmuyor: plan çıkarıldıktan sonra veritabanı değişti veya kod yanlış. Hiçbir değişiklik yapılmadı; planı yeniden çıkarın.",
    );
  const handle = await openDatabase(file);
  try {
    return await rollbackFaz6(handle.client, {
      dbFile: file,
      expectedCode: opts.confirmCode,
      acceptDataLoss: opts.acceptDataLoss,
      migrationsFolder: opts.migrationsFolder,
      backupDir: opts.backupDir,
      live,
    });
  } finally {
    handle.client.close();
  }
}
