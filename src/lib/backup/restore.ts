import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { dataDir, migrationsDir, toLibsqlUrl } from "@/lib/config/paths";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import {
  createPending,
  newNonce,
  readPending,
  readPendingState,
  removePending,
  stageDirOf,
  stagingRoot,
  STAGE_ID_RE,
} from "@/lib/lifecycle/pending";
import { BACKUP_PASSPHRASE_SECRET } from "@/lib/secrets/store";
import { LifecycleError } from "./errors";
import { decryptBackup } from "./format";
import { lifecycleError, normalizePassphrase } from "./passphrase";
import { writeSecretsFile } from "./secrets-io";
import { BackupNotFoundError, backupFileForDownload } from "./service";
import type { BackupSummary } from "./shared";

/**
 * Faz 6 (paket Y.3): geri yükleme HAZIRLANIR, uygulama yeniden başlarken uygulanır (açık bağlantıların altında canlı
 * dosya asla değiştirilmez). `verifyAndStage` şifreyi çözer, bütünlüğü ve şema sürümünü denetler, özeti çıkarır ve
 * `<dataDir>/restore-staging/<stageId>/` altına yazar (1 saat geçerli). `scheduleRestore` bekleyen işareti yazar;
 * uygulama `src/lib/lifecycle/pre-init.ts`'tedir.
 */

export const STAGE_TTL_MS = 3_600_000;
/** Electron'da seçilen dosya üst sınırı (4 GiB); yükleme sınırı uçtadır (256 MiB). */
export const PATH_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

export type RestoreSource =
  | { kind: "backup"; id: number }
  | { kind: "path"; path: string }
  | { kind: "upload"; file: string };

export interface StageInfo {
  v: 1;
  stageId: string;
  createdAt: number;
  expiresAt: number;
  hasSecrets: boolean;
  migrationNeeded: boolean;
  summary: BackupSummary;
}

export interface VerifyResult {
  stageId: string;
  expiresAt: number;
  summary: BackupSummary;
  migrationNeeded: boolean;
  hasSecrets: boolean;
}

function journalTotal(): number {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(migrationsDir(), "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    return j.entries.length;
  } catch {
    return 0;
  }
}

function resolveSourceFile(src: Exclude<RestoreSource, { kind: "backup" }>): string {
  if (src.kind === "upload") return src.file;
  const p = src.path;
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0") || !/\.umbk$/i.test(p))
    throw lifecycleError("BACKUP_BAD_FORMAT");
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw lifecycleError("BACKUP_FILE_MISSING");
  }
  if (!st.isFile()) throw lifecycleError("BACKUP_BAD_FORMAT");
  if (st.size > PATH_MAX_BYTES) throw lifecycleError("BACKUP_TOO_LARGE");
  return p;
}

async function scalar(c: Client, sqlText: string): Promise<number> {
  const r = await c.execute(sqlText);
  return Number(r.rows[0]?.[0] ?? 0);
}

async function tableExists(c: Client, name: string): Promise<boolean> {
  const r = await c.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return r.rows.length > 0;
}

/** Hazırlanan veritabanını denetler: bütünlük, uygulama tabloları, şema sürümü; özet sayıları döner. */
async function inspectStagedDb(
  file: string,
): Promise<{ schemaMigrations: number; counts: BackupSummary["counts"] }> {
  const c = createClient({ url: toLibsqlUrl(file) });
  try {
    const ic = await c.execute("PRAGMA integrity_check");
    if (String(ic.rows[0]?.[0] ?? "") !== "ok") throw lifecycleError("BACKUP_CORRUPT");
    if (!(await tableExists(c, "__drizzle_migrations")) || !(await tableExists(c, "settings")))
      throw lifecycleError("BACKUP_BAD_FORMAT");
    const schemaMigrations = await scalar(c, "SELECT COUNT(*) FROM __drizzle_migrations");
    const count = async (t: string) =>
      (await tableExists(c, t)) ? scalar(c, `SELECT COUNT(*) FROM "${t}"`) : 0;
    return {
      schemaMigrations,
      counts: {
        leads: await count("leads"),
        campaigns: await count("campaigns"),
        messages: await count("messages"),
        templates: await count("templates"),
        mailboxes: await count("mailboxes"),
        suppressions: await count("suppressions"),
      },
    };
  } catch (e) {
    if (e instanceof LifecycleError) throw e;
    throw lifecycleError("BACKUP_CORRUPT"); // SQLite dosyası değil veya okunamıyor
  } finally {
    c.close();
  }
}

/** Bütün hazırlıkları siler (yeni doğrulama eskileri geçersiz kılar). */
export function clearStages(dir: string = dataDir()): void {
  fs.rmSync(stagingRoot(dir), { recursive: true, force: true });
}

/** Hazırlık bilgisi; yoksa, bozuksa veya (`now` verilirse) süresi dolmuşsa null. */
export function readStage(dir: string, stageId: string, now?: number): StageInfo | null {
  if (!STAGE_ID_RE.test(stageId)) return null;
  const sd = stageDirOf(dir, stageId);
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sd, "stage.json"), "utf8")) as StageInfo;
    if (s.v !== 1 || s.stageId !== stageId || !fs.statSync(path.join(sd, "db")).isFile())
      return null;
    if (now !== undefined && now > s.expiresAt) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Yedeği doğrular ve hazırlar. Bekleyen işlem varsa `LIFECYCLE_PENDING`. Sonuç (başarılı/başarısız, kod) denetim
 * kaydına yazılır; parola asla.
 */
