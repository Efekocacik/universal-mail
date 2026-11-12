import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { isBusyConnectionError, openDatabase } from "./client";
import { activeMaintenance, acquireMaintenance } from "./maintenance";

/**
 * Migrasyon 0003'ün (ARF `complaint` sınıfı, `campaign_leads.stop_reason`) KAYIPSIZ geri alınması (Aşama 15.10-1).
 * Yalnızca `scripts/rollback-0003.ts` ve testler kullanır; uygulamanın normal çalışma yolu (web, çalışan, Electron,
 * başlatıcılar) bu modülü ASLA içe aktarmaz (testle doğrulanır). Geri alındıktan sonra veritabanı 0002 şemasındadır ve
 * yalnızca bir önceki (15.10 öncesi) sürümle açılmalıdır.
 *
 * GÜVENLİK (yanlışlıkla gerçek veritabanında çalışmasın):
 * - Hedef AÇIKÇA verilir (`--db`); ortam değişkeni, `.env.local` veya varsayılan `.data` yolu hiç kullanılmaz.
 * - Varsayılan işlem yalnızca PLAN'dır: hiçbir veriyi değiştirmez; hedefe ve veritabanı durumuna bağlı tek kullanımlık
 *   bir doğrulama kodu üretir. Uygulama için kod gerekir; plan ile uygulama arasında veritabanı değişirse reddedilir.
 * - Hedef geçici dizinin (`os.tmpdir()`) dışındaysa (gerçek veri) ayrıca `allowLiveData` ve dosya adının yazılması gerekir.
 * - Yedek alınır, açılıp bütünlüğü ve satır sayıları doğrulanır; doğrulanmadan geri alma BAŞLAMAZ.
 * - Denetim kaydı, geri almanın aynı işleminde `audit_log` tablosuna yazılır (tablo 0002 şemasında da aynıdır; geri
 *   almayla etkilenmez): ya ikisi birlikte kalıcı olur ya da hiçbiri.
 *
 * Kayıpsızlık sözleşmesi:
 * - `messages.classification = 'complaint'` satırları eski CHECK'e uyması için `other` olur; anlam, çift yazılan
 *   `error_code` işaretinden (`arf_complaint` / `arf_complaint:<neden>`) korunur. İşaretsiz bir `complaint` satırı
 *   `arf_complaint` (doğrulanmış) olarak işaretlenir; doğrulanmamış olup olmadığı ayırt edilemez ve bu yönde kabul edilir.
 * - 15.10-2 (TB-10) sonrası `completed` dizi çıkış/şikâyette durumunu korur ve yalnızca `stop_reason` alır. Eski sürüm
 *   bu durumu `unsubscribed` olarak yazardı; geri almada `stop_reason` dolu ve `status <> 'unsubscribed'` olan diziler
 *   eski gösterime (`unsubscribed`) katlanır. NEDEN korunur (şikâyette işaretle), ama "önce tamamlandı" bilgisi
 *   KAYBOLUR: 0003 yeniden uygulanınca `stop_reason` geri dolar, dizi ise `unsubscribed` kalır (kalıcı; testli).
 * - `stop_reason = 'complaint'` ve `status = 'unsubscribed'` olan dizilere `exclusion_reasons` içinde `"arf_complaint"` eklenir.
 * - Tüm kimlikler, `sqlite_sequence`, indeksler ve `suppressions.message_id` bağlantıları korunur; bekçiler (satır sayısı,
 *   kimlik toplamı, yabancı anahtar) başarısız olursa işlemin tamamı geri alınır.
 * - 0003 kaydı `__drizzle_migrations` tablosundan silinir (yeniden yükseltme 0003'ü yeniden uygular).
 */

export class RollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackError";
  }
}

export interface RollbackResult {
  backupPath: string;
  complaintMessagesDowngraded: number;
  complaintSequencesMarked: number;
  /** Durumu korunup nedeni kaydedilmiş (TB-10) ve eski gösterime (`unsubscribed`) katlanan diziler. */
  stoppedAfterCompletionFolded: number;
}

