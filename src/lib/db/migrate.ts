import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { backupsDir, dbPath, migrationsDir } from "@/lib/config/paths";
import type { Client } from "@libsql/client";
import { acquireMaintenance } from "./maintenance";
import { isBusyConnectionError, type Db } from "./client";

interface Journal {
  entries: { idx: number; tag: string }[];
}

export interface MigrationResult {
  pending: number;
  backupPath?: string;
}

async function appliedCount(client: Client): Promise<number> {
  try {
    const res = await client.execute("SELECT COUNT(*) AS n FROM __drizzle_migrations");
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return 0; // tablo henüz yok
  }
}

function journalCount(folder: string): number {
  const file = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  return journal.entries.length;
}

/** Güncelleme öncesi yedek adı. Yalnızca tamamlanmış kopyalar bu adı taşır (yarım kopya `.tmp` olarak kalır/silinir). */
export const PRE_MIGRATE_RE = /^pre-migrate-[0-9A-Za-z-]+\.db$/;

function pruneBackups(dir: string, keep = 5): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => PRE_MIGRATE_RE.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, `${f}-wal`), { force: true });
  }
}

/**
 * Geçiş öncesi yedeği ATOMİK alır: önce `.tmp` adlarına kopyalanır, sonra yeniden adlandırılır (ana dosya en son; bu
 * yüzden `pre-migrate-*.db` adı varsa kopya tamdır). Kopya başarısız olursa (ör. ENOSPC) yarım dosyalar silinir ve
 * hata fırlatılır: yarım kopya ne yedek sayılır ne de `pruneBackups`'ın 5'lik sınırına girer.
 */
function takeBackup(file: string, backupPath: string, withWal: boolean): void {
  const tmp = `${backupPath}.tmp`;
  const walTmp = `${backupPath}-wal.tmp`;
  try {
    fs.copyFileSync(file, tmp);
    if (withWal) {
      fs.copyFileSync(`${file}-wal`, walTmp);
      fs.renameSync(walTmp, `${backupPath}-wal`);
    }
    fs.renameSync(tmp, backupPath);
  } catch (e) {
    for (const p of [tmp, walTmp, `${backupPath}-wal`]) fs.rmSync(p, { force: true });
    throw e;
  }
}

/**
 * Aynı açılıştaki önceki denemenin yedeği yeniden kullanılabilir mi? Electron ana süreci "Yeniden dene"de bunu
 * `UM_PRE_MIGRATE_BACKUP` ile verir; yalnızca geri alınmış (atomik) bir geçişten sonra yeniden denendiğinden veritabanı
 * o yedekle aynıdır. Yalnızca `<backups>/pre-migrate-*.db` ve diskte varsa kabul edilir.
 */
function reusableBackup(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const abs = path.resolve(p);
  if (path.dirname(abs) !== path.resolve(backupsDir())) return undefined;
  if (!PRE_MIGRATE_RE.test(path.basename(abs))) return undefined;
  return fs.existsSync(abs) ? abs : undefined;
}

/**
 * Doğrulama bekleyen geçiş işareti (veritabanının yanında). Geçiş SQL'inden ÖNCE yazılır, geçiş sonrası denetim
 * geçince silinir. Denetim başarısız olur ya da süreç arada kapanırsa işaret kalır; sonraki açılışta bekleyen geçiş
 * olmasa bile denetim YENİDEN yapılır. Böylece "Yeniden dene" veya yeniden açılış bozuk veritabanıyla açılmaz ve
 * güncelleme öncesi yedeğe dönüş seçeneği kaybolmaz.
 */
export const VERIFY_PENDING_FILENAME = "migrate-verify.pending";
const verifyMarkerFor = (dbFile: string) =>
  path.join(path.dirname(dbFile), VERIFY_PENDING_FILENAME);

function readVerifyMarker(dbFile: string): { backupPath?: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(verifyMarkerFor(dbFile), "utf8");
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as { backupPath?: unknown };
    return typeof v.backupPath === "string" ? { backupPath: v.backupPath } : {};
  } catch {
    return {}; // yarım yazılmış: yine de denetim yapılır
  }
}

