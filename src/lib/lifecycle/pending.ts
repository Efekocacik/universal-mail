import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LifecyclePending } from "../backup/shared";

/**
 * Faz 6 (paket Y): yeniden başlatmada uygulanacak işlem işareti (`lifecycle-pending.json`), son işlemin sonucu
 * (`lifecycle-result.json`) ve geri yükleme hazırlık klasörü. Yalnızca `node:` modülleri kullanılır: Electron ana süreci
 * de bu dosyayı içerir (veritabanı/ayar katmanına bağımlılık yok).
 *
 * İşaret tek olur: oluşturma "yoksa oluştur" atomiktir (geçici dosya + sabit bağlantı); varsa `false` döner.
 */

export const PENDING_FILE = "lifecycle-pending.json";
export const RESULT_FILE = "lifecycle-result.json";
export const STAGING_DIR = "restore-staging";
/** Yedek alırken düz anlık görüntünün ve yüklenen dosyaların geçici klasörü (veri klasöründe, kullanıcıya özel). */
export const WORK_DIR = "backup-tmp";
/** Veritabanı dosyasının varsayılan adı (`src/lib/config/paths.ts` `dbPath()` ile aynı). */
export const DB_FILENAME = "universal-mail.db";
export const STAGE_ID_RE = /^[0-9a-f]{32}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

export function newNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** İşaret içeriğini doğrular (bilinmeyen alan veya tür → geçersiz). */
export function parsePending(raw: unknown): LifecyclePending | null {
  if (!isObj(raw) || raw.v !== 1 || !isInt(raw.at) || raw.at < 0) return null;
  if (typeof raw.nonce !== "string" || !NONCE_RE.test(raw.nonce)) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (raw.kind === "restore") {
    if (keys !== "at,kind,nonce,restoreSecrets,stageId,v") return null;
    if (typeof raw.stageId !== "string" || !STAGE_ID_RE.test(raw.stageId)) return null;
    if (typeof raw.restoreSecrets !== "boolean") return null;
    return {
      v: 1,
      kind: "restore",
      stageId: raw.stageId,
      restoreSecrets: raw.restoreSecrets,
      at: raw.at,
      nonce: raw.nonce,
    };
  }
  if (raw.kind === "wipe") {
    const withFolder = keys === "at,customBackupFolder,deleteBackups,kind,nonce,v";
    if (!withFolder && keys !== "at,deleteBackups,kind,nonce,v") return null;
    if (typeof raw.deleteBackups !== "boolean") return null;
    if (withFolder) {
      const f = raw.customBackupFolder;
      if (typeof f !== "string" || !path.isAbsolute(f) || f.length > 1024 || f.includes("\0"))
        return null;
    }
    return {
      v: 1,
      kind: "wipe",
      deleteBackups: raw.deleteBackups,
      at: raw.at,
      nonce: raw.nonce,
      ...(withFolder ? { customBackupFolder: raw.customBackupFolder as string } : {}),
    };
  }
  return null;
}

export type PendingState =
  { state: "none" } | { state: "invalid" } | { state: "ok"; pending: LifecyclePending };

export function readPendingState(dataDir: string): PendingState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, PENDING_FILE), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { state: "none" }
      : { state: "invalid" };
  }
  try {
    const p = parsePending(JSON.parse(text));
    return p ? { state: "ok", pending: p } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

/** Geçerli bekleyen işlem; yoksa veya bozuksa null. */
export function readPending(dataDir: string): LifecyclePending | null {
  const s = readPendingState(dataDir);
  return s.state === "ok" ? s.pending : null;
}

function writeTmp(target: string, data: string): string {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/** İşareti YOKSA oluşturur (atomik). Zaten varsa (geçersiz olsa bile) `false`. */
export function createPending(dataDir: string, p: LifecyclePending): boolean {
  if (!parsePending(p)) throw new Error("Geçersiz bekleyen işlem.");
  const target = path.join(dataDir, PENDING_FILE);
  const tmp = writeTmp(target, JSON.stringify(p));
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw e;
    // Sabit bağlantı desteklenmeyen dosya sistemi: özel oluşturma (içerik ayrı yazılır).
    try {
      fs.writeFileSync(target, JSON.stringify(p), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw e2;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function removePending(dataDir: string): void {
  fs.rmSync(path.join(dataDir, PENDING_FILE), { force: true });
}

/** Son uygulanan işlemin sonucu (arayüzde bir kez gösterilir; yalnızca kod ve sayılar, yol yok). */
export interface LifecycleResult {
  v: 1;
  kind: "restore" | "wipe";
  ok: boolean;
  code?: string;
  at: number;
  secretsRestored?: boolean;
}

export function writeResult(dataDir: string, r: LifecycleResult): void {
  const target = path.join(dataDir, RESULT_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.renameSync(writeTmp(target, JSON.stringify(r)), target);
}

export function readResult(dataDir: string): LifecycleResult | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, RESULT_FILE), "utf8")) as unknown;
    if (!isObj(r) || r.v !== 1 || (r.kind !== "restore" && r.kind !== "wipe")) return null;
    if (typeof r.ok !== "boolean" || !isInt(r.at)) return null;
    const code =
      typeof r.code === "string" && /^[A-Z0-9_]{1,40}$/.test(r.code) ? r.code : undefined;
    return {
      v: 1,
      kind: r.kind,
      ok: r.ok,
      at: r.at,
      ...(code ? { code } : {}),
      ...(typeof r.secretsRestored === "boolean" ? { secretsRestored: r.secretsRestored } : {}),
    };
  } catch {
    return null;
  }
}

export function removeResult(dataDir: string): void {
  fs.rmSync(path.join(dataDir, RESULT_FILE), { force: true });
}

export function stagingRoot(dataDir: string): string {
  return path.join(dataDir, STAGING_DIR);
}

export function stageDirOf(dataDir: string, stageId: string): string {
  if (!STAGE_ID_RE.test(stageId)) throw new Error("Geçersiz hazırlık kimliği.");
  return path.join(stagingRoot(dataDir), stageId);
}
