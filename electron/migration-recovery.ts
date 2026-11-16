import type { TrKey } from "../src/lib/i18n";
import type { MigrateResult } from "../src/lib/db/migrate-result";

/**
 * Faz 6 (P0.6; sahibi: paket K): şema geçişi başarısız olunca (migrate alt süreci sıfırdan farklı kodla çıktı) kullanıcıya
 * koda özel, anlaşılır bir iletişim kutusu gösterir ve ne yapılacağını döndürür:
 *   "retry" → ana süreç geçişi yeniden çalıştırır; "quit" → uygulama kapanır (ek hata kutusu GÖSTERİLMEZ).
 * Sözleşme K.2: "Yeniden dene", "Güncelleme öncesi yedeğe dön" (yalnızca `<dataDir>/backups/pre-migrate-*.db` varsa),
 * "Günlük klasörünü aç", "Çık". Bağımlılıklar enjekte edilir (master-key.ts emsali; tam birim testi).
 *
 * P0: önceki davranışın AYNISI — genel hata kutusu (başlık `electron.startError.title`, ileti + günlük klasörü) ve "quit".
 */
export interface MigrationRecoveryDeps {
  dataDir: string;
  logDir: string;
  /** Bu kaçıncı deneme (1'den başlar). Sınır paket K'dedir; ana süreç ayrıca güvenlik sınırı uygular. */
  attempt: number;
  /** migrate alt sürecinin çıkış kodu (zaman aşımında null). */
  exitCode: number | null;
  /** Kullanıcının arayüz dilinde metin. */
  t: (key: TrKey, params?: Record<string, string | number>) => string;
  /** Yerel ileti kutusu (eşzamanlı); basılan düğmenin sırası. */
  showMessageBox: (spec: {
    type: "error" | "warning" | "info" | "question";
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail?: string;
    noLink?: boolean;
  }) => number;
  showErrorBox: (title: string, body: string) => void;
  /** Klasörü dosya yöneticisinde aç. */
  openPath: (p: string) => void;
  exists: (p: string) => boolean;
  copyFile: (from: string, to: string) => void;
  rename: (from: string, to: string) => void;
  readdir: (dir: string) => string[];
  now: () => number;
  log: (message: string) => void;
}

export type MigrationRecoveryAction = "retry" | "quit";

export async function handleMigrationFailure(
  _result: MigrateResult | null,
  deps: MigrationRecoveryDeps,
): Promise<MigrationRecoveryAction> {
  deps.showErrorBox(
    deps.t("electron.startError.title"),
    `Veritabanı hazırlanamadı (kod=${deps.exitCode}). Ayrıntı için günlük dosyasına bakın.\n\n${deps.t("electron.startError.logDir", { dir: deps.logDir })}`,
  );
  return "quit";
}
