import fs from "node:fs";
import path from "node:path";

/** Süreç hâlâ çalışıyor mu? (`EPERM`: var ama erişim yok → çalışıyor sayılır.) */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const STALE_MS = 120_000;
const HEARTBEAT_MS = 10_000;

function lockHolderPid(lockPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(lockPath, "pid"), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Kilit bayat mı? Sahibi canlıysa ASLA (uzun süren bir şema geçişi kilidini kaybetmesin); aksi halde yaşa bakılır. */
function isStale(lockPath: string): boolean {
  const pid = lockHolderPid(lockPath);
  if (pid !== null && isProcessAlive(pid)) return false;
  return Date.now() - fs.statSync(lockPath).mtimeMs > (pid === null ? STALE_MS : 0);
}

/**
 * Basit dosya kilidi (süreçler arası). Veritabanı şema geçişinin iki süreçte aynı anda çalışmasını önler.
 * Kilit sahibinin süreç numarasını (`pid`) tutar ve kilit tutulurken düzenli olarak yenilenir. Bayat sayılma: sahibi
 * ölmüşse (hemen) veya süreç numarası okunamıyorsa ve kilit 2 dakikadan eskiyse. Sahibi CANLI olan kilit asla devralınmaz.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, "pid"), String(process.pid));
      } catch {
        /* pid yazılamazsa yaşa dayalı bayatlık kuralı geçerli kalır */
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (isStale(lockPath)) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // kilit bu sırada kaldırıldı
      }
      if (Date.now() - started > timeoutMs)
        throw new Error("Veritabanı kilidi alınamadı (zaman aşımı).");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      /* kilit kaldırıldıysa önemli değil */
    }
  }, HEARTBEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
