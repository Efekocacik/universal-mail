import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAutoBackupHandler } from "@/lib/backup/auto";
import {
  pruneExpiredStages,
  readStage,
  scheduleRestore,
  verifyAndStage,
} from "@/lib/backup/restore";
import { backupFilePath, createBackup, listBackups } from "@/lib/backup/service";
import { executeErasure } from "@/lib/compliance/erasure";
import { hashEmail, SUPPRESSION_HASH_ALG } from "@/lib/compliance/suppression";
import {
  auditLog,
  backups,
  campaignLeads,
  campaigns,
  leadEmails,
  leads,
  messages,
  suppressions,
} from "@/lib/db/schema";
import {
  createPending,
  newNonce,
  readPending,
  readResult,
  stagingRoot,
} from "@/lib/lifecycle/pending";
import { runPostInitHooks, runPreInitHooks } from "@/lib/lifecycle/pre-init";
import { scheduleWipe } from "@/lib/lifecycle/service";
import { BACKUP_PASSPHRASE_SECRET, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { pauseReasonText } from "@/features/campaigns/model";
import { backupEnv, TEST_PASS, type BackupEnv } from "./helpers/backup-env";
import { addSequence, createCampaign, DEMO_MAILBOX, seedBase } from "./helpers/campaign-fixture";

/**
 * İnceleme düzeltmeleri (paket Y): geri yükleme yedeğin anındaki gönderim durumunu geri getirir. Kampanyalar duraklar,
 * yedekten sonra eklenen engel kayıtları ve silme talepleri korunur, yedekten sonra yazılmış alıcılara aynı adım
 * yeniden gitmez; yedek listesi diskle eşitlenir; yarım kalan yedek ve hazırlıklar açılışta temizlenir.
 */

const T = Date.UTC(2026, 10, 16, 9, 0, 0);
let env: BackupEnv;
const logs: string[] = [];
const log = (m: string) => logs.push(m);

async function restart(now = T + 60_000) {
  await env.close();
  const pre = await runPreInitHooks({ dataDir: env.dir, log, now });
  await env.reopen();
  await runPostInitHooks(env.db, pre, { dataDir: env.dir, log, now });
  return pre;
}

beforeEach(async () => {
  logs.length = 0;
  env = await backupEnv();
  await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
});
afterEach(async () => {
  await env.done();
});

async function sentMessage(to: string, at: number) {
  await env.db.insert(messages).values({
    direction: "out",
    purpose: "test",
    mailboxId: DEMO_MAILBOX,
    toAddress: to,
    peerHash: hashEmail(to),
    peerDomain: to.split("@")[1]!,
    status: "sent",
    createdAt: at,
  } as typeof messages.$inferInsert);
}

describe("geri yükleme sonrası güvenlik", () => {
  it("çalışan kampanya duraklar; yeni çıkış/silme talebi korunur; yedekten sonra yazılan alıcıya aynı adım gitmez; liste diskle eşitlenir", async () => {
    await seedBase(env.db, T);
    const cid = await createCampaign(env.db);
    const a = await addSequence(env.db, cid, { email: "info@yazildi.example" });
    const b = await addSequence(env.db, cid, { email: "info@cikti.example" });
    const e = await addSequence(env.db, cid, { email: "info@silindi.example" });
    const c = await addSequence(env.db, cid, { email: "info@bekliyor.example" });

    const first = await createBackup(env.db, { kind: "manual", now: T });
    const file = backupFilePath(first.backup)!;

    // Yedekten SONRA: a'ya e-posta gitti, b listeden çıktı, e silme talebinde bulundu; ikinci yedek alındı.
    await sentMessage(a.email, T + 1_000);
    await env.db.insert(suppressions).values({
      scope: "email",
      emailHash: hashEmail(b.email),
      hashAlg: SUPPRESSION_HASH_ALG,
      emailMasked: "i***@cikti.example",
      domain: "cikti.example",
      reason: "unsubscribe",
      source: "link",
      addedAt: T + 2_000,
    });
    await executeErasure(
      env.db,
      {
        email: e.email,
        requestedAt: T + 2_500,
        justification: "Kişi e-postayla silme talebinde bulundu.",
        confirm: true,
      },
      { now: T + 3_000 },
    );
    const second = await createBackup(env.db, { kind: "manual", now: T + 4_000 });

    // Eski yedeği geri yükle.
    const v = await verifyAndStage(env.db, {
      source: { kind: "path", path: file },
      passphrase: TEST_PASS,
      now: T + 5_000,
    });
    const sched = await scheduleRestore(env.db, {
      stageId: v.stageId,
      confirm: true,
      restoreSecrets: false,
      now: T + 5_000,
    });
    expect(sched.safetyBackup).toBe(true);
    const pre = await restart(T + 60_000);
    expect(pre.applied).toEqual({ kind: "restore", ok: true });

    // 1. Kampanya duraklatıldı (gerekçe arayüzde okunur).
    const [camp] = await env.db.select().from(campaigns).where(eq(campaigns.id, cid));
    expect(camp).toMatchObject({ status: "paused", pauseReason: "restore", pausedAt: T + 60_000 });
    expect(pauseReasonText(camp!.pauseReason)).not.toBe("restore");

    // 2. Yedekten sonraki çıkış ve silme engelleri korundu.
    const sups = await env.db.select().from(suppressions);
    expect(sups.map((s) => [s.emailHash, s.reason, s.liftedAt]).sort()).toEqual(
      [
        [hashEmail(b.email), "unsubscribe", null],
        [hashEmail(e.email), "erasure", null],
      ].sort(),
    );

    // 3. Silme talebi yeniden uygulandı: adres yok, işletme "iletişim kurma", dizi iptal; denetim kaydı aktarıldı.
    const restoredEmails = (await env.db.select().from(leadEmails)).map((r) => r.email);
    expect(restoredEmails).not.toContain(e.email);
    expect(restoredEmails).toContain(a.email);
    const [eLead] = await env.db.select().from(leads).where(eq(leads.id, e.leadId));
    expect(eLead!.status).toBe("do_not_contact");
    const seq = new Map((await env.db.select().from(campaignLeads)).map((r) => [r.id, r] as const));
    expect(seq.get(e.cl)!.status).toBe("cancelled");
    expect(seq.get(e.cl)!.recipientEmail).toBeNull(); // yer tutucuya çevrildi
    const audits = (await env.db.select().from(auditLog)).map((r) => r.action);
    expect(audits).toContain("erasure.executed");

    // 4. Yedekten sonra yazılan alıcının dizisi durdu; diğerleri bekliyor (b gönderimde engelle elenir).
    expect(seq.get(a.cl)!.status).toBe("cancelled");
    expect(seq.get(b.cl)!.status).toBe("scheduled");
    expect(seq.get(c.cl)!.status).toBe("scheduled");

    // Sonuç bandı sayıları.
    expect(readResult(env.dir)).toMatchObject({
      kind: "restore",
      ok: true,
      campaignsPaused: 1,
      suppressionsKept: 2,
      sequencesStopped: 2,
    });
    expect(readResult(env.dir)!.folderReset).toBeUndefined();

    // 5. Liste diskle eşit: geri yüklenen yedek "ok" (Başarısız değil), sonraki yedek ve güvenlik yedeği listede.
    const list = await listBackups(env.db);
    expect(list.every((r) => r.status === "ok" && r.fileExists)).toBe(true);
    expect(list.map((r) => r.fileName)).toEqual(
      expect.arrayContaining([first.backup.fileName, second.backup.fileName]),
    );
    expect(list).toHaveLength(3);
    // Hazırlık klasörü kalmadı.
    expect(fs.existsSync(stagingRoot(env.dir))).toBe(false);

    // Kişisel veri günlüğe yazılmadı.
    expect(logs.join("\n")).not.toContain("example");
  });

  it("yedekteki özel klasör bu bilgisayarda yoksa varsayılana dönülür ve bantta söylenir", async () => {
    const custom = fs.mkdtempSync(path.join(env.dir, "harici-"));
    await setSetting(env.db, "backup.folder", custom);
    const made = await createBackup(env.db, { kind: "manual", now: T });
    const moved = path.join(env.dir, made.backup.fileName);
    fs.copyFileSync(backupFilePath(made.backup)!, moved);
    fs.rmSync(custom, { recursive: true, force: true }); // disk çıkarıldı / başka bilgisayar
    await setSetting(env.db, "backup.folder", null);
    const v = await verifyAndStage(env.db, {
      source: { kind: "path", path: moved },
      passphrase: TEST_PASS,
      now: T,
    });
    await scheduleRestore(env.db, {
      stageId: v.stageId,
      confirm: true,
      restoreSecrets: false,
      now: T,
    });
    await restart();
    expect(await getSetting(env.db, "backup.folder")).toBeNull();
    expect(readResult(env.dir)).toMatchObject({ kind: "restore", ok: true, folderReset: true });
    // Anlık görüntüdeki kendi satırı (`running`) dosyası kayıtlı yerde olmadığı için yarım kalmış sayılır; satırlar
    // klasörü yok diye silinmez (takılı olmayan disk olabilir).
    const row = (await listBackups(env.db)).find((r) => r.fileName === made.backup.fileName);
    expect(row).toMatchObject({ status: "failed", errorCode: "INTERRUPTED", fileExists: false });
  });
});

describe("açılışta yedek temizliği", () => {
  it("yarım kalan yedek: satır INTERRUPTED, .part ve backup-tmp silinir; biten ama güncellenemeyen yedek ok olur; listede olmayan dosya eklenir", async () => {
    const done = await createBackup(env.db, { kind: "weekly", now: T });
    // Kapanış anı benzetimi: satır `running` kaldı ama dosya yazılmıştı.
    await env.db.update(backups).set({ status: "running" }).where(eq(backups.id, done.backup.id));
    const folder = done.backup.folder;
    fs.writeFileSync(path.join(folder, "universal-mail-20261116-100000-manual.umbk.part"), "yarım");
    fs.mkdirSync(path.join(env.dir, "backup-tmp", "w-1"), { recursive: true });
    fs.writeFileSync(path.join(env.dir, "backup-tmp", "w-1", "snapshot.db"), "düz kopya");
    // Listede olmayan geçerli yedek (ör. "yedekler kalsın" ile silinen verilerden kalan) ve bozuk dosya.
    const extra = path.join(folder, "universal-mail-20261110-080000-startup.umbk");
    fs.copyFileSync(backupFilePath(done.backup)!, extra);
    fs.writeFileSync(path.join(folder, "universal-mail-20261111-080000-startup.umbk"), "bozuk");

    await restart();
    const rows = await listBackups(env.db);
    expect(rows.find((r) => r.id === done.backup.id)).toMatchObject({
      status: "ok",
      fileExists: true,
      sha256: done.backup.sha256,
    });
    const added = rows.find((r) => r.fileName === path.basename(extra));
    expect(added).toMatchObject({ status: "ok", kind: "weekly", createdAt: T, fileExists: true });
    expect(rows).toHaveLength(2); // bozuk dosya listelenmez
    expect(fs.readdirSync(folder).some((f) => f.endsWith(".part"))).toBe(false);
    expect(fs.existsSync(path.join(env.dir, "backup-tmp"))).toBe(false);

    // Dosyası olmayan yarım satır: INTERRUPTED; "Şimdi yedekle" hemen kullanılabilir.
    await env.db.insert(backups).values({
      kind: "startup",
      status: "running",
      fileName: "universal-mail-20261116-110000-startup.umbk",
      folder,
      appVersion: "0.1.0",
      schemaMigrations: 7,
      createdAt: T + 1_000,
    });
    await restart(T + 2_000);
    const stuck = (await listBackups(env.db)).find(
      (r) => r.fileName === "universal-mail-20261116-110000-startup.umbk",
    );
    expect(stuck).toMatchObject({ status: "failed", errorCode: "INTERRUPTED" });
    await expect(createBackup(env.db, { kind: "manual", now: T + 3_000 })).resolves.toBeTruthy();
  });

  it("planlanmamış hazırlıklar açılışta silinir; çalışırken süresi dolanlar bakımda silinir, bekleyen geri yüklemeninki kalır", async () => {
    await createBackup(env.db, { kind: "manual", now: T });
    const [row] = await env.db.select().from(backups);
    const v1 = await verifyAndStage(env.db, {
      source: { kind: "backup", id: row!.id },
      passphrase: TEST_PASS,
      now: T,
    });
    expect(readStage(env.dir, v1.stageId)).not.toBeNull();
    await restart(); // planlanmadı → silinir
    expect(fs.existsSync(stagingRoot(env.dir))).toBe(false);

    const v2 = await verifyAndStage(env.db, {
      source: { kind: "backup", id: row!.id },
      passphrase: TEST_PASS,
      now: T,
    });
    expect(pruneExpiredStages(env.dir, T + 60_000)).toBe(0); // süresi dolmadı
    expect(pruneExpiredStages(env.dir, T + 2 * 3_600_000)).toBe(1);
    expect(readStage(env.dir, v2.stageId)).toBeNull();

    const v3 = await verifyAndStage(env.db, {
      source: { kind: "backup", id: row!.id },
      passphrase: TEST_PASS,
      now: T,
    });
    fs.mkdirSync(path.join(stagingRoot(env.dir), "tanimsiz"), { recursive: true });
    createPending(env.dir, {
      v: 1,
      kind: "restore",
      stageId: v3.stageId,
      restoreSecrets: false,
      at: T,
      nonce: newNonce(),
    });
    expect(pruneExpiredStages(env.dir, T + 2 * 3_600_000)).toBe(1); // yalnızca tanımsız klasör
    expect(readStage(env.dir, v3.stageId)).not.toBeNull();
    expect(readPending(env.dir)).toMatchObject({ stageId: v3.stageId });
  });

  it("otomatik yedek başka yedek sürerken yeniden denenir; açılıştan sonra kilit kalmaz", async () => {
    await env.db.insert(backups).values({
      kind: "manual",
      status: "running",
      fileName: "universal-mail-20261116-085900-manual.umbk",
      folder: path.join(env.dir, "backups"),
      appVersion: "0.1.0",
      schemaMigrations: 7,
      createdAt: T - 60_000,
    });
    await restart();
    const ctx = {
      db: env.db,
      payload: { reason: "startup" as const },
      log: () => undefined,
    } as unknown as Parameters<ReturnType<typeof makeAutoBackupHandler>>[0];
    await makeAutoBackupHandler({}, () => T + 120_000)(ctx);
    const ok = (await listBackups(env.db)).filter((r) => r.status === "ok");
    expect(ok.map((r) => r.kind)).toEqual(["startup"]);
  });
});

describe("tüm verilerimi sil", () => {
  it("işarete yedek satırlarında geçen eski klasörler de yazılır (varsayılan ve ayarlı klasör hariç, en çok 20)", async () => {
    const oldFolder = fs.mkdtempSync(path.join(env.dir, "eski-"));
    const nowFolder = fs.mkdtempSync(path.join(env.dir, "simdi-"));
    await setSetting(env.db, "backup.folder", oldFolder);
    await createBackup(env.db, { kind: "manual", now: T });
    await setSetting(env.db, "backup.folder", nowFolder);
    await createBackup(env.db, { kind: "manual", now: T + 1_000 });
    await setSetting(env.db, "backup.folder", null);
    await createBackup(env.db, { kind: "manual", now: T + 2_000 });
    await setSetting(env.db, "backup.folder", nowFolder);
    await scheduleWipe(env.db, { confirm: "VERİLERİMİ SİL", deleteBackups: true, now: T });
    expect(readPending(env.dir)).toMatchObject({
      kind: "wipe",
      customBackupFolder: nowFolder,
      customBackupFolders: [oldFolder],
    });
    await restart();
    expect(fs.readdirSync(oldFolder)).toEqual([]);
    expect(fs.readdirSync(nowFolder)).toEqual([]);
  });
});
