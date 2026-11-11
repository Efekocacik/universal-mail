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

function pruneBackups(dir: string, keep = 5): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".db"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true });
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
  if (total - (await appliedCount(client)) <= 0) return { pending: 0 };

  const file = dbPath();
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
      const cp = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backupsDir(), `pre-migrate-${stamp}.db`);
      fs.copyFileSync(file, backupPath);
      // Kontrol noktası tam yapılamadıysa (okuyucu vardı) WAL'de kalan çerçeveleri de yedeğe kat.
      if (Number(cp.rows[0]?.[0] ?? 0) !== 0 && fs.existsSync(`${file}-wal`))
        fs.copyFileSync(`${file}-wal`, `${backupPath}-wal`);
      pruneBackups(backupsDir());
    }

    await migrate(db, { migrationsFolder: folder });
    await verifyAfter(client, backupPath);
    return { pending, backupPath };
  } finally {
    lock?.release();
  }
}
