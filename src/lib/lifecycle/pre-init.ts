import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { backups } from "@/lib/db/schema";
import { errorMessage } from "@/lib/util";
import { DB_FILENAME, readPendingState, removePending, stageDirOf, writeResult } from "./pending";
import { wipeDataDir } from "./wipe";

/**
 * Faz 6 (paket Y.3/Y.6): şema geçişi betiği (`scripts/migrate.ts`) veritabanını AÇMADAN önce bekleyen yaşam döngüsü
 * işlemini uygular, açtıktan sonra denetim kaydı yazar. Sıra: `runPreInitHooks` → `initDatabase` → `runPostInitHooks`
 * → `writeMigrateResult`. Electron'da "verileri sil" ana süreçte zaten uygulanmıştır (işaret silinmiş olur); burada
 * yalnızca Electron dışı çalıştırmalar (geliştirme, e2e) için aynı veri klasörü adımı vardır.
 *
 * Geri yükleme adımları (her biri kopyala-sonra-yeniden-adlandır):
 *  1. Mevcut veritabanı (+WAL) `backups/pre-restore-<zaman>.db` olarak kopyalanır (en yeni 3 tutulur).
 *  2. Eski `-wal`/`-shm` silinir ve hazırlanan veritabanı yerine konur (eski WAL yeni dosyaya UYGULANMAZ).
 *  3. İstenirse `secrets.json` → `secrets.json.pre-restore-<zaman>` ve hazırlanan depo yerine konur.
 *  4. Hazırlık ve işaret silinir, `lifecycle-result.json` yazılır.
 * Hazırlık yoksa/bozuksa işaret kaldırılır, sonuç `ok:false` kaydedilir ve mevcut veritabanına DOKUNULMAZ. İşaret her
 * durumda kaldırılır: kalıcı bir hata her açılışta yeniden denenmez.
 */
export interface PreInitResult {
  /** Uygulanan işlem; yoksa null. */
  applied: null | { kind: "restore" | "wipe"; ok: boolean; code?: string };
}

export const PRE_RESTORE_KEEP = 3;

const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, "-");

function copyDurable(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  const fd = fs.openSync(dest, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function prunePreRestore(dir: string, keep = PRE_RESTORE_KEEP): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const bases = names.filter((f) => /^pre-restore-.+\.db$/.test(f)).sort();
  for (const b of bases.slice(0, Math.max(0, bases.length - keep)))
    for (const suffix of ["", "-wal", "-shm"])
      fs.rmSync(path.join(dir, `${b}${suffix}`), { force: true });
}

function stageValid(sd: string): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sd, "stage.json"), "utf8")) as { v?: unknown };
    return s.v === 1 && fs.statSync(path.join(sd, "db")).isFile();
  } catch {
    return false;
  }
}

