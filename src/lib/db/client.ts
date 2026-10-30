import { createClient, type Client, type ResultSet } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { cacheDbPathFor, dbPath, toLibsqlUrl } from "@/lib/config/paths";
import { CACHE_DDL } from "./cache-schema";
import * as cacheSchema from "./cache-schema";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema & typeof cacheSchema>;

/**
 * Sorgu yürütücüsü: veritabanı bağlantısı (`Db`) veya `db.transaction(...)` içindeki işlem nesnesi. Bir işlem
 * içinde de çağrılması gereken (ör. gönderimden hemen önceki uygunluk kontrolü) fonksiyonlar bunu kabul eder.
 */
export type DbExecutor = BaseSQLiteDatabase<"async", ResultSet, typeof schema & typeof cacheSchema>;

interface Handle {
  client: Client;
  db: Db;
}

const globalKey = "__umDbHandle";
type GlobalWithDb = typeof globalThis & { [globalKey]?: Promise<Handle> };

/**
 * Google oturum önbelleğini `gcache` takma adıyla ekler (bkz. cache-schema.ts). Tek bağlantı kullanıldığı için
 * ekleme bağlantı ömrü boyunca geçerlidir. Önbellek ana veritabanından AYRI bir dosyadır; böylece yedeklere
 * ve ana veritabanı dosyasına Google içeriği karışmaz.
 */
export async function attachCache(client: Client, cacheFile: string): Promise<void> {
  await client.execute({ sql: "ATTACH DATABASE ? AS gcache", args: [cacheFile] });
  await client.execute("PRAGMA gcache.journal_mode = WAL");
  await client.execute("PRAGMA gcache.synchronous = OFF"); // geçici veri: hız, dayanıklılık değil
  await client.execute(CACHE_DDL);
}

async function open(path: string): Promise<Handle> {
  // concurrency=1: tek bağlantı. PRAGMA ayarları bağlantı başınadır; tek bağlantıyla tutarlı kalır.
  const client = createClient({ url: toLibsqlUrl(path), concurrency: 1, timeout: 8000 });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 8000");
  await client.execute("PRAGMA synchronous = NORMAL");
  await attachCache(client, cacheDbPathFor(path));
  return { client, db: drizzle(client, { schema: { ...schema, ...cacheSchema } }) };
}

/** İşlem başına tek bağlantı (Next.js sıcak yeniden yüklemesine dayanıklı). */
export function getDb(): Promise<Db> {
  const g = globalThis as GlobalWithDb;
  g[globalKey] ??= open(dbPath());
  return g[globalKey].then((h) => h.db);
}

export function getClient(): Promise<Client> {
  const g = globalThis as GlobalWithDb;
  g[globalKey] ??= open(dbPath());
  return g[globalKey].then((h) => h.client);
}

/** Test ve betikler için belirli bir dosyaya bağlı yeni bir veritabanı açar. */
export async function openDatabase(path: string): Promise<Handle> {
  return open(path);
}

export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const pending = g[globalKey];
  if (!pending) return;
  g[globalKey] = undefined;
  (await pending).client.close();
}

export { schema, cacheSchema };
