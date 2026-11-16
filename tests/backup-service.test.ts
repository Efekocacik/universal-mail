import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleError } from "@/lib/backup/errors";
import { decryptBackup } from "@/lib/backup/format";
import {
  backupBaseName,
  backupFileForDownload,
  backupFilePath,
  backupOverview,
  BackupNotFoundError,
  classifyBackupError,
  createBackup,
  deleteBackup,
  listBackups,
  pruneFailed,
  setBackupPassphrase,
  updateBackupSettings,
  validateBackupFolder,
} from "@/lib/backup/service";
import { lastSuccessfulBackup } from "@/lib/backup/shared";
import { toLibsqlUrl } from "@/lib/config/paths";
import { auditLog, backups } from "@/lib/db/schema";
import { BACKUP_PASSPHRASE_SECRET, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { backupEnv, insertLead, TEST_PASS, type BackupEnv } from "./helpers/backup-env";

/**
 * Paket Y.2: yedek servisi gerçek SQLite dosyasıyla (geçici klasör). Tek süren yedek, yarım kalan yedeğin kurtarılması,
 * döndürme, klasör doğrulaması (göreli, yok, dosya, uygulama klasörü, sembolik bağlantı, yazılamaz), disk dolu benzetimi,
 * eşzamanlı yazma altında tutarlı anlık görüntü ve gizli bilgilerin yedeğe girmesi.
 */

let env: BackupEnv;
const T = Date.UTC(2026, 10, 16, 9, 0, 0);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof LifecycleError ? e.code : `OTHER:${(e as Error).message}`;
  }
};

beforeEach(async () => {
  env = await backupEnv();
  await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
});
afterEach(async () => {
  await env.done();
});

