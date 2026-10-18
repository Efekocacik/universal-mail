import fs from "node:fs";
import path from "node:path";

/** Kullanıcı verisinin saklandığı klasör. Electron'da işletim sisteminin kullanıcı veri klasörüdür. */
export function dataDir(): string {
  const dir = process.env.UM_DATA_DIR ?? path.join(process.cwd(), ".data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return process.env.UM_DB_PATH ?? path.join(dataDir(), "universal-mail.db");
}

export function backupsDir(): string {
  const dir = path.join(dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function migrationsDir(): string {
  return process.env.UM_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

/** Statik veri dosyalarının (şehir listesi vb.) klasörü. */
export function staticDataDir(): string {
  return process.env.UM_STATIC_DATA_DIR ?? path.join(process.cwd(), "data");
}

/**
 * libsql "file:" adresi üretir. Adres yüzde-kodlamayla çözüldüğünden `%`, `?` ve `#`
 * karakterleri kodlanır. Windows sürücü harfli yollar eğik çizgiye çevrilir.
 */
export function toLibsqlUrl(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  const encoded = normalized.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
  return `file:${encoded}`;
}