export async function verifyAndStage(
  db: Db,
  o: { source: RestoreSource; passphrase: string; now?: number },
): Promise<VerifyResult> {
  const now = o.now ?? Date.now();
  const dir = dataDir();
  const sourceKind = o.source.kind;
  let sd: string | null = null;
  try {
    if (readPendingState(dir).state !== "none") throw lifecycleError("LIFECYCLE_PENDING");
    if (!normalizePassphrase(o.passphrase)) throw lifecycleError("BACKUP_WRONG_PASSPHRASE");
    const file =
      o.source.kind === "backup"
        ? (await backupFileForDownload(db, o.source.id)).file
        : resolveSourceFile(o.source);
    clearStages(dir);
    const stageId = crypto.randomBytes(16).toString("hex");
    sd = stageDirOf(dir, stageId);
    fs.mkdirSync(sd, { recursive: true, mode: 0o700 });
    const dbFile = path.join(sd, "db");
    const { meta, manifest } = await decryptBackup({
      file,
      passphrase: o.passphrase,
      outDbFile: dbFile,
    });
    const inspected = await inspectStagedDb(dbFile);
    const total = journalTotal();
    if (total > 0 && inspected.schemaMigrations > total)
      throw lifecycleError("BACKUP_SCHEMA_NEWER");
    const hasSecrets = !!manifest.secrets;
    if (manifest.secrets)
      writeSecretsFile(path.join(sd, "secrets.json"), {
        ...manifest.secrets,
        [BACKUP_PASSPHRASE_SECRET]: normalizePassphrase(o.passphrase),
      });
    const summary: BackupSummary = {
      createdAt: meta.createdAt,
      appVersion: meta.appVersion,
      kind: meta.kind,
      schemaMigrations: inspected.schemaMigrations,
      includesSecrets: hasSecrets,
      counts: inspected.counts,
    };
    const info: StageInfo = {
      v: 1,
      stageId,
      createdAt: now,
      expiresAt: now + STAGE_TTL_MS,
      hasSecrets,
      migrationNeeded: inspected.schemaMigrations < total,
      summary,
    };
    fs.writeFileSync(path.join(sd, "stage.json"), JSON.stringify(info), { mode: 0o600 });
    const entityId = o.source.kind === "backup" ? o.source.id : undefined;
    await audit(db, "backup.restore.verify", "backup", entityId, {
      ok: true,
      source: sourceKind,
      schemaMigrations: inspected.schemaMigrations,
    });
    return {
      stageId,
      expiresAt: info.expiresAt,
      summary,
      migrationNeeded: info.migrationNeeded,
      hasSecrets,
    };
  } catch (e) {
    if (sd) fs.rmSync(sd, { recursive: true, force: true });
    const code =
      e instanceof LifecycleError
        ? e.code
        : e instanceof BackupNotFoundError
          ? "NOT_FOUND"
          : "BACKUP_FAILED";
    await audit(db, "backup.restore.verify", "backup", undefined, {
      ok: false,
      source: sourceKind,
      code,
    }).catch(() => undefined);
    if (e instanceof LifecycleError || e instanceof BackupNotFoundError) throw e;
    throw lifecycleError("BACKUP_FAILED");
  }
}

/** Hazırlanan geri yüklemeyi yeniden başlatmaya planlar. */
export async function scheduleRestore(
  db: Db,
  o: { stageId: string; confirm: boolean; restoreSecrets: boolean; now?: number },
): Promise<void> {
  if (o.confirm !== true) throw lifecycleError("RESTORE_CONFIRM_REQUIRED");
  const now = o.now ?? Date.now();
  const dir = dataDir();
  const stage = readStage(dir, o.stageId, now);
  if (!stage) throw lifecycleError("RESTORE_STAGE_NOT_FOUND");
  const restoreSecrets = o.restoreSecrets && stage.hasSecrets;
  const created = createPending(dir, {
    v: 1,
    kind: "restore",
    stageId: o.stageId,
    restoreSecrets,
    at: now,
    nonce: newNonce(),
  });
  if (!created) throw lifecycleError("LIFECYCLE_PENDING");
  await audit(db, "backup.restore.schedule", "backup", undefined, {
    restoreSecrets,
    schemaMigrations: stage.summary.schemaMigrations,
  });
}

/** Hazırlığı iptal eder (idempotent). Bu hazırlığa bağlı bekleyen geri yükleme de kaldırılır. */
export async function cancelStage(db: Db, stageId: string): Promise<boolean> {
  if (!STAGE_ID_RE.test(stageId)) return false;
  const dir = dataDir();
  const pending = readPending(dir);
  let cancelled = false;
  if (pending?.kind === "restore" && pending.stageId === stageId) {
    removePending(dir);
    cancelled = true;
  }
  const sd = stageDirOf(dir, stageId);
  if (fs.existsSync(sd)) {
    fs.rmSync(sd, { recursive: true, force: true });
    cancelled = true;
  }
  if (cancelled) await audit(db, "data.pending.cancel", "backup", undefined, { kind: "restore" });
  return cancelled;
}
