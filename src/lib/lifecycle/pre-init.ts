import type { Db } from "@/lib/db/client";

/**
 * Faz 6 (P0 yer tutucusu; sahibi: paket Y): şema geçişi betiği (`scripts/migrate.ts`) veritabanını AÇMADAN önce bekleyen
 * yaşam döngüsü işlemini (geri yükleme veya "tüm verilerimi sil") uygular, açtıktan sonra denetim kaydı yazar. Sıra:
 * `runPreInitHooks` → `initDatabase` → `runPostInitHooks` → `writeMigrateResult`.
 *
 * Kurallar (sözleşme Y.3/Y.6): her adım kopyala-sonra-yeniden-adlandır; bekleyen dosya bozuk/eksikse işaret silinir ve
 * mevcut veritabanına dokunulmaz; hata asla mevcut veriyi yarım bırakmaz.
 */
export interface PreInitResult {
  /** Uygulanan işlem; yoksa null. */
  applied: null | { kind: "restore" | "wipe"; ok: boolean; code?: string };
}

export async function runPreInitHooks(_opts: {
  dataDir: string;
  log: (m: string) => void;
}): Promise<PreInitResult> {
  // P0: bekleyen işlem uygulanmaz (paket Y doldurur).
  return { applied: null };
}

export async function runPostInitHooks(_db: Db, _pre: PreInitResult): Promise<void> {
  // P0: hiçbir şey yazmaz (paket Y doldurur).
}
