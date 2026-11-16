import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { toLibsqlUrl } from "@/lib/config/paths";
import { closeDb, openDatabase, type Db } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

/**
 * Paket Y testleri: geçici veri klasörü + gerçek migrasyonlar + sabit test ana anahtarı + düşük scrypt maliyeti
 * (`UM_BACKUP_KDF_LOG2N` yalnızca `NODE_ENV=test` iken okunur). Gerçek uygulama klasörüne dokunulmaz. Bağlantı
 * kapatılıp yeniden açılabilir (geri yükleme/silme yeniden başlatmada uygulanır).
 */
export const TEST_PASS = "test-yedek-parolası-42";
const REPO = path.resolve(__dirname, "..", "..");
const KEYS = [
  "UM_MASTER_KEY",
  "UM_BACKUP_KDF_LOG2N",
  "UM_REQUIRE_MASTER_KEY",
  "UM_DATA_DIR",
  "UM_DB_PATH",
  "UM_MIGRATIONS_DIR",
  "UM_STATIC_DATA_DIR",
] as const;

export interface BackupEnv {
  dir: string;
  path: string;
  readonly db: Db;
  readonly client: Client;
  /** Aynı dosyaya ikinci (yazıcı) bağlantı. */
  raw: () => Client;
  /** Bağlantıyı kapatır (yeniden başlatma benzetimi). */
  close: () => Promise<void>;
  /** Yeniden açar ve bekleyen migrasyonları uygular (`initDatabase` benzetimi). */
  reopen: () => Promise<void>;
  done: () => Promise<void>;
}

export async function backupEnv(masterKey = "ab".repeat(32)): Promise<BackupEnv> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-bk-"));
  const file = path.join(dir, "universal-mail.db");
  process.env.UM_MASTER_KEY = masterKey;
  process.env.UM_BACKUP_KDF_LOG2N = "14";
  delete process.env.UM_REQUIRE_MASTER_KEY;
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = file;
  process.env.UM_MIGRATIONS_DIR = path.join(REPO, "drizzle");
  process.env.UM_STATIC_DATA_DIR = path.join(REPO, "data");
  let handle: Awaited<ReturnType<typeof openDatabase>> | null = null;
  const open = async () => {
    handle = await openDatabase(file);
    await runMigrations(handle.db, handle.client);
  };
  await open();
  const extra: Client[] = [];
  const env: BackupEnv = {
    dir,
    path: file,
    get db() {
      if (!handle) throw new Error("bağlantı kapalı");
      return handle.db;
    },
    get client() {
      if (!handle) throw new Error("bağlantı kapalı");
      return handle.client;
    },
    raw: () => {
      const c = createClient({ url: toLibsqlUrl(file) });
      extra.push(c);
      return c;
    },
    close: async () => {
      for (const c of extra.splice(0)) c.close();
      handle?.client.close();
      handle = null;
      await closeDb();
    },
    reopen: open,
    done: async () => {
      await env.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows geçici dosya kilidi */
      }
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
  return env;
}

/** Basit lead satırı (yalnızca zorunlu alanlar). */
export async function insertLead(
  c: Client,
  o: { createdAt: number; status?: string; lastContactedAt?: number | null; name?: string },
): Promise<number> {
  const r = await c.execute({
    sql: "INSERT INTO leads(source, display_name, status, last_contacted_at, created_at, updated_at) VALUES ('demo', ?, ?, ?, ?, ?) RETURNING id",
    args: [
      o.name ?? "Kafe",
      o.status ?? "new",
      o.lastContactedAt ?? null,
      o.createdAt,
      o.createdAt,
    ],
  });
  return Number(r.rows[0]!.id);
}

/** Uygulama tablolarının içeriği (sıralı JSON); denetim, yedek ve iş kayıtları hariç. */
export async function dumpTables(
  c: Client,
  skip: string[] = [],
): Promise<Record<string, unknown[]>> {
  const omit = new Set(["audit_log", "backups", "jobs", "sqlite_sequence", ...skip]);
  const t = await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, unknown[]> = {};
  for (const r of t.rows) {
    const name = String(r.name);
    if (omit.has(name)) continue;
    const rows = await c.execute(`SELECT * FROM "${name}"`);
    out[name] = rows.rows.map((x) => JSON.stringify(x)).sort();
  }
  return out;
}
