import fs from "node:fs";

/**
 * Önbellek DOSYASINI (ve SQLite yan dosyalarını) siler. Hiçbir süreç dosyayı açık tutmamalıdır; bu yüzden yalnızca
 * süreçler başlatılmadan önce (şema geçişi adımında) veya durdurulduktan sonra (kapanışta) çağrılır.
 * Yalnızca fs'ye bağlıdır; böylece Electron ana süreci ve şema geçişi betiği de kullanabilir. Silinemeyen dosya
 * sonraki başlangıçta yeniden denenir. Silinen dosya sayısını döndürür.
 */
export function wipeSessionCacheFiles(cacheFile: string): number {
  let removed = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = cacheFile + suffix;
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* silinemeyen dosya sonraki başlangıçta yeniden denenir */
    }
  }
  return removed;
}
