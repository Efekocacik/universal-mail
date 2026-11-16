import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { createClient } from "@libsql/client";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { APP_VERSION } from "@/lib/app/version";
import { backupsDir, dataDir, dbPath, migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { PRE_MIGRATE_RE } from "@/lib/db/migrate";
import { backups, type BackupKind } from "@/lib/db/schema";
import { WORK_DIR } from "@/lib/lifecycle/pending";
import { BACKUP_PASSPHRASE_SECRET, getSecret, setSecret } from "@/lib/secrets/store";
import { getSettings, setSetting, type SettingValue } from "@/lib/settings";
import { errorMessage } from "@/lib/util";
import { LifecycleError, type LifecycleErrorCode } from "./errors";
import { DEFAULT_LOG2N, LOG2N_MAX, LOG2N_MIN, writeEncryptedBackup } from "./format";
import { checkNewPassphrase, lifecycleError } from "./passphrase";
import { exportSecrets } from "./secrets-io";
import { BACKUP_EXTENSION, hasBackupPassphrase, type BackupRow } from "./shared";

/**
 * Faz 6 (paket Y.2): şifreli yedek servisi (API ve işçi ortak kullanır).
 *
 * Akış: `running` satırı ÖNCE eklenir (tekil kısmi indeks süreçler arasında tek yedeği garanti eder; çakışma
 * `BACKUP_IN_PROGRESS`) → ayrı bir libsql bağlantısında `VACUUM INTO` (yalnızca ana şema; Google oturum önbelleği
 * yapı gereği dışarıda) → gzip + AES-GCM ile `.part` dosyası → fsync → yeniden adlandırma → satır `ok` → döndürme.
 * Hata: satır `failed` + kod, `.part` ve düz anlık görüntü silinir. Dosya yolu YALNIZCA satırdan (klasör + doğrulanmış
 * ad) kurulur; istek girdisi yol üretmez.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Bu süreden eski `running` satırı yarıda kalmış sayılır (`failed/INTERRUPTED`). */
export const STALE_RUNNING_MS = 30 * MINUTE;
/** Başarısız satırlar bu kadar tutulur. */
export const FAILED_KEEP_MS = 30 * DAY;
export const BACKUP_FILE_NAME_RE =
  /^universal-mail-\d{8}-\d{6}-(manual|startup|weekly)(-\d{1,3})?\.umbk$/;

export class BackupNotFoundError extends Error {
  constructor() {
    super("Yedek bulunamadı.");
    this.name = "BackupNotFoundError";
  }
}

export interface BackupDeps {
  /** Şifreli dosyanın yazıcısı (test: disk dolu benzetimi). Varsayılan: `wx` + 0600 dosya akışı. */
  createWriter?: (file: string) => Writable;
  /** scrypt maliyeti (log2 N). Varsayılan 17; testlerde düşürülür. */
  log2N?: number;
}

/** Test ortamında (`NODE_ENV=test`) `UM_BACKUP_KDF_LOG2N` ile düşük maliyet; üretimde yok sayılır. */
export function effectiveLog2N(deps: BackupDeps = {}): number {
  if (deps.log2N !== undefined) return deps.log2N;
  const env = Number(process.env.UM_BACKUP_KDF_LOG2N);
  if (
    process.env.NODE_ENV === "test" &&
    Number.isInteger(env) &&
    env >= LOG2N_MIN &&
    env <= LOG2N_MAX
  )
    return env;
  return DEFAULT_LOG2N;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `universal-mail-YYYYMMDD-HHmmss-<tür>` (yerel saat). */
export function backupBaseName(kind: BackupKind, now: number): string {
  const d = new Date(now);
  return `universal-mail-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${kind}`;
}

type BackupDbRow = typeof backups.$inferSelect;

/** Satırın dosya yolu; ad deseni veya klasör geçersizse null (yol asla istekten kurulmaz). */
export function backupFilePath(row: Pick<BackupDbRow, "folder" | "fileName">): string | null {
  if (!BACKUP_FILE_NAME_RE.test(row.fileName) || !path.isAbsolute(row.folder)) return null;
  const file = path.join(row.folder, row.fileName);
  return path.dirname(file) === path.resolve(row.folder) ? file : null;
}

function toBackupRow(r: BackupDbRow): BackupRow {
  const file = backupFilePath(r);
  let exists = false;
  if (file && r.status === "ok") {
    try {
      exists = fs.statSync(file).isFile();
    } catch {
      exists = false;
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    fileName: r.fileName,
    folder: r.folder,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    appVersion: r.appVersion,
    schemaMigrations: r.schemaMigrations,
    includesSecrets: r.includesSecrets,
    errorCode: r.errorCode,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    fileExists: exists,
  };
}

/* ------------------------------------------------------------ klasör ------------------------------------------------------------ */

const isInside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Uygulama paketi/kaynakları (yedek klasörü olamaz). */
function forbiddenRoots(): string[] {
  const roots = [path.dirname(path.resolve(migrationsDir()))];
  const res = (process as { resourcesPath?: string }).resourcesPath;
  if (res) roots.push(path.resolve(res));
  return roots.flatMap((r) => {
    try {
      return [r, fs.realpathSync(r)];
    } catch {
      return [r];
    }
  });
}

/**
 * Özel yedek klasörünü doğrular ve gerçek yolunu döndürür: mutlak, var, klasör, ≤1024, uygulama paketi dışında
 * (`BACKUP_FOLDER_INVALID`) ve yazılabilir (yaz-sil denemesi; `BACKUP_FOLDER_UNWRITABLE`).
 */
export function validateBackupFolder(input: string): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 1024 ||
    input.includes("\0") ||
    !path.isAbsolute(input)
  )
    throw lifecycleError("BACKUP_FOLDER_INVALID");
  let real: string;
  try {
    real = fs.realpathSync(input);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw lifecycleError("BACKUP_FOLDER_INVALID");
  }
  if (real.length > 1024 || forbiddenRoots().some((root) => isInside(root, real)))
    throw lifecycleError("BACKUP_FOLDER_INVALID");
  const probe = path.join(real, `.um-write-probe-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
  } catch {
    throw lifecycleError("BACKUP_FOLDER_UNWRITABLE");
  } finally {
    fs.rmSync(probe, { force: true });
  }
  return real;
}

/** Yedeklerin yazılacağı klasör; varsayılansa oluşturulur. Özel klasör yoksa `BACKUP_FOLDER_UNWRITABLE`. */
export function resolveBackupFolder(folderSetting: string | null): string {
  if (folderSetting === null) return backupsDir();
  try {
    if (fs.statSync(folderSetting).isDirectory()) return folderSetting;
  } catch {
    /* aşağıda */
  }
  throw lifecycleError("BACKUP_FOLDER_UNWRITABLE");
}

/* ------------------------------------------------------------ oluşturma ------------------------------------------------------------ */

/** Hata → kararlı kod (iç ayrıntı istemciye sızmaz). */
export function classifyBackupError(e: unknown): LifecycleErrorCode {
  if (e instanceof LifecycleError) return e.code;
  const code = (e as NodeJS.ErrnoException)?.code;
  const text = `${String(code ?? "")} ${errorMessage(e)}`;
  if (/ENOSPC|SQLITE_FULL|database or disk is full/i.test(text)) return "BACKUP_DISK_FULL";
  if (/EACCES|EPERM|EROFS/.test(text)) return "BACKUP_FOLDER_UNWRITABLE";
  return "BACKUP_FAILED";
}

const causeText = (e: unknown): string => {
  let out = "";
  let cur: unknown = e;
  for (let i = 0; cur && i < 5; i++) {
    out += ` ${errorMessage(cur)}`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
};

/** 30 dakikadan eski `running` satırlarını `failed/INTERRUPTED` yapar. */
export async function recoverStaleRunning(db: DbExecutor, now: number): Promise<number> {
  const rows = await db
    .update(backups)
    .set({ status: "failed", errorCode: "INTERRUPTED", finishedAt: now })
    .where(and(eq(backups.status, "running"), lt(backups.createdAt, now - STALE_RUNNING_MS)))
    .returning({ id: backups.id });
  return rows.length;
}

async function reserveRow(
  db: Db,
  v: { kind: BackupKind; folder: string; includesSecrets: boolean; now: number },
): Promise<{ id: number; fileName: string }> {
  const base = backupBaseName(v.kind, v.now);
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = new Set(
      (
        await db
          .select({ name: backups.fileName })
          .from(backups)
          .where(sql`${backups.fileName} LIKE ${`${base}%`}`)
      ).map((r) => r.name),
    );
    let fileName = "";
    for (let i = 1; i < 1000 && !fileName; i++) {
      const name = `${base}${i === 1 ? "" : `-${i}`}${BACKUP_EXTENSION}`;
      if (!taken.has(name) && !fs.existsSync(path.join(v.folder, name))) fileName = name;
    }
    if (!fileName) throw lifecycleError("BACKUP_FAILED");
    try {
      const rows = await db
        .insert(backups)
        .values({
          kind: v.kind,
          status: "running",
          fileName,
          folder: v.folder,
          appVersion: APP_VERSION.slice(0, 40) || "0",
          schemaMigrations: 0,
          includesSecrets: v.includesSecrets,
          createdAt: v.now,
        })
        .returning({ id: backups.id });
      return { id: rows[0]!.id, fileName };
    } catch (e) {
      const text = causeText(e);
      if (/backups\.status|backups_running_uq/.test(text))
        throw lifecycleError("BACKUP_IN_PROGRESS");
      if (/backups\.file_name|backups_file_name_uq/.test(text)) continue; // başka süreç aynı adı aldı
      throw e;
    }
  }
  throw lifecycleError("BACKUP_FAILED");
}

/**
 * Ana veritabanının tutarlı anlık görüntüsü (ayrı bağlantı, `VACUUM INTO`; yalnızca ana şema). Uygulanmış migrasyon
 * sayısını döndürür.
 */
export async function snapshotDatabase(target: string, source: string = dbPath()): Promise<number> {
  const client = createClient({ url: toLibsqlUrl(source) });
  try {
    await client.execute("PRAGMA busy_timeout = 8000");
    const n = await client.execute("SELECT COUNT(*) AS n FROM __drizzle_migrations");
    await client.execute({ sql: "VACUUM INTO ?", args: [target] });
    return Number(n.rows[0]?.n ?? 0);
  } finally {
    client.close();
  }
}

async function sha256File(file: string): Promise<{ bytes: number; sha256: string }> {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: h.digest("hex") };
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function workDir(): string {
  const root = path.join(dataDir(), WORK_DIR);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, "w-"));
}

export interface CreateBackupResult {
  backup: BackupRow;
  /** Okunamadığı için yedeğe konamayan gizli bilgi sayısı (değer yok). */
  secretsSkipped: number;
}

export async function createBackup(
  db: Db,
  o: { kind: BackupKind; now?: number; includeSecrets?: boolean; passphrase?: string },
  deps: BackupDeps = {},
): Promise<CreateBackupResult> {
  const now = o.now ?? Date.now();
  let passphrase = o.passphrase;
  if (passphrase === undefined) {
    try {
      passphrase = await getSecret(BACKUP_PASSPHRASE_SECRET);
    } catch {
      passphrase = undefined;
    }
  }
  if (!passphrase) throw lifecycleError("BACKUP_PASSPHRASE_REQUIRED");
  await recoverStaleRunning(db, now);
  const s = await getSettings(db, ["backup.schedule", "backup.folder"] as const);
  const includeSecrets = o.includeSecrets ?? s["backup.schedule"].includeSecrets;
  const folder = resolveBackupFolder(s["backup.folder"]);
  const { id, fileName } = await reserveRow(db, {
    kind: o.kind,
    folder,
    includesSecrets: includeSecrets,
    now,
  });
  const finalFile = path.join(folder, fileName);
  const part = `${finalFile}.part`;
  let work: string | null = null;
  let secretsSkipped = 0;
  try {
    work = workDir();
    const snap = path.join(work, "snapshot.db");
    const schemaMigrations = await snapshotDatabase(snap);
    const db0 = await sha256File(snap);
    let secrets: Record<string, string> | undefined;
    if (includeSecrets) {
      const ex = exportSecrets();
      secrets = ex.secrets;
      secretsSkipped = ex.skipped;
    }
    const writer = (
      deps.createWriter ?? ((f) => fs.createWriteStream(f, { flags: "wx", mode: 0o600 }))
    )(part);
    const res = await writeEncryptedBackup({
      passphrase,
      meta: {
        app: "universal-mail",
        appVersion: APP_VERSION.slice(0, 40) || "0",
        createdAt: now,
        kind: o.kind,
        schemaMigrations,
        includesSecrets: includeSecrets,
        compression: "gzip",
      },
      manifest: {
        dbBytes: db0.bytes,
        dbSha256: db0.sha256,
        ...(secrets ? { secrets } : {}),
      },
      dbFile: snap,
      out: writer,
      log2N: effectiveLog2N(deps),
    });
    fsyncFile(part);
    fs.renameSync(part, finalFile);
    await db
      .update(backups)
      .set({
        status: "ok",
        sizeBytes: res.bytes,
        sha256: res.sha256,
        schemaMigrations,
        finishedAt: Date.now(),
      })
      .where(eq(backups.id, id));
  } catch (e) {
    const code = classifyBackupError(e);
    fs.rmSync(part, { force: true });
    await db
      .update(backups)
      .set({ status: "failed", errorCode: code, finishedAt: Date.now() })
      .where(eq(backups.id, id))
      .catch(() => undefined);
    await audit(db, "backup.create", "backup", id, { kind: o.kind, ok: false, code }).catch(
      () => undefined,
    );
    throw e instanceof LifecycleError ? e : lifecycleError(code);
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
  await audit(db, "backup.create", "backup", id, {
    kind: o.kind,
    ok: true,
    includesSecrets: includeSecrets,
    secretsSkipped,
  });
  if (o.kind !== "manual") {
    const keep =
      o.kind === "startup" ? s["backup.schedule"].keepStartup : s["backup.schedule"].keepWeekly;
    await rotateBackups(db, o.kind, keep);
  }
  await pruneFailed(db, now);
  const row = (await db.select().from(backups).where(eq(backups.id, id)).limit(1))[0]!;
  return { backup: toBackupRow(row), secretsSkipped };
}

/** En yeni `keep` başarılı otomatik yedek kalır; eskilerin satırı ve dosyası silinir. Elle alınanlar ASLA silinmez. */
export async function rotateBackups(
  db: Db,
  kind: Exclude<BackupKind, "manual">,
  keep: number,
): Promise<number> {
  const rows = await db
    .select()
    .from(backups)
    .where(and(eq(backups.kind, kind), eq(backups.status, "ok")))
    .orderBy(desc(backups.createdAt), desc(backups.id));
  let removed = 0;
  for (const r of rows.slice(Math.max(1, keep))) {
    const file = backupFilePath(r);
    if (file) fs.rmSync(file, { force: true });
    await db.delete(backups).where(eq(backups.id, r.id));
    removed++;
  }
  return removed;
}

export async function pruneFailed(db: Db, now: number): Promise<number> {
  const rows = await db
    .delete(backups)
    .where(and(eq(backups.status, "failed"), lt(backups.createdAt, now - FAILED_KEEP_MS)))
    .returning({ id: backups.id });
  return rows.length;
}

/* ------------------------------------------------------------ liste / silme / indirme ------------------------------------------------------------ */

export async function listBackups(db: DbExecutor, limit = 200): Promise<BackupRow[]> {
  const rows = await db
    .select()
    .from(backups)
    .orderBy(desc(backups.createdAt), desc(backups.id))
    .limit(limit);
  return rows.map(toBackupRow);
}

export async function getBackupRow(db: DbExecutor, id: number): Promise<BackupDbRow | null> {
  return (await db.select().from(backups).where(eq(backups.id, id)).limit(1))[0] ?? null;
}

/** Satırı ve (varsa) dosyasını siler. Dosya yoksa da satır silinir. Süren yedek silinemez. */
export async function deleteBackup(db: Db, id: number): Promise<void> {
  const row = await getBackupRow(db, id);
  if (!row) throw new BackupNotFoundError();
  if (row.status === "running") throw lifecycleError("BACKUP_IN_PROGRESS");
  const file = backupFilePath(row);
  let fileRemoved = false;
  if (file) {
    try {
      fs.rmSync(file);
      fileRemoved = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
  }
  await db.delete(backups).where(eq(backups.id, id));
  await audit(db, "backup.delete", "backup", id, { kind: row.kind, fileRemoved });
}

/** İndirilecek dosya: başarılı satır + diskte duran dosya; aksi hâlde `BACKUP_FILE_MISSING`. */
export async function backupFileForDownload(
  db: DbExecutor,
  id: number,
): Promise<{ file: string; fileName: string; size: number }> {
  const row = await getBackupRow(db, id);
  if (!row) throw new BackupNotFoundError();
  const file = backupFilePath(row);
  if (row.status !== "ok" || !file) throw lifecycleError("BACKUP_FILE_MISSING");
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    return { file, fileName: row.fileName, size: st.size };
  } catch {
    throw lifecycleError("BACKUP_FILE_MISSING");
  }
}

/* ------------------------------------------------------------ ayarlar / parola ------------------------------------------------------------ */

export type BackupSchedule = SettingValue<"backup.schedule">;

export async function updateBackupSettings(
  db: Db,
  input: BackupSchedule & { folder: string | null },
): Promise<{ schedule: BackupSchedule; folder: string | null }> {
  const { folder: rawFolder, ...schedule } = input;
  const folder = rawFolder === null ? null : validateBackupFolder(rawFolder);
  await setSetting(db, "backup.schedule", schedule);
  await setSetting(db, "backup.folder", folder);
  await audit(db, "backup.settings", "settings", "backup", {
    ...schedule,
    folderIsDefault: folder === null,
  });
  return { schedule, folder };
}

export async function setBackupPassphrase(
  db: Db,
  input: { passphrase: string; confirm: string },
): Promise<void> {
  const value = checkNewPassphrase(input.passphrase, input.confirm);
  await setSecret(BACKUP_PASSPHRASE_SECRET, value);
  await audit(db, "backup.passphrase.set", "settings", "backup");
}

/**
 * Veri klasöründeki düz şema geçişi öncesi kopyalar (`pre-migrate-*.db`). Desen paket K'nin geçiş betiğiyle aynıdır
 * (`PRE_MIGRATE_RE`): yalnızca tamamlanmış kopyalar sayılır, yarım `.tmp` dosyaları sayılmaz.
 */
export function preMigrateCount(): number {
  try {
    return fs.readdirSync(backupsDir()).filter((f) => PRE_MIGRATE_RE.test(f)).length;
  } catch {
    return 0;
  }
}

export async function backupOverview(db: Db) {
  const s = await getSettings(db, ["backup.schedule", "backup.folder"] as const);
  return {
    backups: await listBackups(db),
    schedule: s["backup.schedule"],
    folder: s["backup.folder"] ?? backupsDir(),
    folderIsDefault: s["backup.folder"] === null,
    defaultFolder: backupsDir(),
    passphraseSet: await hasBackupPassphrase(),
    preMigrateCount: preMigrateCount(),
  };
}
