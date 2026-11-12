import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { isBusyConnectionError, openDatabase } from "./client";
import { activeMaintenance, acquireMaintenance } from "./maintenance";
import { fingerprint, isLiveTarget, RollbackError } from "./rollback-0003";

/**
 * Migrasyon 0004'ün (Faz 4 P0 temeli) geri alınması. Yalnızca `scripts/rollback-0004.ts` ve testler kullanır; uygulamanın
 * normal çalışma yolu (web, çalışan, Electron, başlatıcılar) bu modülü ASLA içe aktarmaz (testle doğrulanır). Geri
 * alındıktan sonra veritabanı 0003 şemasındadır ve yalnızca Faz 4 öncesi sürümle açılmalıdır.
 *
 * GÜVENLİK, 0003 geri almasıyla aynı iki aşamalı kalıptır: hedef açıkça verilir (`--db`), varsayılan işlem yalnızca
 * PLAN'dır, uygulama plana ve veritabanı durumuna bağlı tek kullanımlık kod ister, gerçek veride (geçici dizin dışı)
 * ayrıca `allowLiveData` + dosya adı istenir, yedek alınıp DOĞRULANMADAN geri alma başlamaz ve denetim kaydı aynı işlemde
 * yazılır.
 *
 * VERİ SÖZLEŞMESİ (geri alma KAYIPLIDIR ve bu açıkça onaylanır):
 * - Faz 4'ün yeni tabloları (`scan_schedules`, `notifications`, `domain_registrations`, `saved_filters`) ve yeni sütunları
 *   (`scans.origin/schedule_id/schedule_slot/pause_code`, `places.place_id_checked_at/gone_at/status_checked_at`,
 *   `leads.archived_at`, `lead_enrichment.site_domain`, `templates.followup_reuse_subject`) silinir. Bunlarda veri varsa
 *   plan sayıları gösterir ve uygulama `acceptDataLoss` olmadan REDDEDİLİR. Arşivlenmiş lead'ler geri almadan sonra
 *   yeniden etkin görünür. Tam geri dönüş için `pre-rollback-*` yedeği kullanılır.
 * - Faz 4 öncesi her satır, kimlik, `sqlite_sequence` ve 0003 indeksleri korunur. `scans.schedule_id` bir yabancı anahtar
 *   olduğundan (SQLite `DROP COLUMN` bunu kaldıramaz) `scans` tablosu 0000'daki tanımıyla güvenli kalıpla yeniden kurulur
 *   (kimlikler, `scan_units`/`place_snapshots` bağlantıları korunur); diğer sütunlar `DROP COLUMN` ile kaldırılır.
 * - Bekçiler (satır sayıları, kimlik toplamı, sıra, indeks kümesi, yabancı anahtar) başarısız olursa işlemin tamamı geri
 *   alınır. 0004 kaydı `__drizzle_migrations` tablosundan silinir (yeniden yükseltme 0004'ü yeniden uygular).
 */

const BAD = "abs(-9223372036854775808)";
const guard = (cond: string) => `SELECT CASE WHEN ${cond} THEN ${BAD} END`;
const TAG_0004 = "0004_faz4";
export const AUDIT_ACTION_0004 = "db.rollback_0004";

/** 0004'ün eklediği tablolar (bağımlılık sırasıyla silinir). */
export const FAZ4_TABLES = [
  "notifications",
  "saved_filters",
  "domain_registrations",
  "scan_schedules",
] as const;

/** 0004'ün MEVCUT tablolara eklediği indeksler. */
export const FAZ4_INDEXES_ON_EXISTING = [
  "scans_schedule_slot_uq",
  "places_opened_detected_idx",
  "places_new_detected_idx",
  "places_first_seen_idx",
  "places_future_watch_idx",
  "places_id_checked_idx",
  "leads_archived_idx",
  "lead_enrichment_site_domain_idx",
  "messages_out_day_idx",
  "messages_in_received_idx",
] as const;