describe("yedek oluşturma", () => {
  it("parola yoksa BACKUP_PASSPHRASE_REQUIRED; hiçbir satır yazılmaz", async () => {
    fs.rmSync(path.join(env.dir, "secrets.json"), { force: true });
    expect(await code(createBackup(env.db, { kind: "manual", now: T }))).toBe(
      "BACKUP_PASSPHRASE_REQUIRED",
    );
    expect(await env.db.select().from(backups)).toHaveLength(0);
  });

  it("şifreli dosya yazılır, satır ok olur (boyut + özet dosyayla tutar), içerik parolayla açılır ve gizli bilgiler taşınır", async () => {
    const raw = env.raw();
    await insertLead(raw, { createdAt: T, name: "Kafe Yedek" });
    await setSecret("google.placesKey", "AIza-test-anahtar");
    const r = await createBackup(env.db, { kind: "manual", now: T });
    expect(r.backup.status).toBe("ok");
    expect(r.backup.fileName).toBe(`${backupBaseName("manual", T)}.umbk`);
    expect(r.backup.folder).toBe(path.join(env.dir, "backups"));
    expect(r.backup.fileExists).toBe(true);
    expect(r.backup.includesSecrets).toBe(true);
    expect(r.backup.schemaMigrations).toBeGreaterThanOrEqual(7);
    const file = backupFilePath(r.backup)!;
    const bytes = fs.readFileSync(file);
    expect(r.backup.sizeBytes).toBe(bytes.length);
    expect(r.backup.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
    // Geçici anlık görüntü kalmaz.
    expect(fs.readdirSync(path.join(env.dir, "backup-tmp"))).toEqual([]);
    const out = path.join(env.dir, "check.db");
    const d = await decryptBackup({ file, passphrase: TEST_PASS, outDbFile: out });
    expect(d.manifest.secrets).toEqual({ "google.placesKey": "AIza-test-anahtar" });
    expect(d.manifest.secrets?.[BACKUP_PASSPHRASE_SECRET]).toBeUndefined();
    const c = createClient({ url: toLibsqlUrl(out) });
    const n = await c.execute("SELECT display_name FROM leads");
    c.close();
    expect(n.rows.map((x) => x.display_name)).toEqual(["Kafe Yedek"]);
    // Google oturum önbelleği (gcache) yedeğe girmez.
    const c2 = createClient({ url: toLibsqlUrl(out) });
    const t2 = await c2.execute("SELECT name FROM sqlite_master WHERE name = 'place_cache'");
    c2.close();
    expect(t2.rows).toHaveLength(0);
    expect(await lastSuccessfulBackup(env.db)).toEqual({ at: r.backup.finishedAt, kind: "manual" });
    const a = await env.db.select().from(auditLog).where(eq(auditLog.action, "backup.create"));
    expect(a[0]!.detail).toMatchObject({ kind: "manual", ok: true, includesSecrets: true });
    expect(JSON.stringify(a)).not.toContain("AIza");
  });

  it("includeSecrets=false gizli bilgileri yedeğe koymaz", async () => {
    await setSecret("google.placesKey", "AIza-test-anahtar");
    const r = await createBackup(env.db, { kind: "manual", now: T, includeSecrets: false });
    const out = path.join(env.dir, "check.db");
    const d = await decryptBackup({
      file: backupFilePath(r.backup)!,
      passphrase: TEST_PASS,
      outDbFile: out,
    });
    expect(d.manifest.secrets).toBeUndefined();
    expect(r.backup.includesSecrets).toBe(false);
  });

  it("aynı anda tek yedek: süren satır varken BACKUP_IN_PROGRESS; 30 dakikadan eski süren satır INTERRUPTED olur", async () => {
    await env.db.insert(backups).values({
      kind: "manual",
      status: "running",
      fileName: "universal-mail-20261116-085000-manual.umbk",
      folder: env.dir,
      appVersion: "0.1.0",
      schemaMigrations: 7,
      createdAt: T - 10 * 60_000,
    });
    expect(await code(createBackup(env.db, { kind: "manual", now: T }))).toBe("BACKUP_IN_PROGRESS");
    const r = await createBackup(env.db, { kind: "manual", now: T + 31 * 60_000 });
    expect(r.backup.status).toBe("ok");
    const old = (await env.db.select().from(backups).where(eq(backups.status, "failed")))[0]!;
    expect(old.errorCode).toBe("INTERRUPTED");
  });

  it("aynı saniyede iki yedek: ikinci dosya -2 ekiyle adlanır", async () => {
    const a = await createBackup(env.db, { kind: "manual", now: T });
    const b = await createBackup(env.db, { kind: "manual", now: T });
    expect(b.backup.fileName).toBe(a.backup.fileName.replace(".umbk", "-2.umbk"));
  });

  it("döndürme: en yeni keepStartup açılış yedeği kalır, eskilerin dosyası silinir; elle alınanlara dokunulmaz", async () => {
    await setSetting(env.db, "backup.schedule", {
      ...(await getSetting(env.db, "backup.schedule")),
      keepStartup: 2,
    });
    const manual = await createBackup(env.db, { kind: "manual", now: T });
    const made = [];
    for (let i = 0; i < 4; i++)
      made.push(await createBackup(env.db, { kind: "startup", now: T + i * 86_400_000 }));
    const rows = await listBackups(env.db);
    expect(rows.filter((r) => r.kind === "startup").map((r) => r.id)).toEqual([
      made[3]!.backup.id,
      made[2]!.backup.id,
    ]);
    expect(fs.existsSync(backupFilePath(made[0]!.backup)!)).toBe(false);
    expect(fs.existsSync(backupFilePath(made[3]!.backup)!)).toBe(true);
    expect(rows.some((r) => r.id === manual.backup.id && r.fileExists)).toBe(true);
  });

  it("disk dolu (yazıcı ENOSPC) → BACKUP_DISK_FULL; satır failed + kod, .part kalmaz", async () => {
    const createWriter = (file: string) => {
      fs.writeFileSync(file, "yarım");
      return new Writable({
        write(_c, _e, cb) {
          cb(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
        },
      });
    };
    expect(await code(createBackup(env.db, { kind: "manual", now: T }, { createWriter }))).toBe(
      "BACKUP_DISK_FULL",
    );
    const [row] = await env.db.select().from(backups);
    expect(row).toMatchObject({ status: "failed", errorCode: "BACKUP_DISK_FULL" });
    expect(
      fs.readdirSync(path.join(env.dir, "backups")).filter((f) => f.endsWith(".part")),
    ).toEqual([]);
    // Başarısız satır bir sonraki yedeği engellemez.
    expect((await createBackup(env.db, { kind: "manual", now: T + 1000 })).backup.status).toBe(
      "ok",
    );
    expect(classifyBackupError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      "BACKUP_FOLDER_UNWRITABLE",
    );
    expect(classifyBackupError(new Error("SQLITE_FULL: database or disk is full"))).toBe(
      "BACKUP_DISK_FULL",
    );
    expect(classifyBackupError(new Error("x"))).toBe("BACKUP_FAILED");
  });

  it("eşzamanlı yazmalar sürerken anlık görüntü tutarlıdır (bütünlük ok, satır sayısı önce/sonra arasında)", async () => {
    const writer = env.raw();
    await writer.execute("PRAGMA busy_timeout = 8000");
    for (let i = 0; i < 200; i++) await insertLead(writer, { createdAt: T, name: `Önce ${i}` });
    let stop = false;
    let written = 0;
    const loop = (async () => {
      while (!stop) {
        await insertLead(writer, { createdAt: T, name: `Sırada ${written}` });
        written++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const r = await createBackup(env.db, { kind: "manual", now: T });
    stop = true;
    await loop;
    const out = path.join(env.dir, "check.db");
    await decryptBackup({ file: backupFilePath(r.backup)!, passphrase: TEST_PASS, outDbFile: out });
    const c = createClient({ url: toLibsqlUrl(out) });
    expect(String((await c.execute("PRAGMA integrity_check")).rows[0]![0])).toBe("ok");
    const n = Number((await c.execute("SELECT COUNT(*) FROM leads")).rows[0]![0]);
    c.close();
    expect(n).toBeGreaterThanOrEqual(200);
    expect(n).toBeLessThanOrEqual(200 + written);
  });

  it("30 günden eski başarısız satırlar budanır", async () => {
    await env.db.insert(backups).values({
      kind: "startup",
      status: "failed",
      errorCode: "BACKUP_FAILED",
      fileName: "universal-mail-20261001-080000-startup.umbk",
      folder: env.dir,
      appVersion: "0.1.0",
      schemaMigrations: 7,
      createdAt: T - 31 * 86_400_000,
    });
    expect(await pruneFailed(env.db, T)).toBe(1);
  });
});

describe("yedek klasörü", () => {
  it("göreli, olmayan, dosya ve uygulama klasörü içi BACKUP_FOLDER_INVALID; geçerli klasörün gerçek yolu saklanır", () => {
    const c = (f: () => unknown) => {
      try {
        f();
        return "OK";
      } catch (e) {
        return (e as LifecycleError).code;
      }
    };
    expect(c(() => validateBackupFolder("göreli/klasör"))).toBe("BACKUP_FOLDER_INVALID");
    expect(c(() => validateBackupFolder(path.join(env.dir, "yok")))).toBe("BACKUP_FOLDER_INVALID");
    const file = path.join(env.dir, "dosya.txt");
    fs.writeFileSync(file, "x");
    expect(c(() => validateBackupFolder(file))).toBe("BACKUP_FOLDER_INVALID");
    expect(c(() => validateBackupFolder(path.resolve(__dirname, "..", "drizzle")))).toBe(
      "BACKUP_FOLDER_INVALID",
    );
    expect(c(() => validateBackupFolder(`/${"a".repeat(1100)}`))).toBe("BACKUP_FOLDER_INVALID");
    const real = path.join(env.dir, "harici");
    fs.mkdirSync(real);
    const link = path.join(env.dir, "kisayol");
    fs.symlinkSync(real, link);
    expect(validateBackupFolder(link)).toBe(fs.realpathSync(real));
    expect(fs.readdirSync(real)).toEqual([]); // yazma denemesi iz bırakmaz
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "yazılamayan klasör BACKUP_FOLDER_UNWRITABLE",
    () => {
      const ro = path.join(env.dir, "salt-okunur");
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o500);
      try {
        expect(() => validateBackupFolder(ro)).toThrow(/yazılamıyor/);
      } finally {
        fs.chmodSync(ro, 0o700);
      }
    },
  );

  it("ayarlar: özel klasöre yazılır, satır klasörü hatırlar; klasör sonradan silinirse BACKUP_FOLDER_UNWRITABLE", async () => {
    const ext = path.join(env.dir, "harici");
    fs.mkdirSync(ext);
    const s = await getSetting(env.db, "backup.schedule");
    const res = await updateBackupSettings(env.db, { ...s, keepWeekly: 6, folder: ext });
    expect(res.folder).toBe(fs.realpathSync(ext));
    expect((await getSetting(env.db, "backup.schedule")).keepWeekly).toBe(6);
    const r = await createBackup(env.db, { kind: "manual", now: T });
    expect(r.backup.folder).toBe(fs.realpathSync(ext));
    expect(fs.existsSync(path.join(fs.realpathSync(ext), r.backup.fileName))).toBe(true);
    const ov = await backupOverview(env.db);
    expect(ov.folderIsDefault).toBe(false);
    fs.rmSync(path.join(fs.realpathSync(ext), r.backup.fileName));
    fs.rmdirSync(ext);
    expect(await code(createBackup(env.db, { kind: "manual", now: T + 5000 }))).toBe(
      "BACKUP_FOLDER_UNWRITABLE",
    );
    const reset = await updateBackupSettings(env.db, { ...s, folder: null });
    expect(reset.folder).toBeNull();
    expect((await backupOverview(env.db)).folderIsDefault).toBe(true);
  });
});

describe("silme, indirme, parola", () => {
  it("silme: dosya ve satır gider; dosya yoksa da satır gider; süren yedek silinmez; bilinmeyen kimlik bulunamaz", async () => {
    const a = await createBackup(env.db, { kind: "manual", now: T });
    const f = backupFilePath(a.backup)!;
    expect((await backupFileForDownload(env.db, a.backup.id)).size).toBe(fs.statSync(f).size);
    await deleteBackup(env.db, a.backup.id);
    expect(fs.existsSync(f)).toBe(false);
    expect(await listBackups(env.db)).toEqual([]);
    const b = await createBackup(env.db, { kind: "manual", now: T + 1000 });
    fs.rmSync(backupFilePath(b.backup)!);
    expect((await listBackups(env.db))[0]!.fileExists).toBe(false);
    expect(await code(backupFileForDownload(env.db, b.backup.id))).toBe("BACKUP_FILE_MISSING");
    await deleteBackup(env.db, b.backup.id);
    await expect(deleteBackup(env.db, 999)).rejects.toBeInstanceOf(BackupNotFoundError);
    const [run] = await env.db
      .insert(backups)
      .values({
        kind: "manual",
        status: "running",
        fileName: "universal-mail-20261116-090500-manual.umbk",
        folder: env.dir,
        appVersion: "0.1.0",
        schemaMigrations: 7,
        createdAt: T,
      })
      .returning();
    expect(await code(deleteBackup(env.db, run!.id))).toBe("BACKUP_IN_PROGRESS");
    expect(backupFilePath({ folder: env.dir, fileName: "../kaçış.umbk" })).toBeNull();
    expect(
      backupFilePath({ folder: "göreli", fileName: "universal-mail-20261116-090500-manual.umbk" }),
    ).toBeNull();
  });

  it("parola: kural ve eşleşme denetlenir, kırpılmış değer saklanır, denetim kaydında değer yok", async () => {
    expect(await code(setBackupPassphrase(env.db, { passphrase: "kısa", confirm: "kısa" }))).toBe(
      "BACKUP_PASSPHRASE_WEAK",
    );
    expect(
      await code(
        setBackupPassphrase(env.db, { passphrase: "yeni-parola-12", confirm: "yeni-parola-13" }),
      ),
    ).toBe("BACKUP_PASSPHRASE_MISMATCH");
    await setBackupPassphrase(env.db, {
      passphrase: " yeni-parola-12 ",
      confirm: "yeni-parola-12",
    });
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBe("yeni-parola-12");
    const rows = await env.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "backup.passphrase.set"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("yeni-parola");
  });
});
