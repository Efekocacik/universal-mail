import fs from "node:fs";

/**
 * Basit dosya kilidi (süreçler arası). Veritabanı şema geçişinin iki süreçte aynı anda çalışmasını önler.
 * Kilit 2 dakikadan eskiyse bayat sayılıp devralınır.
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
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 120_000) {
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
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
