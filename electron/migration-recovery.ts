import path from "node:path";
import type { TrKey } from "../src/lib/i18n";
import type { MigrateResult, MigrateResultCode } from "../src/lib/db/migrate-result";

/**
 * Faz 6 (sözleşme K.2): şema geçişi başarısız olunca (migrate alt süreci sıfırdan farklı kodla çıktı) kullanıcıya
 * koda özel, anlaşılır bir iletişim kutusu gösterir ve ne yapılacağını döndürür:
 *   "retry" → ana süreç geçişi yeniden çalıştırır; "quit" → uygulama kapanır (ek hata kutusu GÖSTERİLMEZ).
 *
 * Düğmeler (kullanıcının arayüz dilinde):
 *   1. Yeniden dene: yalnızca ilk {@link MIGRATION_RETRY_DIALOGS} gösterimde (sonsuz döngü olmaz).
 *   2. Güncelleme öncesi yedeğe dön: yalnızca sonuç dosyasındaki yedek `<dataDir>/backups/pre-migrate-*.db` ise ve
 *      diskte varsa (ilk kurulumda yedek yoktur, düğme de yoktur). Onaydan sonra mevcut veritabanı (+ -wal/-shm)
 *      SİLİNMEDEN `backups/failed-migrate-<zaman>.db` adıyla kenara alınır ve yedek yerine konur.
 *   3. Günlük klasörünü aç: klasörü açar ve aynı iletişim kutusunu yeniden gösterir.
 *   4. Çık.
 *
 * Dosya güvenliği: önce yedeğin kopyası veri klasörüne hazırlanır (canlı dosyaya dokunulmaz), sonra yalnızca yeniden
 * adlandırma yapılır. Herhangi bir adım başarısız olursa yapılan adlandırmalar geri alınır, HİÇBİR dosya silinmez ve
 * kullanıcıya bu söylenir. Bağımlılıklar enjekte edilir (master-key.ts emsali; tam birim testi:
 * tests/electron-migration-recovery.test.ts).
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

/**
 * "Yeniden dene" düğmesinin sunulduğu en fazla iletişim kutusu sayısı (deneme 1 ve 2). Ana süreç
 * (`MIGRATION_MAX_ATTEMPTS = 4`) dördüncü başarısızlıkta bu iletişim kutusunu GÖSTERMEDEN genel hata kutusuna düşer; bu
 * yüzden üçüncü gösterim son gösterimdir ve yalnızca yedeğe dönüş / günlükler / çık sunar (yedeğe dönüş her zaman
 * erişilebilir kalır).
 */
export const MIGRATION_RETRY_DIALOGS = 2;
/** Electron'da ana veritabanı dosyasının adı (src/lib/config/paths.ts `dbPath()` varsayılanı). */
export const MAIN_DB_FILENAME = "universal-mail.db";
const PRE_MIGRATE_RE = /^pre-migrate-[0-9A-Za-z-]+\.db$/;
/** "Günlük klasörünü aç" sonrası iletişim kutusunun yeniden gösterilme sınırı (yalnızca sonsuz döngüye karşı). */
const MAX_DIALOG_LOOPS = 25;

const BODY_KEY: Record<Exclude<MigrateResultCode, "OK">, TrKey> = {
  BLOCKED: "electron.migrate.body.BLOCKED",
  DISK_FULL: "electron.migrate.body.DISK_FULL",
  CORRUPT: "electron.migrate.body.CORRUPT",
  VERIFY_FAILED: "electron.migrate.body.VERIFY_FAILED",
  FAILED: "electron.migrate.body.FAILED",
};

/** Sonuç dosyası yoksa/okunamadıysa veya (beklenmedik biçimde) OK diyorsa genel hata sayılır. */
export function failureCode(result: MigrateResult | null): Exclude<MigrateResultCode, "OK"> {
  return result && result.code !== "OK" ? result.code : "FAILED";
}

/**
 * Geri dönülebilecek güncelleme öncesi yedek: tam olarak `<dataDir>/backups/pre-migrate-*.db` ve diskte var. Başka her
 * yol (veri klasörü dışı, alt klasör, farklı ad) reddedilir; o durumda düğme gösterilmez.
 */
export function restorableBackup(
  result: MigrateResult | null,
  deps: Pick<MigrationRecoveryDeps, "dataDir" | "exists">,
): string | null {
  const p = result?.backupPath;
  if (!p) return null;
  const backupsDir = path.resolve(deps.dataDir, "backups");
  const abs = path.resolve(p);
  if (path.dirname(abs) !== backupsDir) return null;
  if (!PRE_MIGRATE_RE.test(path.basename(abs))) return null;
  return deps.exists(abs) ? abs : null;
}

const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

export type RestoreOutcome =
  | { ok: true; movedTo: string }
  | { ok: false; step: "copy" | "move" | "place"; rolledBack: boolean };

/**
 * Güncelleme öncesi yedeğe dönüş (kopyala → kenara al → yerine koy). Hiçbir adım dosya SİLMEZ:
 *   1. yedek (+ -wal) veri klasörüne `universal-mail.db.restore-<zaman>` olarak KOPYALANIR (canlı dosyaya dokunulmaz);
 *   2. mevcut veritabanı ve -wal/-shm dosyaları `backups/failed-migrate-<zaman>.db*` adına TAŞINIR (eski -wal yeni
 *      dosyaya karışmasın diye hepsi birlikte);
 *   3. hazırlanan kopya `universal-mail.db` (+ -wal) adına TAŞINIR.
 * 2. veya 3. adım yarıda kalırsa o ana kadarki adlandırmalar ters sırayla geri alınır.
 */