/** `DROP COLUMN` ile kaldırılan sütunlar (`scans` ayrıca yeniden kurulur). */
const DROP_COLUMNS: [table: string, column: string][] = [
  ["places", "place_id_checked_at"],
  ["places", "gone_at"],
  ["places", "status_checked_at"],
  ["leads", "archived_at"],
  ["lead_enrichment", "site_domain"],
  ["templates", "followup_reuse_subject"],
];

/** Korunan Faz 4 öncesi tablolar: satır sayısı geri almadan önce ve sonra aynı olmalı. */
const KEPT_TABLES = ["scans", "places", "leads", "lead_enrichment", "templates", "messages"];

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

/** 0000 geçişindeki `scans` tanımı ve iki indeksi (0001–0003 `scans`'a dokunmaz). */
function oldScansParts(folder: string, tag0000: string) {
  const src = fs.readFileSync(path.join(folder, `${tag0000}.sql`), "utf8").replace(/\r\n/g, "\n");
  const m = /CREATE TABLE `scans` \(.*?\n\);\n/s.exec(src);
  if (!m) throw new RollbackError("0000 geçişinde scans tablosu bulunamadı.");
  const ddl = m[0]
    .replace("CREATE TABLE `scans` (", "CREATE TABLE `__old_scans` (")
    .replace(/;\n$/, "");
  const idx = (src.match(/CREATE (?:UNIQUE )?INDEX `scans_[a-z_]+` ON `scans`[^\n]*?;/g) ?? []).map(
    (i) => i.replace(/;$/, ""),
  );
  const cols = [...ddl.matchAll(/^\t`([a-z_]+)` /gm)].map((c) => `\`${c[1]}\``).join(", ");
  if (idx.length !== 2) throw new RollbackError("0000 geçişinde 2 scans indeksi bekleniyordu.");
  return { ddl, idx, cols };
}

export interface AuditDetail0004 {
  backup: string;
  planCode: string;
  faz4Data: Faz4DataCounts;
  live: boolean;
}

