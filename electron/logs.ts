/**
 * Günlük dosyası boyut sınırı (M9). Uygulama bir hafta açık kalabildiği için döndürme yalnızca açılışta değil, ana
 * süreçteki yoklama döngüsünde de yapılır. Saf işlev: dosya sistemi kapıları dışarıdan verilir (test edilebilir).
 *
 *   app.log → app.log.1 → app.log.2 (en eski silinir); toplam en çok (keep + 1) × maxBytes.
 */
export interface LogFsPorts {
  size: (p: string) => number | null;
  rename: (from: string, to: string) => void;
  remove: (p: string) => void;
}

export const LOG_MAX_BYTES = 5_000_000;
export const LOG_KEEP = 2;

/** Dosya sınırı aştıysa döndürür; döndürüldüyse `true`. Hiçbir hata uygulamayı etkilemez (sessizce `false`). */
export function rotateIfLarge(
  file: string,
  ports: LogFsPorts,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
): boolean {
  try {
    const size = ports.size(file);
    if (size === null || size <= maxBytes) return false;
    const oldest = `${file}.${keep}`;
    if (ports.size(oldest) !== null) ports.remove(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (ports.size(from) !== null) ports.rename(from, `${file}.${i + 1}`);
    }
    ports.rename(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}