export interface MigrationOptions {
  /** Tahmini süre bu sınırı (ms) aşarsa başka yazıcı yoklaması yapılır (K4). Varsayılan 6000 (busy_timeout 8000'in altı). */
  heavyThresholdMs?: number;
  /** Tahmin için satır başına mikrosaniye (1 milyon iletide ~17 sn ölçüldü). Varsayılan 17. */
  microsPerRow?: number;
  /** Yoklama deneme sayısı ve aralığı (ms). */
  probeAttempts?: number;
  probeIntervalMs?: number;
  /** Başka bir süreç şema güncellerken beklenecek azami süre (ms). */
  maintenanceTimeoutMs?: number;
  /**
   * Aynı açılıştaki önceki denemenin güncelleme öncesi yedeği (varsayılan: `UM_PRE_MIGRATE_BACKUP`). Geçerliyse yeni
   * kopya alınmaz (disk dolu iken yeniden deneme bir kopya daha harcamaz; eski geçerli yedekler budanmaz).
   */
  reuseBackupPath?: string;
}

/** Çok sayıda ileti olan veritabanında başka bir süreç yazarken geçiş BAŞLATILMAZ (K4). */
export class MigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationBlockedError";
  }
}

/** Geçiş uygulandı ama sonrasındaki bütünlük denetimi başarısız (yedek yerinde). */
export class MigrationVerificationError extends Error {
  constructor(
    message: string,
    readonly backupPath: string | undefined,
  ) {
    super(message);
    this.name = "MigrationVerificationError";
  }
}

/**
 * Faz 6 (K.2): geçiş SQL'i başarısız olursa, geçiş öncesi yedeğin yolu hataya `backupPath` olarak eklenir; böylece
 * `scripts/migrate.ts` bunu `migrate-result.json`'a yazar ve Electron "güncelleme öncesi yedeğe dön" düğmesini sunar.
 * Hata nesnesi değiştirilemiyorsa (dondurulmuş, ilkel değer) yol `cause` zinciri korunarak yeni bir hataya taşınır.
 */
export function withBackupPath(e: unknown, backupPath: string | undefined): unknown {
  if (!backupPath) return e;
  if (e instanceof Error && Object.isExtensible(e)) {
    if (typeof (e as { backupPath?: unknown }).backupPath !== "string")
      Object.defineProperty(e, "backupPath", {
        value: backupPath,
        enumerable: false,
        configurable: true,
      });
    return e;
  }
  return Object.assign(new Error(e instanceof Error ? e.message : String(e), { cause: e }), {
    backupPath,
  });
}

