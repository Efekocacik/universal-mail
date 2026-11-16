import fs from "node:fs";
import path from "node:path";
import { DB_FILENAME, PENDING_FILE, RESULT_FILE, STAGING_DIR, WORK_DIR } from "./pending";

/**
 * Faz 6 (paket Y.6): "Tüm verilerimi sil". Yalnızca `node:` modülleri: Electron ana süreci (ana anahtar yüklenmeden
 * önce) ve şema geçişi betiği (Electron dışı çalıştırma) aynı listeyi kullanır.
 *
 * Silinenler YALNIZCA uygulamanın bilinen dosyalarıdır; klasörün kendisi ve tanınmayan dosyalar kalır. Özel yedek
 * klasöründe yalnızca `universal-mail-*.umbk` (ve yarım `.part`) dosyaları, yalnızca "yedekleri de sil" seçiliyse.
 * Düz (şifresiz) şema geçişi ve geri yükleme öncesi kopyalar (`pre-migrate-*`, `pre-restore-*`) kişisel veri taşıdığı
 * için HER ZAMAN silinir.
 */

export { WIPE_PHRASES, wipePhraseMatches } from "./wipe-phrase";

export const BACKUP_FILE_RE = /^universal-mail-.+\.umbk(\.part)?$/;
/**
 * Düz (şifresiz) veritabanı kopyaları: şema geçişi ve geri yükleme öncesi kopyalar ile paket K'nin şema geçişi
 * kurtarmasının kenara aldığı başarısız veritabanı (`failed-migrate-*`).
 */
export const PLAIN_COPY_RE = /^(pre-(migrate|restore)|failed-migrate)-.+\.db(-wal|-shm|-journal)?$/;

export interface WipeReport {
  removed: number;
  /** Silinemeyen öğelerin klasöre göre adları (tam yol yok). */
  failed: string[];
}

function rm(target: string, label: string, r: WipeReport, recursive = false): void {
  try {
    const st = fs.lstatSync(target);
    if (st.isDirectory() && !recursive) return;
    fs.rmSync(target, { recursive, force: true });
    r.removed++;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") r.failed.push(label);
  }
}

function listSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Klasördeki desenle eşleşen DÜZ dosyalar (sembolik bağlantı ve klasör değil). */
function matchingFiles(dir: string, re: RegExp): string[] {
  return listSafe(dir).filter((n) => {
    if (!re.test(n)) return false;
    try {
      return fs.lstatSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

export interface WipeDataOptions {
  dataDir: string;
  /** Ana veritabanı dosyası (varsayılan `<dataDir>/universal-mail.db`). */
  dbFile?: string;
  deleteBackups: boolean;
  /** Ayarlı özel yedek klasörü (yalnızca `deleteBackups` iken desenle eşleşen dosyalar silinir). */
  customBackupFolder?: string;
  /** Yedek satırlarında geçen diğer klasörler (aynı kural). */
  customBackupFolders?: string[];
}

/** Veri klasöründeki uygulama dosyaları. Bekleyen işaret SİLİNMEZ (çağıran en sonda kaldırır). İdempotent. */
export function wipeDataDir(o: WipeDataOptions): WipeReport {
  const r: WipeReport = { removed: 0, failed: [] };
  const d = o.dataDir;
  const db = o.dbFile ?? path.join(d, DB_FILENAME);
  for (const suffix of ["", "-wal", "-shm", "-journal", ".restore-tmp"])
    rm(`${db}${suffix}`, `${path.basename(db)}${suffix}`, r);
  const names = new Set([
    "google-session.db",
    "google-session.db-wal",
    "google-session.db-shm",
    "google-session.db-journal",
    "worker-status.json",
    "migrate-result.json",
    "migrate.lock",
    "maintenance.lock",
    "master.key",
    "secrets.json",
    "secrets.json.lock",
    RESULT_FILE,
  ]);
  for (const n of listSafe(d)) {
    if (names.has(n) || /^secrets\.json\.(.+\.tmp|restore-tmp|corrupt-.+|pre-restore-.+)$/.test(n))
      rm(path.join(d, n), n, r);
    else if (n.startsWith(`${PENDING_FILE}.`) && n.endsWith(".tmp")) rm(path.join(d, n), n, r);
  }
  rm(path.join(d, STAGING_DIR), STAGING_DIR, r, true);
  rm(path.join(d, WORK_DIR), WORK_DIR, r, true);

  const backups = path.join(d, "backups");
  for (const n of matchingFiles(backups, PLAIN_COPY_RE))
    rm(path.join(backups, n), `backups/${n}`, r);
  if (o.deleteBackups) {
    for (const n of matchingFiles(backups, BACKUP_FILE_RE))
      rm(path.join(backups, n), `backups/${n}`, r);
    if (listSafe(backups).length === 0) {
      try {
        fs.rmdirSync(backups);
      } catch {
        /* klasör yok veya boş değil */
      }
    }
    const own = path.resolve(backups);
    const customs = new Set(
      [o.customBackupFolder, ...(o.customBackupFolders ?? [])]
        .filter((f): f is string => typeof f === "string" && path.isAbsolute(f))
        .map((f) => path.resolve(f))
        .filter((f) => f !== own),
    );
    for (const custom of customs)
      for (const n of matchingFiles(custom, BACKUP_FILE_RE)) rm(path.join(custom, n), n, r);
  }
  return r;
}

/** Electron kullanıcı klasöründeki uygulama dosyaları (ana anahtar, arayüz tercihleri, bildirim izi, günlükler). */
export function wipeUserData(userDataDir: string): WipeReport {
  const r: WipeReport = { removed: 0, failed: [] };
  for (const n of ["master.key.enc", "ui-prefs.json", "notified-alerts.json"])
    rm(path.join(userDataDir, n), n, r);
  rm(path.join(userDataDir, "logs"), "logs", r, true);
  return r;
}
