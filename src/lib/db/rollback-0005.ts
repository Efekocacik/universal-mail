import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { isBusyConnectionError, openDatabase } from "./client";
import { activeMaintenance, acquireMaintenance } from "./maintenance";
import { fingerprint, isLiveTarget, RollbackError } from "./rollback-0003";

/**
 * Migrasyon 0005'in (Faz 5 P0 temeli) geri alınması. Yalnızca `scripts/rollback-0005.ts` ve testler kullanır; uygulamanın
 * normal çalışma yolu (web, çalışan, Electron, başlatıcılar) bu modülü ASLA içe aktarmaz (testle doğrulanır). Geri
 * alındıktan sonra veritabanı 0004 şemasındadır ve yalnızca Faz 5 öncesi sürümle açılmalıdır.
 *
 * GÜVENLİK, 0004 geri almasıyla aynı iki aşamalı kalıptır: hedef açıkça verilir (`--db`), varsayılan işlem yalnızca
 * PLAN'dır, uygulama plana ve veritabanı durumuna bağlı tek kullanımlık kod ister, gerçek veride (geçici dizin dışı)
 * ayrıca `allowLiveData` + dosya adı istenir, yedek alınıp DOĞRULANMADAN geri alma başlamaz ve denetim kaydı aynı işlemde
 * yazılır.
 *
 * VERİ SÖZLEŞMESİ (geri alma KAYIPLIDIR ve bu açıkça onaylanır):
 * - Faz 5'in yeni tabloları (`registry_runs`, `registry_companies`, `import_batches`, `import_batch_leads`, `lead_intros`,
 *   `campaign_step_templates`, `message_opens`) ve yeni sütunları (`leads.website`, `templates.subject_b`,
 *   `templates.info_only`, `messages.subject_variant`) silinir. Veri varsa plan sayıları gösterir ve uygulama
 *   `acceptDataLoss` olmadan REDDEDİLİR. Tam geri dönüş için `pre-rollback-0005-*` yedeği kullanılır.
 * - İçe aktarma veya sicilden oluşturulmuş lead'ler (`leads.source IN ('registry','import')`) KALIR; yalnızca web siteleri
 *   ve parti bağlantıları kaybolur. "Yalnızca bilgi" (info_only) şablonlar sıradan şablon olarak kalır; DE gönderimi ülke
 *   politikası (`blocked`) ile yine engellidir.
 * - Yeni sütunların yalnızca kendi CHECK'leri vardır (indeks/FK yok): `DROP COLUMN` yeterlidir, tablo yeniden KURULMAZ.
 *   Faz 5 öncesi her satır, kimlik, `sqlite_sequence` ve 0004 indeksleri korunur.
 * - Bekçiler (satır sayıları, tablo/indeks kümesi, migrasyon sayısı, denetim, yabancı anahtar) başarısız olursa işlemin
 *   tamamı geri alınır. 0005 kaydı `__drizzle_migrations` tablosundan silinir (yeniden yükseltme 0005'i yeniden uygular).
 */

const BAD = "abs(-9223372036854775808)";
const guard = (cond: string) => `SELECT CASE WHEN ${cond} THEN ${BAD} END`;
const TAG_0005 = "0005_faz5";
export const AUDIT_ACTION_0005 = "db.rollback_0005";

/** 0005'in eklediği tablolar (bağımlılık sırasıyla silinir). */
export const FAZ5_TABLES = [
  "message_opens",
  "campaign_step_templates",
  "lead_intros",
  "import_batch_leads",
  "import_batches",
  "registry_companies",
  "registry_runs",
] as const;

/** `DROP COLUMN` ile kaldırılan sütunlar (yalnızca kendi CHECK'leri var; indeks/FK yok). */
export const FAZ5_COLUMNS: readonly [table: string, column: string][] = [
  ["leads", "website"],
  ["templates", "subject_b"],
  ["templates", "info_only"],
  ["messages", "subject_variant"],
];

/** Korunan Faz 5 öncesi tablolar: satır sayısı geri almadan önce ve sonra aynı olmalı. */
const KEPT_TABLES = [
  "leads",
  "templates",
  "messages",
  "campaigns",
  "campaign_steps",
  "places",
  "campaign_leads",
];

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

