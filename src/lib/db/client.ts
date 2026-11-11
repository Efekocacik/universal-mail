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
import { waitForMaintenance } from "./maintenance";
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
export async function attachCache(
  client: Client,
  cacheFile: string,
  exec: Client["execute"] = client.execute.bind(client),
): Promise<void> {
  await exec({ sql: "ATTACH DATABASE ? AS gcache", args: [cacheFile] });
  await exec("PRAGMA gcache.journal_mode = WAL");
  await exec("PRAGMA gcache.synchronous = OFF"); // geçici veri: hız, dayanıklılık değil
  await exec(CACHE_DDL);
}

/** Bağlantı başına ayarlar ve önbellek eki (yeni açılışta ve bağlantı yenilendiğinde). */
async function configure(
  client: Client,
  path: string,
  exec: Client["execute"] = client.execute.bind(client),
): Promise<void> {
  // Kilit gerektirmeyen bütünlük ayarları önce: sonraki bir adım başarısız olsa bile yabancı anahtarlar açık kalır.
  await exec("PRAGMA foreign_keys = ON");
  await exec("PRAGMA busy_timeout = 8000");
  await exec("PRAGMA journal_mode = WAL");
  await exec("PRAGMA synchronous = NORMAL");
  await attachCache(client, cacheDbPathFor(path), exec);
}

/** İzlenen istemcinin durumu; bkz. `trackTransactions` ve `resetConnection`. */
interface TrackState {
  /** Açık (veya açılmakta olan) işlem sayısı. */
  open: number;
  /** Otomatik kurtarma için dosya yolu; yoksa (bellek içi, yol verilmedi) otomatik yenileme yapılmaz. */
  path: string | undefined;
  /** Bir ifade `SQLITE_BUSY` ile başarısız oldu ve bağlantı henüz yenilenmedi. */
  needsReset: boolean;
  /** Süren yenileme; bu sürece yeni çağrılar bekler (ve ikinci bir yenileme başlatılmaz). */
  inflight: Promise<boolean> | null;
  /** Sarmalanmamış `execute`: yenileme kendi ayar ifadeleri için bunu kullanır (kendi kapısına takılmasın). */
  rawExecute: Client["execute"];
}

const tracked = new WeakMap<Client, TrackState>();

/**
 * Hata (veya `cause` zincirindeki bir hata) başka bir bağlantının yazma kilidi yüzünden mi? Yalnızca bu durumda
 * bağlantı bozulabilir. `TRANSACTION_ACTIVE` (aynı bağlantıda açık işlem) bağlantıyı bozmaz ve burada sayılmaz.
 */
export function isBusyConnectionError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; cur && i < 5; i++) {
    const err = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (
      /SQLITE_BUSY|database is locked/i.test(
        `${String(err.code ?? "")} ${String(err.message ?? "")}`,
      )
    )
      return true;
    cur = err.cause;
  }
  return false;
}

/** Bağlantı yenilemesi gerekiyorsa ve güvenliyse (açık işlem yok) başlatır; başarısızsa sonraki fırsata bırakır. */
function recoverIfNeeded(client: Client, st: TrackState): void {
  if (!st.path || !st.needsReset || st.open > 0 || st.inflight) return;
  resetConnection(client, st.path).then(
    (done) => {
      if (!done) st.needsReset = true;
    },
    () => {
      st.needsReset = true; // sonraki meşgul sonucunda veya işlem bitişinde yeniden denenir
    },
  );
}

/**
 * İstemciyi izler ve sarmalar:
 * 1. `transaction()` çağrılarını sayar (sayaç işlem BAŞLATILMADAN artar, commit/rollback/close ile bir kez azalır);
 *    böylece `resetConnection` açık bir işlemin bağlantısını asla kapatmaz.
 * 2. `path` verilirse (dosya veritabanı), `SQLITE_BUSY` ile biten HERHANGİ bir ifade/işlem sonrasında bağlantı otomatik
 *    yenilenir. libsql'de meşgul sonucu alan bir bağlantıdaki hemen sonraki ifade başarılı görünüp UYGULANMAYABİLİR
 *    (sessiz veri kaybı; bkz. `resetConnection`). Yenileme sürerken yeni çağrılar bekler, böylece hiçbir ifade
 *    bozuk bağlantıda çalışmaz. Açık işlem varsa yenileme işlem bitince (commit/rollback/close) yapılır.
 *
 * Başarısız ifade ASLA otomatik yeniden çalıştırılmaz: özgün hata çağırana aynen iletilir (çift kayıt ve çift
 * gönderim riski yok); yeniden deneme kararı çağıranındır ve ifade uygulanmamış sayılmalıdır.
 */