function applyRestore(
  dataDir: string,
  dbFile: string,
  p: { stageId: string; restoreSecrets: boolean },
  now: number,
  log: (m: string) => void,
): { ok: boolean; code?: string; secretsRestored: boolean } {
  const sd = stageDirOf(dataDir, p.stageId);
  if (!stageValid(sd)) {
    log("geri yükleme: hazırlık bulunamadı veya bozuk; mevcut veritabanına dokunulmadı.");
    return { ok: false, code: "RESTORE_STAGE_NOT_FOUND", secretsRestored: false };
  }
  const ts = stamp(now);
  const backupDir = path.join(dataDir, "backups");
  let placed = false;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(dbFile)) {
      const copy = path.join(backupDir, `pre-restore-${ts}.db`);
      copyDurable(dbFile, copy);
      if (fs.existsSync(`${dbFile}-wal`)) copyDurable(`${dbFile}-wal`, `${copy}-wal`);
      prunePreRestore(backupDir);
    }
    const tmp = `${dbFile}.restore-tmp`;
    copyDurable(path.join(sd, "db"), tmp);
    for (const suffix of ["-wal", "-shm", "-journal"])
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    fs.renameSync(tmp, dbFile);
    placed = true;
    let secretsRestored = false;
    const stagedSecrets = path.join(sd, "secrets.json");
    if (p.restoreSecrets && fs.existsSync(stagedSecrets)) {
      const target = path.join(dataDir, "secrets.json");
      const stmp = `${target}.restore-tmp`;
      copyDurable(stagedSecrets, stmp);
      fs.chmodSync(stmp, 0o600);
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.pre-restore-${ts}`);
      fs.renameSync(stmp, target);
      secretsRestored = true;
    }
    fs.rmSync(sd, { recursive: true, force: true });
    log(`geri yükleme uygulandı${secretsRestored ? " (gizli bilgiler dahil)" : ""}.`);
    return { ok: true, secretsRestored };
  } catch (e) {
    fs.rmSync(`${dbFile}.restore-tmp`, { force: true });
    log(`geri yükleme başarısız: ${errorMessage(e).slice(0, 200)}`);
    // Veritabanı yerine konduysa geri yükleme gerçekleşti; yalnızca gizli bilgi adımı başarısız oldu.
    return {
      ok: placed,
      code: placed ? "SECRETS_RESTORE_FAILED" : "RESTORE_FAILED",
      secretsRestored: false,
    };
  }
}

export async function runPreInitHooks(opts: {
  dataDir: string;
  log: (m: string) => void;
  now?: number;
}): Promise<PreInitResult> {
  const { dataDir, log } = opts;
  const now = opts.now ?? Date.now();
  const s = readPendingState(dataDir);
  if (s.state === "none") return { applied: null };
  if (s.state === "invalid") {
    removePending(dataDir);
    log("bekleyen işlem dosyası bozuk; yok sayıldı ve silindi.");
    return { applied: null };
  }
  const p = s.pending;
  const dbFile = process.env.UM_DB_PATH ?? path.join(dataDir, DB_FILENAME);
  if (p.kind === "wipe") {
    const r = wipeDataDir({
      dataDir,
      dbFile,
      deleteBackups: p.deleteBackups,
      customBackupFolder: p.customBackupFolder,
    });
    removePending(dataDir);
    const ok = r.failed.length === 0;
    writeResult(dataDir, {
      v: 1,
      kind: "wipe",
      ok,
      at: now,
      ...(ok ? {} : { code: "WIPE_PARTIAL" }),
    });
    log(`verileriniz silindi (${r.removed} öğe${ok ? "" : `; silinemeyen: ${r.failed.length}`}).`);
    return { applied: { kind: "wipe", ok, ...(ok ? {} : { code: "WIPE_PARTIAL" }) } };
  }
  const r = applyRestore(dataDir, dbFile, p, now, log);
  removePending(dataDir);
  writeResult(dataDir, {
    v: 1,
    kind: "restore",
    ok: r.ok,
    at: now,
    secretsRestored: r.secretsRestored,
    ...(r.code ? { code: r.code } : {}),
  });
  return { applied: { kind: "restore", ok: r.ok, ...(r.code ? { code: r.code } : {}) } };
}

/**
 * Veritabanı açıldıktan (ve geri yüklenen eski şema güncellendikten) sonra: denetim kaydı. Geri yüklenen anlık görüntü
 * kendi `running` yedek satırını içerir; o satır `failed/INTERRUPTED` yapılır (yoksa yeni yedekler 30 dk engellenirdi).
 */
export async function runPostInitHooks(db: Db, pre: PreInitResult): Promise<void> {
  const a = pre.applied;
  if (!a) return;
  if (a.kind === "restore" && a.ok)
    await db
      .update(backups)
      .set({ status: "failed", errorCode: "INTERRUPTED", finishedAt: Date.now() })
      .where(eq(backups.status, "running"));
  await audit(
    db,
    a.kind === "restore" ? "data.restore.applied" : "data.wipe.applied",
    "data",
    undefined,
    {
      ok: a.ok,
      ...(a.code ? { code: a.code } : {}),
    },
  );
}