export interface AuditDetail0005 {
  backup: string;
  planCode: string;
  faz5Data: Faz5DataCounts;
  keptLeads: number;
  live: boolean;
}

export function buildRollback0005Statements(
  when0005: number,
  audit?: { at: number; detail: AuditDetail0005 },
): InStatement[] {
  const g = (k: string) => `(SELECT \`v\` FROM \`__um_0005\` WHERE \`k\` = '${k}')`;
  const counts = KEPT_TABLES.map((t) => `('${t}', (SELECT COUNT(*) FROM \`${t}\`))`).join(", ");
  const stmts: InStatement[] = [
    "CREATE TEMP TABLE `__um_0005` (`k` text PRIMARY KEY, `v` integer)",
    `INSERT INTO \`__um_0005\` VALUES ${counts}, ('lead_idsum', (SELECT COALESCE(SUM(\`id\`), 0) FROM \`leads\`)), ('audit', (SELECT COUNT(*) FROM \`audit_log\`))`,
    ...FAZ5_TABLES.map((t) => `DROP TABLE IF EXISTS \`${t}\``),
    ...FAZ5_COLUMNS.map(([t, c]) => `ALTER TABLE \`${t}\` DROP COLUMN \`${c}\``),
    `DELETE FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${Math.trunc(when0005)}`,
  ];
  if (audit) {
    stmts.push({
      sql: "INSERT INTO `audit_log` (`at`, `action`, `entity`, `entity_id`, `detail`) VALUES (?, ?, 'database', NULL, ?)",
      args: [audit.at, AUDIT_ACTION_0005, JSON.stringify(audit.detail)],
    });
  }
  const cols = FAZ5_COLUMNS.map(
    ([t, c]) => `(SELECT COUNT(*) FROM pragma_table_info('${t}') WHERE \`name\` = '${c}')`,
  ).join(" + ");
  stmts.push(
    ...KEPT_TABLES.map((t) => guard(`(SELECT COUNT(*) FROM \`${t}\`) <> ${g(t)}`)),
    guard(`(SELECT COALESCE(SUM(\`id\`), 0) FROM \`leads\`) <> ${g("lead_idsum")}`),
    guard(
      `(SELECT COUNT(*) FROM \`sqlite_master\` WHERE \`tbl_name\` IN (${FAZ5_TABLES.map((n) => `'${n}'`).join(", ")})) <> 0`,
    ),
    guard(`${cols} <> 0`),
    guard("(SELECT COUNT(*) FROM `__drizzle_migrations`) <> 5"),
    guard(`(SELECT COUNT(*) FROM \`audit_log\`) <> ${g("audit")} + ${audit ? 1 : 0}`),
    guard("EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    "DROP TABLE `__um_0005`",
  );
  return stmts;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

/** Geri almayla kaybolacak Faz 5 verisi (satır sayıları). Hepsi 0 ise geri alma kayıpsızdır. */
export interface Faz5DataCounts {
  registryRuns: number;
  registryCompanies: number;
  importBatches: number;
  importBatchLeads: number;
  leadIntros: number;
  campaignStepTemplates: number;
  messageOpens: number;
  leadsWithWebsite: number;
  templatesWithSubjectB: number;
  templatesInfoOnly: number;
  messagesWithSubjectVariant: number;
}

async function faz5Data(client: Client): Promise<Faz5DataCounts> {
  const one = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
  return {
    registryRuns: await one("SELECT COUNT(*) FROM registry_runs"),
    registryCompanies: await one("SELECT COUNT(*) FROM registry_companies"),
    importBatches: await one("SELECT COUNT(*) FROM import_batches"),
    importBatchLeads: await one("SELECT COUNT(*) FROM import_batch_leads"),
    leadIntros: await one("SELECT COUNT(*) FROM lead_intros"),
    campaignStepTemplates: await one("SELECT COUNT(*) FROM campaign_step_templates"),
    messageOpens: await one("SELECT COUNT(*) FROM message_opens"),
    leadsWithWebsite: await one("SELECT COUNT(*) FROM leads WHERE website IS NOT NULL"),
    templatesWithSubjectB: await one("SELECT COUNT(*) FROM templates WHERE subject_b IS NOT NULL"),
    templatesInfoOnly: await one("SELECT COUNT(*) FROM templates WHERE info_only = 1"),
    messagesWithSubjectVariant: await one(
      "SELECT COUNT(*) FROM messages WHERE subject_variant IS NOT NULL",
    ),
  };
}

/** Geri almadan sonra KALAN (silinmeyen) Faz 5 kaynaklı lead'ler: içe aktarma ve sicil. */
async function keptFaz5Leads(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT COUNT(*) FROM leads WHERE source IN ('registry', 'import')"))
      .rows[0]?.[0] ?? 0,
  );
}

const EMPTY_COUNTS: Faz5DataCounts = {
  registryRuns: 0,
  registryCompanies: 0,
  importBatches: 0,
  importBatchLeads: 0,
  leadIntros: 0,
  campaignStepTemplates: 0,
  messageOpens: 0,
  leadsWithWebsite: 0,
  templatesWithSubjectB: 0,
  templatesInfoOnly: 0,
  messagesWithSubjectVariant: 0,
};

export const hasFaz5Data = (c: Faz5DataCounts) => Object.values(c).some((n) => n > 0);

const keyOf = (file: string): string => {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
};

function makeCode(file: string, fp: Record<string, unknown>, migrations: number[]): string {
  const h = crypto
    .createHash("sha256")
    .update(JSON.stringify({ v: 1, tag: TAG_0005, db: keyOf(file), fp, migrations }))
    .digest("hex");
  return `RB5-${h.slice(0, 16).toUpperCase()}`;
}

export interface Rollback0005Plan {
  dbFile: string;
  live: boolean;
  sizeBytes: number;
  appliedMigrations: number;
  lastIsFaz5: boolean;
  /** Geri almayla kaybolacak Faz 5 verisi. */
  faz5Data: Faz5DataCounts;
  /** Geri almadan sonra KALAN içe aktarma/sicil lead'leri (web siteleri ve parti bağlantıları kaybolur). */
  keptLeads: number;
  code: string;
  blockers: string[];
  requirements: string[];
  notes: string[];
}

const LAST_ONLY =
  "Geri alma yalnızca 0005'in SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 6 kayıt, sonuncusu 0005).";

function openReadOnly(file: string): Client {
  if (!fs.existsSync(file))
    throw new RollbackError("Veritabanı dosyası bulunamadı (oluşturulmaz).");
  if (!fs.statSync(file).isFile()) throw new RollbackError("Hedef bir dosya değil.");
  return createClient({ url: toLibsqlUrl(file) });
}

/** Geri alma PLANI: hiçbir veriyi değiştirmez (yalnızca okuma; yedek, kilit veya dosya oluşturmaz). */
export async function planRollback0005(
  dbFile: string,
  opts: { migrationsFolder?: string; tempRoots?: string[] } = {},
): Promise<Rollback0005Plan> {
  const file = path.resolve(dbFile);
  const client = openReadOnly(file);
  try {
    const folder = opts.migrationsFolder ?? migrationsDir();
    const e5 = readJournal(folder).find((e) => e.tag === TAG_0005);
    if (!e5) throw new RollbackError("Bu sürümde 0005 geçişi yok.");
    const blockers: string[] = [];
    let times: number[] = [];
    try {
      times = (
        await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      ).rows.map((r) => Number(r.created_at));
    } catch {
      blockers.push("Bu dosya bir Universal Mail veritabanı değil (migrasyon tablosu yok).");
    }
    const lastIsFaz5 = times.length === 6 && times[5] === e5.when;
    if (!blockers.length && !lastIsFaz5) blockers.push(LAST_ONLY);
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
    let data = EMPTY_COUNTS;
    let kept = 0;
    if (!blockers.length) {
      fp = await fingerprint(client);
      data = await faz5Data(client);
      kept = await keptFaz5Leads(client);
      if (hasFaz5Data(data))
        requirements.push(
          "Faz 5 verisi var ve geri almayla SİLİNECEK (yedekte kalır): --accept-data-loss gerekir.",
        );
      if (kept > 0)
        notes.push(
          `İçe aktarma/sicil kaynaklı ${kept} lead KALIR; yalnızca web siteleri ve parti bağlantıları kaybolur.`,
        );
      if (data.templatesInfoOnly > 0)
        notes.push(
          `${data.templatesInfoOnly} "yalnızca bilgi" şablonu sıradan şablon olur; DE gönderimi ülke politikasıyla yine engellidir.`,
        );
    }
    return {
      dbFile: file,
      live,
      sizeBytes: fs.statSync(file).size,
      appliedMigrations: times.length,
      lastIsFaz5,
      faz5Data: data,
      keptLeads: kept,
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

export interface Rollback0005Result {
  backupPath: string;
  faz5Data: Faz5DataCounts;
  keptLeads: number;
}

/** Çekirdek: kilit, yazıcı yoklaması, parmak izi = kod, yedek + doğrulama, sonra işlem içinde geri alma + denetim. */
export async function rollbackFaz5(
  client: Client,
  opts: {
    dbFile: string;
    expectedCode: string;
    acceptDataLoss?: boolean;
    migrationsFolder?: string;
    backupDir?: string;
    live?: boolean;
  },
): Promise<Rollback0005Result> {
  const folder = opts.migrationsFolder ?? migrationsDir();
  const e5 = readJournal(folder).find((e) => e.tag === TAG_0005);
  if (!e5) throw new RollbackError("Bu sürümde 0005 geçişi yok.");
  if (!fs.existsSync(opts.dbFile)) throw new RollbackError("Veritabanı dosyası bulunamadı.");
  if (!opts.expectedCode) throw new RollbackError("Doğrulama kodu gerekli.");

  const lock = await acquireMaintenance(opts.dbFile, "rollback-0005", 30_000);
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
    if (times.length !== 6 || times[5] !== e5.when) throw new RollbackError(LAST_ONLY);
    const fp = await fingerprint(client);
    if (makeCode(opts.dbFile, fp, times) !== opts.expectedCode)
      throw new RollbackError(
        "Doğrulama kodu uyuşmuyor: plan çıkarıldıktan sonra veritabanı değişti veya kod başka bir hedefe/duruma ait. " +
          "Hiçbir değişiklik yapılmadı; planı yeniden çıkarın.",
      );
    const data = await faz5Data(client);
    const kept = await keptFaz5Leads(client);
    if (hasFaz5Data(data) && !opts.acceptDataLoss)
      throw new RollbackError(
        "Faz 5 verisi var ve geri almayla silinir. Hiçbir değişiklik yapılmadı: açık onay için --accept-data-loss gerekir.",
      );

    const counts: Record<string, number> = {};
    for (const t of [...KEPT_TABLES, ...FAZ5_TABLES])
      counts[t] = Number((await client.execute(`SELECT COUNT(*) FROM "${t}"`)).rows[0]?.[0] ?? 0);

    const dir = opts.backupDir ?? path.join(path.dirname(opts.dbFile), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `pre-rollback-0005-${stamp}.db`);
    fs.copyFileSync(opts.dbFile, backupPath);
    if (Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${opts.dbFile}-wal`))
      fs.copyFileSync(`${opts.dbFile}-wal`, `${backupPath}-wal`);
    await verifyBackup(backupPath, counts);

    await client.migrate(
      buildRollback0005Statements(e5.when, {
        at: Date.now(),
        detail: {
          backup: path.basename(backupPath),
          planCode: opts.expectedCode,
          faz5Data: data,
          keptLeads: kept,
          live: opts.live ?? false,
        },
      }),
    );
    const fk = await client.execute("PRAGMA foreign_key_check");
    if (fk.rows.length > 0)
      throw new RollbackError(
        `Geri alma sonrası ${fk.rows.length} yabancı anahtar ihlali. Yedek: ${backupPath}`,
      );
    return { backupPath, faz5Data: data, keptLeads: kept };
  } finally {
    lock.release();
  }
}

export interface Execute0005Options {
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
export async function executeRollback0005(
  dbFile: string,
  opts: Execute0005Options,
): Promise<Rollback0005Result> {
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
  const plan = await planRollback0005(file, {
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
    return await rollbackFaz5(handle.client, {
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