const BAD = "abs(-9223372036854775808)";
const guard = (cond: string) => `SELECT CASE WHEN ${cond} THEN ${BAD} END`;
const TAG_0003 = "0003_faz3_arf_complaint";
export const AUDIT_ACTION = "db.rollback_0003";

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

function oldMessagesParts(folder: string, tag0002: string) {
  const src = fs.readFileSync(path.join(folder, `${tag0002}.sql`), "utf8").replace(/\r\n/g, "\n");
  const m = /CREATE TABLE `messages` \(.*?\n\);\n/s.exec(src);
  if (!m) throw new RollbackError("0002 geçişinde messages tablosu bulunamadı.");
  const ddl = m[0]
    .replace("CREATE TABLE `messages` (", "CREATE TABLE `__old_messages` (")
    .replace(/;\n$/, "");
  const idx = (
    src.match(/CREATE (?:UNIQUE )?INDEX `messages_[a-z_]+` ON `messages`[^\n]*?;/g) ?? []
  ).map((i) => i.replace(/;$/, ""));
  const cols = [...ddl.matchAll(/^\t`([a-z_]+)` /gm)].map((c) => `\`${c[1]}\``).join(", ");
  if (idx.length !== 9) throw new RollbackError("0002 geçişinde 9 messages indeksi bekleniyordu.");
  return { ddl, idx, cols };
}

export interface AuditDetail {
  backup: string;
  planCode: string;
  messages: number;
  complaintMessagesDowngraded: number;
  complaintSequencesMarked: number;
  stoppedAfterCompletionFolded: number;
  live: boolean;
}

