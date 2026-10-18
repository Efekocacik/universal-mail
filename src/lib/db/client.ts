import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { dbPath, toLibsqlUrl } from "@/lib/config/paths";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema>;

interface Handle {
  client: Client;
  db: Db;
}

const globalKey = "__umDbHandle";
type GlobalWithDb = typeof globalThis & { [globalKey]?: Promise<Handle> };

async function open(path: string): Promise<Handle> {
  // concurrency=1: tek bağlantı. PRAGMA ayarları bağlantı başınadır; tek bağlantıyla tutarlı kalır.
  const client = createClient({ url: toLibsqlUrl(path), concurrency: 1, timeout: 8000 });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 8000");
  await client.execute("PRAGMA synchronous = NORMAL");
  return { client, db: drizzle(client, { schema }) };
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

export { schema };