const isBusy = (e: unknown) => isBusyConnectionError(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tahmini geçiş süresi (ms): `messages` satır sayısı × satır başına maliyet. Tablo yoksa 0. */
async function estimateMs(client: Client, microsPerRow: number): Promise<number> {
  try {
    const res = await client.execute("SELECT COUNT(*) AS n FROM messages");
    return Math.round((Number(res.rows[0]?.n ?? 0) * microsPerRow) / 1000);
  } catch {
    return 0; // tablo henüz yok
  }
}

/** Yazma kilidi şu anda başka bir süreçte değil mi? (kısa yoklama; BUSY → engelli) */
async function assertNoOtherWriter(
  client: Client,
  attempts: number,
  intervalMs: number,
): Promise<void> {
  try {
    await client.execute("PRAGMA busy_timeout = 0");
    for (let i = 0; i < attempts; i++) {
      try {
        const tx = await client.transaction("write");
        await tx.rollback();
        if (i + 1 >= attempts) return;
        await sleep(intervalMs);
      } catch (e) {
        if (!isBusy(e)) throw e;
        throw new MigrationBlockedError(
          "Veritabanına başka bir süreç yazıyor. Çok sayıda ileti olduğundan şema güncellemesi uzun sürebilir ve " +
            "eşzamanlı yazma güvenli değildir: diğer uygulama süreçlerini kapatıp yeniden deneyin. Hiçbir değişiklik yapılmadı.",
        );
      }
    }
  } finally {
    await client.execute("PRAGMA busy_timeout = 8000");
  }
}

/** Geçiş sonrası bütünlük: yabancı anahtar ihlali yok ve denetim açık. */
async function verifyAfter(client: Client, backupPath: string | undefined): Promise<void> {
  const fk = await client.execute("PRAGMA foreign_key_check");
  if (fk.rows.length > 0)
    throw new MigrationVerificationError(
      `Şema geçişi sonrası ${fk.rows.length} yabancı anahtar ihlali bulundu.${backupPath ? ` Yedek: ${backupPath}` : ""}`,
      backupPath,
    );
  const on = await client.execute("PRAGMA foreign_keys");
  if (Number(on.rows[0]?.[0] ?? 0) !== 1)
    throw new MigrationVerificationError(
      `Şema geçişi sonrası yabancı anahtar denetimi kapalı.${backupPath ? ` Yedek: ${backupPath}` : ""}`,
      backupPath,
    );
}

/**
 * Bekleyen şema geçişlerini uygular. Veritabanında zaten veri varsa geçişten ÖNCE yedek alır
 * (NFR-10). Geçiş başarısız olursa yedek yerinde kalır ve hata yukarı fırlatılır.
 *
 * Aşama 15.10-1 korumaları:
 * - K2 (tek süreç): bekleyen iş varsa önce BAKIM KİLİDİ alınır; kilit alındıktan sonra bekleyen sayısı YENİDEN okunur
 *   (başka süreç az önce uygulamış olabilir) ve iş kalmadıysa hiçbir şey yapılmaz. `initDatabase` ayrıca `migrate.lock` tutar.
 * - K3 (bakım kipi): bakım kilidi süresince bu sürümün diğer süreçleri veritabanı çağrılarında bekler (bkz. maintenance.ts).
 * - K4 (süre ön denetimi): tahmini süre eşiği aşarsa başka bir yazıcı varken geçiş BAŞLAMAZ (`MigrationBlockedError`).
 * - K5 (bütünlük): satır sayısı, `sqlite_sequence`, indeks ve yabancı anahtar bekçileri geçişin SQL'inde (işlem geri alınır);
 *   ayrıca geçiş sonrası yabancı anahtar denetimi burada yapılır.
 */
export async function runMigrations(
  db: Db,
  client: Client,
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const folder = migrationsDir();
  const total = journalCount(folder);
  const file = dbPath();
  if (total - (await appliedCount(client)) <= 0) {
    const marker = readVerifyMarker(file);
    if (marker) {
      // Önceki geçiş uygulandı ama denetimi tamamlanmadı/başarısız oldu: yeniden denetle.
      await verifyAfter(client, marker.backupPath);
      fs.rmSync(verifyMarkerFor(file), { force: true });
    }
    return { pending: 0 };
  }

  const lock = fs.existsSync(file)
    ? await acquireMaintenance(file, "schema-migration", opts.maintenanceTimeoutMs)
    : null;
  try {
    const existing = await appliedCount(client);
    const pending = total - existing; // K2: kilit alındıktan sonra yeniden okunur
    if (pending <= 0) return { pending: 0 };

    const est = existing > 0 ? await estimateMs(client, opts.microsPerRow ?? 17) : 0;
    if (lock && est > (opts.heavyThresholdMs ?? 6000))
      await assertNoOtherWriter(client, opts.probeAttempts ?? 3, opts.probeIntervalMs ?? 150);

    let backupPath: string | undefined;
    if (existing > 0 && fs.existsSync(file)) {
      backupPath = reusableBackup(opts.reuseBackupPath ?? process.env.UM_PRE_MIGRATE_BACKUP);
      if (!backupPath) {
        const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const target = path.join(backupsDir(), `pre-migrate-${stamp}.db`);
        // Kontrol noktası tam yapılamadıysa (okuyucu vardı) WAL'de kalan çerçeveleri de yedeğe kat.
        takeBackup(
          file,
          target,
          Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${file}-wal`),
        );
        backupPath = target;
        pruneBackups(backupsDir());
      }
    }

    try {
      fs.writeFileSync(verifyMarkerFor(file), JSON.stringify({ backupPath: backupPath ?? null }));
      await migrate(db, { migrationsFolder: folder });
    } catch (e) {
      throw withBackupPath(e, backupPath);
    }
    await verifyAfter(client, backupPath);
    fs.rmSync(verifyMarkerFor(file), { force: true });
    return { pending, backupPath };
  } finally {
    lock?.release();
  }
}
