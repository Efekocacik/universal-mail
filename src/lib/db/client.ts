import {
  createClient,
  type Client,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
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

/** Bağlantı başına ayarlar ve önbellek eki (yeni açılışta ve bağlantı yenilendiğinde). */
async function configure(client: Client, path: string): Promise<void> {
  // Kilit gerektirmeyen bütünlük ayarları önce: sonraki bir adım başarısız olsa bile yabancı anahtarlar açık kalır.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 8000");
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA synchronous = NORMAL");
  await attachCache(client, cacheDbPathFor(path));
}

/** İzlenen istemcilerde açık (veya açılmakta olan) işlem sayısı; bkz. `resetConnection`. */
const openTransactions = new WeakMap<Client, number>();

/**
 * İstemcinin `transaction()` çağrılarını sayar: sayaç işlem BAŞLATILMADAN artar, işlem commit/rollback/close ile
 * bitince (bir kez) azalır. Böylece `resetConnection` açık bir işlemin bağlantısını asla kapatmaz.
 */
export function trackTransactions(client: Client): Client {
  if (openTransactions.has(client)) return client;
  openTransactions.set(client, 0);
  const change = (d: number) =>
    openTransactions.set(client, (openTransactions.get(client) ?? 0) + d);
  const begin = client.transaction.bind(client);
  client.transaction = async (mode?: TransactionMode): Promise<Transaction> => {
    change(1);
    let tx: Transaction;
    try {
      tx = await begin(mode);
    } catch (e) {
      change(-1);
      throw e;
    }
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        change(-1);
      }
    };
    const commit = tx.commit.bind(tx);
    const rollback = tx.rollback.bind(tx);
    const close = tx.close.bind(tx);
    tx.commit = async () => {
      await commit();
      settle(); // başarısız commit'te drizzle rollback çağırır; sayaç orada azalır
    };
    tx.rollback = async () => {
      try {
        await rollback();
      } finally {
        settle();
      }
    };
    tx.close = () => {
      try {
        close();
      } finally {
        settle();
      }
    };
    return tx;
  };
  return client;
}

async function open(path: string): Promise<Handle> {
  // concurrency=1: tek bağlantı. PRAGMA ayarları bağlantı başınadır; tek bağlantıyla tutarlı kalır.
  const client = trackTransactions(
    createClient({ url: toLibsqlUrl(path), concurrency: 1, timeout: 8000 }),
  );
  await configure(client, path);
  return { client, db: drizzle(client, { schema: { ...schema, ...cacheSchema } }) };
}

/**
 * Bağlantıyı yeniler ve ayarları yeniden uygular. libsql'de `SQLITE_BUSY` ile başarısız olan bir ifade (ör. başka
 * süreç yazma kilidini tutarken `BEGIN IMMEDIATE`) bağlantıda "devam ediyor" durumunda kalır; o bağlantıdaki sonraki
 * işlemlerin COMMIT'i "SQL statements in progress" hatasıyla başarısız olur ve bağlantı açık bir işlemde takılı
 * kalabilir. Meşgul sonucu alındıktan sonra bu fonksiyon çağrılmalıdır. Aynı `Client`/`Db` nesneleri geçerli kalır.
 *
 * Güvenlik:
 * - Açık (veya açılmakta olan) bir işlem varken yenileme YAPILMAZ ve `false` döner: o işlemin bağlantısı kapatılırsa
 *   yazma kilidi bırakılmayabilir (testle doğrulandı). Çağıran daha sonra yeniden dener. Denetim ile yeniden açma
 *   arasında `await` yoktur (yarış yok). Bu yüzden yalnızca `trackTransactions` ile izlenen istemciler yenilenebilir.
 * - Yeniden açmanın hemen ardından, başka bir çağrıdan ÖNCE yabancı anahtar denetimi açılır.
 * - Gönderim açısından: yenileme hiçbir ileti kaydını değiştirmez ve sağlayıcıyı çağırmaz; ayrılmış adım
 *   (`sending`/`sent`/`unknown`) yenilemeden sonra da ikinci kez gönderilmez.
 * - Yalnızca dosya veritabanı içindir (bellek içi veritabanı yenilemede kaybolur).
 */
export async function resetConnection(client: Client, path: string): Promise<boolean> {
  if (!path || path === ":memory:")
    throw new Error("Bellek içi veritabanı bağlantısı yenilenemez.");
  const open = openTransactions.get(client);
  if (open === undefined) throw new Error("İşlemleri izlenmeyen bağlantı yenilenemez.");
  if (open > 0) return false;
  // Senkron sıra: yeniden açma ve ilk PRAGMA'lar, araya başka bir çağrı girmeden kuyruğa alınır.
  const reopened = client.reconnect();
  const fk = client.execute("PRAGMA foreign_keys = ON");
  const busy = client.execute("PRAGMA busy_timeout = 8000");
  await Promise.all([reopened, fk, busy]);
  await configure(client, path);
  const check = await client.execute("PRAGMA foreign_keys");
  if (Number(check.rows[0]?.[0] ?? 0) !== 1) {
    throw new Error("Bağlantı yenilendi ancak yabancı anahtar denetimi açılamadı.");
  }
  return true;
}

/** Süreç genelindeki bağlantıyı (varsa) yeniler; bkz. `resetConnection`. */
export async function recoverDbConnection(): Promise<boolean> {
  const g = globalThis as GlobalWithDb;
  const pending = g[globalKey];
  if (!pending) return false;
  return resetConnection((await pending).client, dbPath());
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