export function buildRollbackStatements(
  folder: string,
  when0003: number,
  audit?: { at: number; detail: AuditDetail },
): InStatement[] {
  const e2 = readJournal(folder).find((e) => e.idx === 2);
  if (!e2) throw new RollbackError("0002 kaydı günlükte yok.");
  const { ddl, idx, cols } = oldMessagesParts(folder, e2.tag);
  const g = (k: string) => `(SELECT \`v\` FROM \`__um_0003\` WHERE \`k\` = '${k}')`;
  const seqNow = "COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'), 0)";
  const stmts: InStatement[] = [
    "CREATE TEMP TABLE `__um_0003` (`k` text PRIMARY KEY, `v` integer)",
    "INSERT INTO `__um_0003` VALUES ('messages', (SELECT COUNT(*) FROM `messages`)), ('campaign_leads', (SELECT COUNT(*) FROM `campaign_leads`)), ('sup_linked', (SELECT COUNT(`message_id`) FROM `suppressions`)), ('sup_sum', (SELECT COALESCE(SUM(`message_id`), 0) FROM `suppressions`)), ('msg_idsum', (SELECT COALESCE(SUM(`id`), 0) FROM `messages`)), ('seq', COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'), 0)), ('audit', (SELECT COUNT(*) FROM `audit_log`))",
    // Anlamı eski gösterimde koru (çift yazma işareti eksikse onar), sonra eski CHECK'e uydur.
    "UPDATE `messages` SET `error_code` = 'arf_complaint' WHERE `classification` = 'complaint' AND `error_code` IS NULL",
    // TB-10: nedeni kaydedilmiş bitmiş dizi, eski sürümde olduğu gibi `unsubscribed` olur (sütun düşmeden önce).
    "UPDATE `campaign_leads` SET `status` = 'unsubscribed' WHERE `stop_reason` IS NOT NULL AND `status` <> 'unsubscribed'",
    "UPDATE `campaign_leads` SET `exclusion_reasons` = CASE WHEN json_valid(`exclusion_reasons`) THEN json_insert(`exclusion_reasons`, '$[#]', 'arf_complaint') ELSE '[\"arf_complaint\"]' END WHERE `status` = 'unsubscribed' AND `stop_reason` = 'complaint' AND `exclusion_reasons` NOT LIKE '%\"arf_complaint\"%'",
    "UPDATE `messages` SET `classification` = 'other' WHERE `classification` = 'complaint'",
    ddl,
    `INSERT INTO \`__old_messages\` (${cols}) SELECT ${cols} FROM \`messages\``,
    guard("(SELECT COUNT(*) FROM `messages`) <> (SELECT COUNT(*) FROM `__old_messages`)"),
    "DELETE FROM `sqlite_sequence` WHERE `name` = '__old_messages'",
    "INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__old_messages', `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'",
    "DROP TABLE `messages`",
    "ALTER TABLE `__old_messages` RENAME TO `messages`",
    ...idx,
    "ALTER TABLE `campaign_leads` DROP COLUMN `stop_reason`",
    `DELETE FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${Math.trunc(when0003)}`,
  ];
  if (audit) {
    stmts.push({
      sql: "INSERT INTO `audit_log` (`at`, `action`, `entity`, `entity_id`, `detail`) VALUES (?, ?, 'database', NULL, ?)",
      args: [audit.at, AUDIT_ACTION, JSON.stringify(audit.detail)],
    });
  }
  stmts.push(
    guard(
      `(SELECT COUNT(*) FROM \`messages\`) <> ${g("messages")} OR (SELECT COUNT(*) FROM \`campaign_leads\`) <> ${g("campaign_leads")}`,
    ),
    guard(`(SELECT COALESCE(SUM(\`id\`), 0) FROM \`messages\`) <> ${g("msg_idsum")}`),
    guard(
      `(SELECT COUNT(\`message_id\`) FROM \`suppressions\`) <> ${g("sup_linked")} OR (SELECT COALESCE(SUM(\`message_id\`), 0) FROM \`suppressions\`) <> ${g("sup_sum")}`,
    ),
    guard(
      `${seqNow} < ${g("seq")} OR ${seqNow} < (SELECT COALESCE(MAX(\`id\`), 0) FROM \`messages\`)`,
    ),
    guard(
      "(SELECT COUNT(*) FROM `sqlite_master` WHERE `type` = 'index' AND `tbl_name` = 'messages' AND `name` LIKE 'messages\\_%' ESCAPE '\\') <> 9 OR (SELECT COUNT(*) FROM `sqlite_master` WHERE `name` = '__old_messages') <> 0",
    ),
    guard("(SELECT COUNT(*) FROM `__drizzle_migrations`) <> 3"),
    // Denetim kaydı: tam bir satır eklendi, mevcut kayıtlar silinmedi/değişmedi
    guard(`(SELECT COUNT(*) FROM \`audit_log\`) <> ${g("audit")} + ${audit ? 1 : 0}`),
    guard("EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    "DROP TABLE `__um_0003`",
  );
  return stmts;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan, parmak izi ve doğrulama kodu

/** Veritabanının içerik parmak izi: her tablo için satır sayısı ve en büyük rowid + birkaç özet. Salt okunur. */
export async function fingerprint(client: Client): Promise<Record<string, unknown>> {
  const fp: Record<string, unknown> = {};
  const tables = (
    await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows.map((r) => String(r.name));
  for (const t of tables) {
    const r = await client.execute(
      `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM "${t.replace(/"/g, '""')}"`,
    );
    fp[t] = [Number(r.rows[0]?.n ?? 0), Number(r.rows[0]?.m ?? 0)];
  }
  const one = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
  const groups = async (sql: string) =>
    (await client.execute(sql)).rows.map((r) => Object.values(r).map((v) => String(v)));
  // Güncellemeleri de yakalamak için: updated_at toplamı (sütunu olan her tablo) ve geri almayla ilgili tabloların
  // sütun dağılımları. (Bu özetleri koruyan nadir bir değişiklik tespit edilemez; çekirdek ayrıca kilit, yazıcı
  // yoklaması ve işlem içi bekçilerle korunur.)
  for (const t of tables) {
    const cols = (await client.execute(`PRAGMA table_info("${t.replace(/"/g, '""')}")`)).rows.map(
      (r) => String(r.name),
    );
    if (cols.includes("updated_at"))
      fp[`__updated_at:${t}`] = await one(`SELECT COALESCE(SUM(updated_at), 0) FROM "${t}"`);
  }
  fp.__campaign_leads = await groups(
    "SELECT status, COALESCE(stop_reason, '-'), COUNT(*), COALESCE(SUM(length(exclusion_reasons)), 0), COALESCE(SUM(attempts), 0) FROM campaign_leads GROUP BY 1, 2 ORDER BY 1, 2",
  );
  fp.__messages = await groups(
    "SELECT direction, status, COALESCE(classification, '-'), COUNT(*), COALESCE(SUM(length(COALESCE(error_code, ''))), 0) FROM messages GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
  );
  fp.__suppressions = await groups(
    "SELECT scope, reason, COUNT(*), COUNT(lifted_at), COALESCE(SUM(message_id), 0) FROM suppressions GROUP BY 1, 2 ORDER BY 1, 2",
  );
  fp.__schema_version = await one("PRAGMA schema_version");
  return fp;
}

const keyOf = (file: string): string => {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
};

function makeCode(file: string, fp: Record<string, unknown>, migrations: number[]): string {
  const h = crypto
    .createHash("sha256")
    .update(JSON.stringify({ v: 1, tag: TAG_0003, db: keyOf(file), fp, migrations }))
    .digest("hex");
  return `RB3-${h.slice(0, 16).toUpperCase()}`;
}

/** Hedef geçici dizinde değilse (gerçek veri) true. `tempRoots` yalnızca testler içindir. */
export function isLiveTarget(file: string, tempRoots?: string[]): boolean {
  const roots = (
    tempRoots ?? [os.tmpdir(), process.env.TMPDIR].filter((x): x is string => !!x)
  ).map((r) => {
    try {
      return fs.realpathSync.native(r);
    } catch {
      return path.resolve(r);
    }
  });
  const real = fs.realpathSync.native(file);
  const norm = (p: string) =>
    (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p) +
    path.sep;
  return !roots.some((r) => norm(real).startsWith(norm(r)));
}

export interface RollbackPlan {
  dbFile: string;
  live: boolean;
  sizeBytes: number;
  appliedMigrations: number;
  lastIsFaz3: boolean;
  counts: {
    messages: number;
    campaignLeads: number;
    complaintMessages: number;
    complaintSequences: number;
    /** `stop_reason` dolu ama `unsubscribed` olmayan (TB-10) diziler; eski gösterime katlanır. */
    stoppedAfterCompletion: number;
  };
  /** Uygulama için gereken tek kullanımlık doğrulama kodu (hedefe ve veritabanı durumuna bağlı). */
  code: string;
  blockers: string[];
  /** Uygulama için ayrıca gerekenler (gerçek veri için). */
  requirements: string[];
}

function openReadOnly(file: string): Client {
  if (!fs.existsSync(file))
    throw new RollbackError("Veritabanı dosyası bulunamadı (oluşturulmaz).");
  if (!fs.statSync(file).isFile()) throw new RollbackError("Hedef bir dosya değil.");
  return createClient({ url: toLibsqlUrl(file) });
}

/**
 * Geri alma PLANI: hiçbir veriyi değiştirmez (yalnızca SELECT/PRAGMA okuma; yedek, kilit veya dosya oluşturmaz).
 * Hedef dosya yoksa oluşturulmaz.
 */
export async function planRollback(
  dbFile: string,
  opts: { migrationsFolder?: string; tempRoots?: string[] } = {},
): Promise<RollbackPlan> {
  const file = path.resolve(dbFile);
  const client = openReadOnly(file);
  try {
    const folder = opts.migrationsFolder ?? migrationsDir();
    const e3 = readJournal(folder).find((e) => e.tag === TAG_0003);
    if (!e3) throw new RollbackError("Bu sürümde 0003 geçişi yok.");
    const blockers: string[] = [];
    let times: number[] = [];
    try {
      times = (
        await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      ).rows.map((r) => Number(r.created_at));
    } catch {
      blockers.push("Bu dosya bir Universal Mail veritabanı değil (migrasyon tablosu yok).");
    }
    const lastIsFaz3 = times.length === 4 && times[3] === e3.when;
    if (!blockers.length && !lastIsFaz3)
      blockers.push(
        "Geri alma yalnızca 0003'ün SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 4 kayıt, sonuncusu 0003).",
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
    let counts = {
      messages: 0,
      campaignLeads: 0,
      complaintMessages: 0,
      complaintSequences: 0,
      stoppedAfterCompletion: 0,
    };
    if (!blockers.length) {
      fp = await fingerprint(client);
      const one = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
      counts = {
        messages: await one("SELECT COUNT(*) FROM messages"),
        campaignLeads: await one("SELECT COUNT(*) FROM campaign_leads"),
        complaintMessages: await one(
          "SELECT COUNT(*) FROM messages WHERE classification = 'complaint'",
        ),
        complaintSequences: await one(
          "SELECT COUNT(*) FROM campaign_leads WHERE stop_reason = 'complaint'",
        ),
        stoppedAfterCompletion: await one(
          "SELECT COUNT(*) FROM campaign_leads WHERE stop_reason IS NOT NULL AND status <> 'unsubscribed'",
        ),
      };
    }
    return {
      dbFile: file,
      live,
      sizeBytes: fs.statSync(file).size,
      appliedMigrations: times.length,
      lastIsFaz3,
      counts,
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

async function verifyBackup(
  backupPath: string,
  expected: { messages: number; campaignLeads: number; suppressions: number },
): Promise<void> {
  const b = createClient({ url: toLibsqlUrl(backupPath) });
  try {
    const q = Number((await b.execute("PRAGMA quick_check")).rows[0]?.[0] === "ok" ? 1 : 0);
    if (q !== 1) throw new RollbackError("Yedek bütünlük denetiminden (quick_check) geçemedi.");
    const n = async (sql: string) => Number((await b.execute(sql)).rows[0]?.[0] ?? -1);
    if (
      (await n("SELECT COUNT(*) FROM messages")) !== expected.messages ||
      (await n("SELECT COUNT(*) FROM campaign_leads")) !== expected.campaignLeads ||
      (await n("SELECT COUNT(*) FROM suppressions")) !== expected.suppressions
    )
      throw new RollbackError("Yedekteki satır sayıları kaynak veritabanıyla uyuşmuyor.");
  } catch (e) {
    if (e instanceof RollbackError) throw e;
    throw new RollbackError(`Yedek açılamadı veya okunamadı: ${(e as Error).message}`);
  } finally {
    b.close();
  }
}

/**
 * Çekirdek: kilit al, başka yazıcı yok, parmak izi doğrula, yedekle ve DOĞRULA, sonra geri al + denetim kaydı yaz.
 * `expectedCode` ve `planCodeForAudit` zorunludur; kod plana bağlı olmadan çağrılamaz.
 */
export async function rollbackFaz3ArfComplaint(
  client: Client,
  opts: {
    dbFile: string;
    expectedCode: string;
    migrationsFolder?: string;
    backupDir?: string;
    live?: boolean;
  },
): Promise<RollbackResult> {
  const folder = opts.migrationsFolder ?? migrationsDir();
  const e3 = readJournal(folder).find((e) => e.tag === TAG_0003);
  if (!e3) throw new RollbackError("Bu sürümde 0003 geçişi yok.");
  if (!fs.existsSync(opts.dbFile)) throw new RollbackError("Veritabanı dosyası bulunamadı.");
  if (!opts.expectedCode) throw new RollbackError("Doğrulama kodu gerekli.");

  const lock = await acquireMaintenance(opts.dbFile, "rollback-0003", 30_000);
  try {
    // Başka bir yazıcı varsa başlama (geri alma da messages tablosunu yeniden oluşturur).
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

    // Kilit ve yazıcı yoklamasından SONRA, yedekten ÖNCE: plan ile şimdiki durum aynı mı?
    const times = (
      await client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
    ).rows.map((r) => Number(r.created_at));
    if (times.length !== 4 || times[3] !== e3.when)
      throw new RollbackError(
        "Geri alma yalnızca 0003'ün SON uygulanan geçiş olduğu veritabanında yapılabilir (beklenen: 4 kayıt, sonuncusu 0003).",
      );
    const fp = await fingerprint(client);
    if (makeCode(opts.dbFile, fp, times) !== opts.expectedCode)
      throw new RollbackError(
        "Doğrulama kodu uyuşmuyor: plan çıkarıldıktan sonra veritabanı değişti veya kod başka bir hedefe/duruma ait. " +
          "Hiçbir değişiklik yapılmadı; planı yeniden çıkarın.",
      );

    const count = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
    const counts = {
      messages: await count("SELECT COUNT(*) FROM messages"),
      campaignLeads: await count("SELECT COUNT(*) FROM campaign_leads"),
      suppressions: await count("SELECT COUNT(*) FROM suppressions"),
    };
    const complaintMessagesDowngraded = await count(
      "SELECT COUNT(*) FROM messages WHERE classification = 'complaint'",
    );
    const complaintSequencesMarked = await count(
      "SELECT COUNT(*) FROM campaign_leads WHERE stop_reason = 'complaint'",
    );
    const stoppedAfterCompletionFolded = await count(
      "SELECT COUNT(*) FROM campaign_leads WHERE stop_reason IS NOT NULL AND status <> 'unsubscribed'",
    );

    // Yedek: al, aç, bütünlüğünü ve sayıları doğrula. Doğrulanamazsa geri alma BAŞLAMAZ.
    const dir = opts.backupDir ?? path.join(path.dirname(opts.dbFile), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `pre-rollback-${stamp}.db`);
    fs.copyFileSync(opts.dbFile, backupPath);
    if (Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${opts.dbFile}-wal`))
      fs.copyFileSync(`${opts.dbFile}-wal`, `${backupPath}-wal`);
    await verifyBackup(backupPath, counts);

    await client.migrate(
      buildRollbackStatements(folder, e3.when, {
        at: Date.now(),
        detail: {
          backup: path.basename(backupPath),
          planCode: opts.expectedCode,
          messages: counts.messages,
          complaintMessagesDowngraded,
          complaintSequencesMarked,
          stoppedAfterCompletionFolded,
          live: opts.live ?? false,
        },
      }),
    );
    const fk = await client.execute("PRAGMA foreign_key_check");
    if (fk.rows.length > 0)
      throw new RollbackError(
        `Geri alma sonrası ${fk.rows.length} yabancı anahtar ihlali. Yedek: ${backupPath}`,
      );
    return {
      backupPath,
      complaintMessagesDowngraded,
      complaintSequencesMarked,
      stoppedAfterCompletionFolded,
    };
  } finally {
    lock.release();
  }
}

export interface ExecuteOptions {
  confirmCode: string;
  allowLiveData?: boolean;
  typedDbName?: string;
  migrationsFolder?: string;
  backupDir?: string;
  /** Yalnızca testler: geçici dizin kökleri (gerçek veri denetimini simüle etmek için). */
  tempRoots?: string[];
}

/** Korumalı uygulama: gerçek veri izinleri → plan kodu → çekirdek. Hedef ortamdan veya varsayılandan SEÇİLMEZ. */
export async function executeRollback(
  dbFile: string,
  opts: ExecuteOptions,
): Promise<RollbackResult> {
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
  const plan = await planRollback(file, {
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
    return await rollbackFaz3ArfComplaint(handle.client, {
      dbFile: file,
      expectedCode: opts.confirmCode,
      migrationsFolder: opts.migrationsFolder,
      backupDir: opts.backupDir,
      live,
    });
  } finally {
    handle.client.close();
  }
}