export function trackTransactions(client: Client, path?: string): Client {
  if (tracked.has(client)) return client;
  const st: TrackState = {
    open: 0,
    path: path && path !== ":memory:" ? path : undefined,
    needsReset: false,
    inflight: null,
    rawExecute: client.execute.bind(client),
  };
  tracked.set(client, st);

  const waitGate = async () => {
    while (st.inflight) await st.inflight.catch(() => undefined);
    // Şema geçişi (bakım kilidi) başka bir süreçte sürüyorsa bekle; bkz. maintenance.ts (K3).
    if (st.path) await waitForMaintenance(st.path);
  };
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    await waitGate();
    try {
      return await fn();
    } catch (e) {
      if (isBusyConnectionError(e)) {
        st.needsReset = true;
        recoverIfNeeded(client, st); // aynı mikro görevde; kapı eşzamanlı kurulur
      }
      throw e;
    }
  };

  const batch = client.batch.bind(client);
  const multi = client.executeMultiple.bind(client);
  client.execute = ((...a: Parameters<Client["execute"]>) =>
    guard(() => st.rawExecute(...a))) as Client["execute"];
  client.batch = ((...a: Parameters<Client["batch"]>) =>
    guard(() => batch(...a))) as Client["batch"];
  client.executeMultiple = ((...a: Parameters<Client["executeMultiple"]>) =>
    guard(() => multi(...a))) as Client["executeMultiple"];

  const begin = client.transaction.bind(client);
  client.transaction = (async (mode?: TransactionMode): Promise<Transaction> => {
    await waitGate();
    st.open += 1;
    let tx: Transaction;
    try {
      tx = await begin(mode);
    } catch (e) {
      st.open -= 1;
      if (isBusyConnectionError(e)) st.needsReset = true;
      recoverIfNeeded(client, st);
      throw e;
    }
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        st.open -= 1;
        recoverIfNeeded(client, st);
      }
    };
    const markBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (isBusyConnectionError(e)) st.needsReset = true; // yenileme işlem bitince
        throw e;
      }
    };
    const exec = tx.execute.bind(tx);
    const txBatch = tx.batch.bind(tx);
    const commit = tx.commit.bind(tx);
    const rollback = tx.rollback.bind(tx);
    const close = tx.close.bind(tx);
    tx.execute = ((...a: Parameters<Transaction["execute"]>) =>
      markBusy(() => exec(...a))) as Transaction["execute"];
    tx.batch = ((...a: Parameters<Transaction["batch"]>) =>
      markBusy(() => txBatch(...a))) as Transaction["batch"];
    tx.commit = async () => {
      await markBusy(() => commit());
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
  }) as Client["transaction"];
  return client;
}

async function open(path: string): Promise<Handle> {
  // concurrency=1: tek bağlantı. PRAGMA ayarları bağlantı başınadır; tek bağlantıyla tutarlı kalır.
  const client = trackTransactions(
    createClient({ url: toLibsqlUrl(path), concurrency: 1, timeout: 8000 }),
    path,
  );
  await configure(client, path);
  return { client, db: drizzle(client, { schema: { ...schema, ...cacheSchema } }) };
}

/**
 * Bağlantıyı yeniler ve ayarları yeniden uygular. libsql'de `SQLITE_BUSY` ile başarısız olan bir ifade (ör. başka
 * süreç yazma kilidini tutarken `INSERT` veya `BEGIN IMMEDIATE`) bağlantıda "devam ediyor" durumunda kalır. Sonuçlar
 * (geçici veritabanlarında, migrasyonsuz düz kilitle ölçüldü): o bağlantıdaki HEMEN SONRAKİ ifade başarılı dönüp
 * UYGULANMAYABİLİR (satır yazan bağlantı tarafından bile görülmez); COMMIT "SQL statements in progress" ile
 * başarısız olabilir; bağlantı açık bir işlemde takılı kalabilir. İzlenen ve dosya yolu verilen istemcilerde
 * (`open`) bu yenileme meşgul sonucundan sonra OTOMATİK yapılır; elle çağrı da güvenlidir (aynı yenilemeye katılır).
 * Aynı `Client`/`Db` nesneleri geçerli kalır.
 *
 * Güvenlik:
 * - Açık (veya açılmakta olan) bir işlem varken yenileme YAPILMAZ ve `false` döner: o işlemin bağlantısı kapatılırsa
 *   yazma kilidi bırakılmayabilir (testle doğrulandı). Otomatik yolda işlem bitince yenilenir. Denetim ile yeniden
 *   açma arasında `await` yoktur (yarış yok). Bu yüzden yalnızca `trackTransactions` ile izlenen istemciler yenilenebilir.
 * - Eşzamanlı çağrılar tek yenilemede birleşir (iki yenileme iç içe geçmez); yenileme sürerken izlenen istemcinin
 *   `execute/batch/transaction` çağrıları bekler.
 * - Yeniden açmanın hemen ardından, başka bir çağrıdan ÖNCE yabancı anahtar denetimi açılır.
 * - Gönderim açısından: yenileme hiçbir ileti kaydını değiştirmez, sağlayıcıyı çağırmaz ve hiçbir ifadeyi yeniden
 *   çalıştırmaz; ayrılmış adım (`sending`/`sent`/`unknown`) yenilemeden sonra da ikinci kez gönderilmez.
 * - Yalnızca dosya veritabanı içindir (bellek içi veritabanı yenilemede kaybolur).
 */
export async function resetConnection(client: Client, path: string): Promise<boolean> {
  if (!path || path === ":memory:")
    throw new Error("Bellek içi veritabanı bağlantısı yenilenemez.");
  const st = tracked.get(client);
  if (st === undefined) throw new Error("İşlemleri izlenmeyen bağlantı yenilenemez.");
  if (st.inflight) return st.inflight;
  if (st.open > 0) return false;
  st.needsReset = false;
  // Senkron sıra: yeniden açma ve ilk PRAGMA'lar, araya başka bir çağrı girmeden kuyruğa alınır.
  const run = (async () => {
    const reopened = client.reconnect();
    const fk = st.rawExecute("PRAGMA foreign_keys = ON");
    const busy = st.rawExecute("PRAGMA busy_timeout = 8000");
    await Promise.all([reopened, fk, busy]);
    await configure(client, path, st.rawExecute);
    const check = await st.rawExecute("PRAGMA foreign_keys");
    if (Number(check.rows[0]?.[0] ?? 0) !== 1) {
      throw new Error("Bağlantı yenilendi ancak yabancı anahtar denetimi açılamadı.");
    }
    return true;
  })();
  st.inflight = run;
  try {
    return await run;
  } finally {
    if (st.inflight === run) st.inflight = null;
  }
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