export function buildRollback0004Statements(
  folder: string,
  when0004: number,
  audit?: { at: number; detail: AuditDetail0004 },
): InStatement[] {
  const e0 = readJournal(folder).find((e) => e.idx === 0);
  if (!e0) throw new RollbackError("0000 kaydı günlükte yok.");
  const { ddl, idx, cols } = oldScansParts(folder, e0.tag);
  const g = (k: string) => `(SELECT \`v\` FROM \`__um_0004\` WHERE \`k\` = '${k}')`;
  const seqNow = "COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'scans'), 0)";
  const counts = KEPT_TABLES.map((t) => `('${t}', (SELECT COUNT(*) FROM \`${t}\`))`).join(", ");
  const stmts: InStatement[] = [
    "CREATE TEMP TABLE `__um_0004` (`k` text PRIMARY KEY, `v` integer)",
    `INSERT INTO \`__um_0004\` VALUES ${counts}, ('scan_idsum', (SELECT COALESCE(SUM(\`id\`), 0) FROM \`scans\`)), ('units_linked', (SELECT COUNT(*) FROM \`scan_units\`)), ('snap_linked', (SELECT COUNT(*) FROM \`place_snapshots\`)), ('seq', ${seqNow}), ('audit', (SELECT COUNT(*) FROM \`audit_log\`))`,
    ...FAZ4_INDEXES_ON_EXISTING.map((i) => `DROP INDEX IF EXISTS \`${i}\``),
    // scans: 0000 tanımıyla güvenli yeniden kurulum (schedule_id yabancı anahtarı DROP COLUMN ile kaldırılamaz).
    ddl,
    `INSERT INTO \`__old_scans\` (${cols}) SELECT ${cols} FROM \`scans\``,
    guard("(SELECT COUNT(*) FROM `scans`) <> (SELECT COUNT(*) FROM `__old_scans`)"),
    "DELETE FROM `sqlite_sequence` WHERE `name` = '__old_scans'",
    "INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__old_scans', `seq` FROM `sqlite_sequence` WHERE `name` = 'scans'",
    "DROP TABLE `scans`",
    "ALTER TABLE `__old_scans` RENAME TO `scans`",
    ...idx,
    ...FAZ4_TABLES.map((t) => `DROP TABLE IF EXISTS \`${t}\``),
    ...DROP_COLUMNS.map(([t, c]) => `ALTER TABLE \`${t}\` DROP COLUMN \`${c}\``),
    `DELETE FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${Math.trunc(when0004)}`,
  ];
  if (audit) {
    stmts.push({
      sql: "INSERT INTO `audit_log` (`at`, `action`, `entity`, `entity_id`, `detail`) VALUES (?, ?, 'database', NULL, ?)",
      args: [audit.at, AUDIT_ACTION_0004, JSON.stringify(audit.detail)],
    });
  }
  stmts.push(
    ...KEPT_TABLES.map((t) => guard(`(SELECT COUNT(*) FROM \`${t}\`) <> ${g(t)}`)),
    guard(`(SELECT COALESCE(SUM(\`id\`), 0) FROM \`scans\`) <> ${g("scan_idsum")}`),
    guard(
      `(SELECT COUNT(*) FROM \`scan_units\`) <> ${g("units_linked")} OR (SELECT COUNT(*) FROM \`place_snapshots\`) <> ${g("snap_linked")}`,
    ),
    guard(
      `${seqNow} < ${g("seq")} OR ${seqNow} < (SELECT COALESCE(MAX(\`id\`), 0) FROM \`scans\`)`,
    ),
    guard(
      "(SELECT COUNT(*) FROM `sqlite_master` WHERE `type` = 'index' AND `tbl_name` = 'scans' AND `name` LIKE 'scans\\_%' ESCAPE '\\') <> 2 OR (SELECT COUNT(*) FROM `sqlite_master` WHERE `name` = '__old_scans') <> 0",
    ),
    guard(
      `(SELECT COUNT(*) FROM \`sqlite_master\` WHERE \`name\` IN (${[...FAZ4_TABLES, ...FAZ4_INDEXES_ON_EXISTING].map((n) => `'${n}'`).join(", ")})) <> 0`,
    ),
    guard("(SELECT COUNT(*) FROM `__drizzle_migrations`) <> 4"),
    guard(`(SELECT COUNT(*) FROM \`audit_log\`) <> ${g("audit")} + ${audit ? 1 : 0}`),
    guard("EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    "DROP TABLE `__um_0004`",
  );
  return stmts;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

/** Geri almayla kaybolacak Faz 4 verisi (satır sayıları). Hepsi 0 ise geri alma kayıpsızdır. */
export interface Faz4DataCounts {
  scanSchedules: number;
  notifications: number;
  domainRegistrations: number;
  savedFilters: number;
  scansWithFaz4Fields: number;
  placesWithFaz4Fields: number;
  archivedLeads: number;
  enrichmentSiteDomains: number;
  templatesReuseSubjectOff: number;
}

async function faz4Data(client: Client): Promise<Faz4DataCounts> {
  const one = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
  return {
    scanSchedules: await one("SELECT COUNT(*) FROM scan_schedules"),
    notifications: await one("SELECT COUNT(*) FROM notifications"),
    domainRegistrations: await one("SELECT COUNT(*) FROM domain_registrations"),
    savedFilters: await one("SELECT COUNT(*) FROM saved_filters"),
    scansWithFaz4Fields: await one(
      "SELECT COUNT(*) FROM scans WHERE origin <> 'manual' OR schedule_id IS NOT NULL OR schedule_slot IS NOT NULL OR pause_code IS NOT NULL",
    ),
    placesWithFaz4Fields: await one(
      "SELECT COUNT(*) FROM places WHERE place_id_checked_at IS NOT NULL OR gone_at IS NOT NULL OR status_checked_at IS NOT NULL",
    ),
    archivedLeads: await one("SELECT COUNT(*) FROM leads WHERE archived_at IS NOT NULL"),
    enrichmentSiteDomains: await one(
      "SELECT COUNT(*) FROM lead_enrichment WHERE site_domain IS NOT NULL",
    ),
    templatesReuseSubjectOff: await one(
      "SELECT COUNT(*) FROM templates WHERE followup_reuse_subject = 0",
    ),
  };
}

const EMPTY_COUNTS: Faz4DataCounts = {
  scanSchedules: 0,
  notifications: 0,
  domainRegistrations: 0,
  savedFilters: 0,
  scansWithFaz4Fields: 0,
  placesWithFaz4Fields: 0,
  archivedLeads: 0,
  enrichmentSiteDomains: 0,
  templatesReuseSubjectOff: 0,
};

export const hasFaz4Data = (c: Faz4DataCounts) => Object.values(c).some((n) => n > 0);

const keyOf = (file: string): string => {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
};

function makeCode(file: string, fp: Record<string, unknown>, migrations: number[]): string {
  const h = crypto
    .createHash("sha256")
    .update(JSON.stringify({ v: 1, tag: TAG_0004, db: keyOf(file), fp, migrations }))
    .digest("hex");
  return `RB4-${h.slice(0, 16).toUpperCase()}`;
}

export interface Rollback0004Plan {
  dbFile: string;
  live: boolean;
  sizeBytes: number;
  appliedMigrations: number;
  lastIsFaz4: boolean;
  /** Geri almayla kaybolacak Faz 4 verisi. */
  faz4Data: Faz4DataCounts;
  code: string;
  blockers: string[];
  requirements: string[];
}

function openReadOnly(file: string): Client {
  if (!fs.existsSync(file))
    throw new RollbackError("Veritabanı dosyası bulunamadı (oluşturulmaz).");
  if (!fs.statSync(file).isFile()) throw new RollbackError("Hedef bir dosya değil.");
  return createClient({ url: toLibsqlUrl(file) });
}

/** Geri alma PLANI: hiçbir veriyi değiştirmez (yalnızca okuma; yedek, kilit veya dosya oluşturmaz). */
export async function planRollback0004(
  dbFile: string,
  opts: { migrationsFolder?: string; tempRoots?: string[] } = {},
): Promise<Rollback0004Plan> {
  const file = path.resolve(dbFile);
  const client = openReadOnly(file);
  try {
    const folder = opts.migrationsFolder ?? migrationsDir();
    const e4 = readJournal(folder).find((e) => e.tag === TAG_0004);
    if (!e4) throw new RollbackError("Bu sürümde 0004 geçişi yok.");
    const blockers: string[] = [];
    let times: number[] = [];
    try {
      times = (
        await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      ).rows.map((r) => Number(r.created_at));
    } catch {
      blockers.push("Bu dosya bir Universal Mail veritabanı değil (migrasyon tablosu yok).");
    }
    const lastIsFaz4 = times.length === 5 && times[4] === e4.when;
    if (!blockers.length && !lastIsFaz4)
      blockers.push(
        "Geri alma yalnızca 0004'ün SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 5 kayıt, sonuncusu 0004).",
      );
    const m = activeMaintenance(file);
    if (m) blockers.push(`Başka bir süreç (pid ${m.pid}) şu anda şema bakımında: ${m.purpose}.`);
    const live = isLiveTarget(file, opts.tempRoots);
    const requirements = live
      ? [
          "Hedef geçici dizinde DEĞİL (gerçek veri): --allow-live-data gerekir.",
          `Hedef dosya adı elle yazılmalı: --type-db-name ${path.basename(file)}`,
        ]
      : [];
    let fp: Record<string, unknown> = {};
    let data = EMPTY_COUNTS;
    if (!blockers.length) {
      fp = await fingerprint(client);
      data = await faz4Data(client);
      if (hasFaz4Data(data))
        requirements.push(
          "Faz 4 verisi var ve geri almayla SİLİNECEK (yedekte kalır): --accept-data-loss gerekir.",
        );
    }
    return {
      dbFile: file,
      live,
      sizeBytes: fs.statSync(file).size,
      appliedMigrations: times.length,
      lastIsFaz4,
      faz4Data: data,
      code: blockers.length ? "" : makeCode(file, fp, times),
      blockers,
      requirements,
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

export interface Rollback0004Result {
  backupPath: string;
  faz4Data: Faz4DataCounts;
}

/** Çekirdek: kilit, yazıcı yoklaması, parmak izi = kod, yedek + doğrulama, sonra işlem içinde geri alma + denetim. */
export async function rollbackFaz4(
  client: Client,
  opts: {
    dbFile: string;
    expectedCode: string;
    acceptDataLoss?: boolean;
    migrationsFolder?: string;
    backupDir?: string;
    live?: boolean;
  },
): Promise<Rollback0004Result> {
  const folder = opts.migrationsFolder ?? migrationsDir();
  const e4 = readJournal(folder).find((e) => e.tag === TAG_0004);
  if (!e4) throw new RollbackError("Bu sürümde 0004 geçişi yok.");
  if (!fs.existsSync(opts.dbFile)) throw new RollbackError("Veritabanı dosyası bulunamadı.");
  if (!opts.expectedCode) throw new RollbackError("Doğrulama kodu gerekli.");

  const lock = await acquireMaintenance(opts.dbFile, "rollback-0004", 30_000);
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
    if (times.length !== 5 || times[4] !== e4.when)
      throw new RollbackError(
        "Geri alma yalnızca 0004'ün SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 5 kayıt, sonuncusu 0004).",
      );
    const fp = await fingerprint(client);
    if (makeCode(opts.dbFile, fp, times) !== opts.expectedCode)
      throw new RollbackError(
        "Doğrulama kodu uyuşmuyor: plan çıkarıldıktan sonra veritabanı değişti veya kod başka bir hedefe/duruma ait. " +
          "Hiçbir değişiklik yapılmadı; planı yeniden çıkarın.",
      );
    const data = await faz4Data(client);
    if (hasFaz4Data(data) && !opts.acceptDataLoss)
      throw new RollbackError(
        "Faz 4 verisi var ve geri almayla silinir. Hiçbir değişiklik yapılmadı: açık onay için --accept-data-loss gerekir.",
      );

    const counts: Record<string, number> = {};
    for (const t of [...KEPT_TABLES, ...FAZ4_TABLES])
      counts[t] = Number((await client.execute(`SELECT COUNT(*) FROM "${t}"`)).rows[0]?.[0] ?? 0);

    const dir = opts.backupDir ?? path.join(path.dirname(opts.dbFile), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `pre-rollback-0004-${stamp}.db`);
    fs.copyFileSync(opts.dbFile, backupPath);
    if (Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${opts.dbFile}-wal`))
      fs.copyFileSync(`${opts.dbFile}-wal`, `${backupPath}-wal`);
    await verifyBackup(backupPath, counts);

    await client.migrate(
      buildRollback0004Statements(folder, e4.when, {
        at: Date.now(),
        detail: {
          backup: path.basename(backupPath),
          planCode: opts.expectedCode,
          faz4Data: data,
          live: opts.live ?? false,
        },
      }),
    );
    const fk = await client.execute("PRAGMA foreign_key_check");
    if (fk.rows.length > 0)
      throw new RollbackError(
        `Geri alma sonrası ${fk.rows.length} yabancı anahtar ihlali. Yedek: ${backupPath}`,
      );
    return { backupPath, faz4Data: data };
  } finally {
    lock.release();
  }
}

export interface Execute0004Options {
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
export async function executeRollback0004(
  dbFile: string,
  opts: Execute0004Options,
): Promise<Rollback0004Result> {
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
  const plan = await planRollback0004(file, {
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
    return await rollbackFaz4(handle.client, {
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
