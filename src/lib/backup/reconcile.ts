import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { backupsDir, dataDir } from "@/lib/config/paths";
import type { Db } from "@/lib/db/client";
import { backups } from "@/lib/db/schema";
import { WORK_DIR } from "@/lib/lifecycle/pending";
import { getSetting } from "@/lib/settings";
import { readBackupHeader, type BackupMeta } from "./format";
import { BACKUP_FILE_NAME_RE, backupFilePath } from "./service";

/**
 * Faz 6 (paket Y, inceleme düzeltmesi): açılışta yedek listesini diskle eşitler. Şema geçişi adımında (sunucu ve işçi
 * başlamadan, yani hiçbir yedek sürmüyorken) her açılışta çalışır:
 *  - `running` satır: son dosya diskte duruyor ve başlığı okunuyorsa `ok` (yedek bitti ama satır güncellenemeden
 *    kapandı; geri yüklenen anlık görüntünün kendi satırı da budur), aksi hâlde `failed/INTERRUPTED`. Böylece
 *    "Şimdi yedekle" 30 dakika kilitli kalmaz ve açılış yedeği o gün atlanmaz.
 *  - Yarım kalmış `universal-mail-*.umbk.part` dosyaları ve düz anlık görüntülerin geçici klasörü (`backup-tmp/`) silinir.
 *  - Diskte duran ama listede olmayan `universal-mail-*.umbk` dosyaları (geri yüklemeden sonra alınmış yedekler,
 *    "yedekler kalsın" ile silinen verilerden kalanlar) başlığından okunarak listeye eklenir (parola gerekmez).
 *  - `pruneMissing` (yalnızca geri yüklemeden sonra): klasörü duran ama dosyası olmayan `ok` satırlar silinir (yedek
 *    anından sonra döndürmeyle silinmiş dosyalar). Klasör yoksa (ör. takılı olmayan harici disk) satıra dokunulmaz.
 * Taranan klasörler: varsayılan klasör, ayarlı klasör ve satırlarda geçen klasörler. Desen dışı dosyaya dokunulmaz.
 */

const PART_RE = /^universal-mail-.+\.umbk\.part$/;

export interface ReconcileReport {
  added: number;
  recovered: number;
  interrupted: number;
  removed: number;
  partsRemoved: number;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir: string, re: RegExp): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (!re.test(n)) return false;
    try {
      return fs.lstatSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Dosyanın başlığı ve boyutu; desen dışı / okunamayan / bozuk başlıkta null. */
async function describe(
  file: string,
): Promise<{ meta: BackupMeta; size: number; sha256: string; mtime: number } | null> {
  try {
    const h = readBackupHeader(file);
    const st = fs.statSync(file);
    return { meta: h.meta, size: h.size, sha256: await sha256File(file), mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Yedek klasörleri (mutlak, tekil): varsayılan, ayarlı ve satırlarda geçenler. */
export async function knownBackupFolders(db: Db): Promise<string[]> {
  const set = new Set<string>([path.resolve(backupsDir())]);
  const configured = await getSetting(db, "backup.folder").catch(() => null);
  if (configured && path.isAbsolute(configured)) set.add(path.resolve(configured));
  const rows = await db.selectDistinct({ folder: backups.folder }).from(backups);
  for (const r of rows) if (path.isAbsolute(r.folder)) set.add(path.resolve(r.folder));
  return [...set];
}

export async function reconcileBackups(
  db: Db,
  o: { now: number; pruneMissing: boolean },
): Promise<ReconcileReport> {
  const rep: ReconcileReport = {
    added: 0,
    recovered: 0,
    interrupted: 0,
    removed: 0,
    partsRemoved: 0,
  };
  fs.rmSync(path.join(dataDir(), WORK_DIR), { recursive: true, force: true });
  const folders = await knownBackupFolders(db);

  for (const folder of folders)
    for (const n of listFiles(folder, PART_RE)) {
      try {
        fs.rmSync(path.join(folder, n), { force: true });
        rep.partsRemoved++;
      } catch {
        /* sonraki açılışta yeniden denenir */
      }
    }

  const rows = await db.select().from(backups);
  for (const r of rows) {
    const file = backupFilePath(r);
    if (r.status === "running") {
      const d = file ? await describe(file) : null;
      if (d) {
        await db
          .update(backups)
          .set({
            status: "ok",
            errorCode: null,
            sizeBytes: d.size,
            sha256: d.sha256,
            schemaMigrations: d.meta.schemaMigrations,
            includesSecrets: d.meta.includesSecrets,
            finishedAt: Math.round(d.mtime),
          })
          .where(eq(backups.id, r.id));
        rep.recovered++;
      } else {
        await db
          .update(backups)
          .set({ status: "failed", errorCode: "INTERRUPTED", finishedAt: o.now })
          .where(eq(backups.id, r.id));
        rep.interrupted++;
      }
    } else if (o.pruneMissing && r.status === "ok" && file && isDir(r.folder)) {
      if (!fs.existsSync(file)) {
        await db.delete(backups).where(eq(backups.id, r.id));
        rep.removed++;
      }
    }
  }

  const listed = new Set(
    (await db.select({ name: backups.fileName }).from(backups)).map((r) => r.name),
  );
  for (const folder of folders)
    for (const n of listFiles(folder, BACKUP_FILE_NAME_RE)) {
      if (listed.has(n)) continue;
      const d = await describe(path.join(folder, n));
      if (!d) continue;
      await db
        .insert(backups)
        .values({
          kind: d.meta.kind,
          status: "ok",
          fileName: n,
          folder,
          sizeBytes: d.size,
          sha256: d.sha256,
          appVersion: d.meta.appVersion,
          schemaMigrations: d.meta.schemaMigrations,
          includesSecrets: d.meta.includesSecrets,
          createdAt: d.meta.createdAt,
          finishedAt: Math.round(d.mtime),
        })
        .onConflictDoNothing();
      listed.add(n);
      rep.added++;
    }
  return rep;
}