export function restorePreMigrateBackup(
  backupPath: string,
  deps: Pick<MigrationRecoveryDeps, "dataDir" | "exists" | "copyFile" | "rename" | "now" | "log">,
  at: number = deps.now(),
): RestoreOutcome {
  const db = path.join(deps.dataDir, MAIN_DB_FILENAME);
  const stamp = stampOf(at);
  const staged = `${db}.restore-${stamp}`;
  const aside = path.join(deps.dataDir, "backups", `failed-migrate-${stamp}.db`);
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const stagedWal = deps.exists(`${backupPath}-wal`);
  try {
    deps.copyFile(backupPath, staged);
    if (stagedWal) deps.copyFile(`${backupPath}-wal`, `${staged}-wal`);
  } catch (e) {
    deps.log(`Yedeğe dönüş: kopya hazırlanamadı (${errText(e)}); veritabanına dokunulmadı.`);
    return { ok: false, step: "copy", rolledBack: true };
  }

  const done: Array<[string, string]> = [];
  const undo = (): boolean => {
    let clean = true;
    for (const [from, to] of done.reverse()) {
      try {
        deps.rename(to, from);
      } catch (e) {
        clean = false;
        deps.log(`Yedeğe dönüş: geri alınamadı ${to} → ${from} (${errText(e)}).`);
      }
    }
    return clean;
  };
  const move = (from: string, to: string) => {
    deps.rename(from, to);
    done.push([from, to]);
  };

  try {
    for (const suffix of ["", "-wal", "-shm"])
      if (deps.exists(`${db}${suffix}`)) move(`${db}${suffix}`, `${aside}${suffix}`);
  } catch (e) {
    deps.log(`Yedeğe dönüş: mevcut veritabanı kenara alınamadı (${errText(e)}).`);
    return { ok: false, step: "move", rolledBack: undo() };
  }
  try {
    move(staged, db);
    if (stagedWal) move(`${staged}-wal`, `${db}-wal`);
  } catch (e) {
    deps.log(`Yedeğe dönüş: yedek yerine konamadı (${errText(e)}).`);
    return { ok: false, step: "place", rolledBack: undo() };
  }
  deps.log(
    `Yedeğe dönüş tamam: ${path.basename(backupPath)} geri kondu; önceki dosya ${path.basename(aside)}.`,
  );
  return { ok: true, movedTo: aside };
}

export async function handleMigrationFailure(
  result: MigrateResult | null,
  deps: MigrationRecoveryDeps,
): Promise<MigrationRecoveryAction> {
  const { t } = deps;
  const code = failureCode(result);
  const canRetry = deps.attempt <= MIGRATION_RETRY_DIALOGS;
  deps.log(
    `Geçiş hatası iletişim kutusu: kod=${code}, çıkış=${deps.exitCode}, deneme=${deps.attempt}, ` +
      `yeniden deneme=${canRetry ? "var" : "yok"}`,
  );

  for (let loop = 0; loop < MAX_DIALOG_LOOPS; loop++) {
    // Yedeğin varlığı her gösterimde yeniden denetlenir (kullanıcı klasörü açıp dosyayı taşımış olabilir).
    const backup = restorableBackup(result, deps);
    const actions: Array<"retry" | "restore" | "logs" | "quit"> = [];
    if (canRetry) actions.push("retry");
    if (backup) actions.push("restore");
    actions.push("logs", "quit");
    const label = {
      retry: t("electron.migrate.btn.retry"),
      restore: t("electron.migrate.btn.restore"),
      logs: t("electron.migrate.btn.logs"),
      quit: t("electron.migrate.btn.quit"),
    };
    const detail = [
      backup ? t("electron.migrate.backupAvailable") : t("electron.migrate.noBackup"),
      canRetry ? null : t("electron.migrate.retryExhausted"),
      t("electron.startError.logDir", { dir: deps.logDir }),
    ]
      .filter(Boolean)
      .join("\n\n");
    const quitIndex = actions.indexOf("quit");
    const picked = deps.showMessageBox({
      type: "error",
      title: t("electron.migrate.title"),
      message: t(BODY_KEY[code]),
      detail,
      buttons: actions.map((a) => label[a]),
      defaultId: 0,
      cancelId: quitIndex,
      noLink: true,
    });
    const action = actions[picked] ?? "quit";

    if (action === "retry") return "retry";
    if (action === "quit") return "quit";
    if (action === "logs") {
      deps.openPath(deps.logDir);
      continue;
    }

    // action === "restore" (backup burada kesin vardır)
    const at = deps.now();
    const confirmed = deps.showMessageBox({
      type: "warning",
      title: t("electron.migrate.confirm.title"),
      message: t("electron.migrate.confirm.body", { file: `failed-migrate-${stampOf(at)}.db` }),
      buttons: [t("electron.migrate.confirm.yes"), t("electron.migrate.confirm.no")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmed !== 0) continue;
    const outcome = restorePreMigrateBackup(backup!, deps, at);
    if (outcome.ok) {
      deps.showMessageBox({
        type: "info",
        title: t("electron.migrate.restored.title"),
        message: t("electron.migrate.restored.body"),
        detail: t("electron.startError.logDir", { dir: deps.logDir }),
        buttons: [t("electron.migrate.btn.ok")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return "quit";
    }
    deps.showMessageBox({
      type: "error",
      title: t("electron.migrate.restoreFailed.title"),
      message: t(
        outcome.rolledBack
          ? "electron.migrate.restoreFailed.body"
          : "electron.migrate.restoreFailed.partial",
      ),
      detail: [
        t("electron.migrate.dataDir", { dir: deps.dataDir }),
        t("electron.startError.logDir", { dir: deps.logDir }),
      ].join("\n"),
      buttons: [t("electron.migrate.btn.ok")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    // Kullanıcı yeniden deneyebilir, günlükleri açabilir veya çıkabilir.
  }
  return "quit";
}
