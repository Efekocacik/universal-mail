import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as listRouteMod from "@/app/api/backups/route";
import * as itemRouteMod from "@/app/api/backups/[id]/route";
import * as downloadRouteMod from "@/app/api/backups/[id]/download/route";
import * as settingsRouteMod from "@/app/api/backups/settings/route";
import * as passRouteMod from "@/app/api/backups/passphrase/route";
import * as verifyRouteMod from "@/app/api/backups/restore/verify/route";
import * as restoreRouteMod from "@/app/api/backups/restore/route";
import * as stageRouteMod from "@/app/api/backups/restore/[stageId]/route";
import * as retentionRouteMod from "@/app/api/data/retention/route";
import * as retentionRunRouteMod from "@/app/api/data/retention/run/route";
import * as wipeRouteMod from "@/app/api/data/wipe/route";
import * as pendingRouteMod from "@/app/api/data/pending/route";
import * as resultRouteMod from "@/app/api/data/result/route";
import { auditLog } from "@/lib/db/schema";
import { writeResult } from "@/lib/lifecycle/pending";
import { tr } from "@/lib/i18n/tr";
import { en } from "@/lib/i18n/en";
import { LIFECYCLE_ERROR_CODES } from "@/lib/backup/errors";
import { backupEnv, insertLead, TEST_PASS, type BackupEnv } from "./helpers/backup-env";

/** Rota işleyicileri bağlamsız da çağrılabilsin (bağlam kullanmayan uçlar). */
type LooseHandler = (req?: Request, ctx?: unknown) => Promise<Response>;
const loose = <T extends object>(m: T) =>
  m as unknown as Record<Exclude<keyof T, "dynamic">, LooseHandler>;
const listRoute = loose(listRouteMod);
const itemRoute = loose(itemRouteMod);
const downloadRoute = loose(downloadRouteMod);
const settingsRoute = loose(settingsRouteMod);
const passRoute = loose(passRouteMod);
const verifyRoute = loose(verifyRouteMod);
const restoreRoute = loose(restoreRouteMod);
const stageRoute = loose(stageRouteMod);
const retentionRoute = loose(retentionRouteMod);
const retentionRunRoute = loose(retentionRunRouteMod);
const wipeRoute = loose(wipeRouteMod);
const pendingRoute = loose(pendingRouteMod);
const resultRoute = loose(resultRouteMod);

/**
 * Paket Y.7: her uç (rota işleyicileri doğrudan çağrılır; Origin denetimi merkezi ara katmandadır). Başarı gövdeleri,
 * kodlu hatalar, denetim kayıtları ve parolanın hiçbir yanıtta/kayıtta görünmemesi.
 */

const ORIGIN = "http://127.0.0.1:3000";
let env: BackupEnv;
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  env = await backupEnv();
});
afterEach(async () => {
  await env.done();
});

async function setPass() {
  const r = await read(
    await passRoute.PUT(
      req("PUT", "/api/backups/passphrase", { passphrase: TEST_PASS, confirm: TEST_PASS }),
    ),
  );
  expect(r).toEqual({ status: 200, body: { passphraseSet: true } });
}

async function makeBackup() {
  const r = await read(await listRoute.POST(req("POST", "/api/backups", {})));
  expect(r.status).toBe(201);
  return r.body.backup as { id: number; fileName: string; folder: string };
}

describe("yedek uçları", () => {
  it("liste → parola → oluştur → indir → sil; hatalar kodlu, parola hiçbir yerde görünmez", async () => {
    let r = await read(await listRoute.GET());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      backups: [],
      passphraseSet: false,
      folderIsDefault: true,
      pending: null,
      lastResult: null,
      preMigrateCount: 0,
      schedule: {
        auto: true,
        onStartup: true,
        weekly: true,
        keepStartup: 7,
        keepWeekly: 4,
        includeSecrets: true,
      },
    });
    r = await read(await listRoute.POST(req("POST", "/api/backups", {})));
    expect(r).toMatchObject({ status: 400, body: { code: "BACKUP_PASSPHRASE_REQUIRED" } });
    r = await read(
      await passRoute.PUT(
        req("PUT", "/api/backups/passphrase", { passphrase: "kısa", confirm: "kısa" }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "BACKUP_PASSPHRASE_WEAK" } });
    r = await read(
      await passRoute.PUT(
        req("PUT", "/api/backups/passphrase", { passphrase: TEST_PASS, confirm: `${TEST_PASS}x` }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "BACKUP_PASSPHRASE_MISMATCH" } });
    r = await read(
      await passRoute.PUT(req("PUT", "/api/backups/passphrase", { passphrase: TEST_PASS })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    await setPass();
    r = await read(
      await listRoute.POST(req("POST", "/api/backups", { includeSecrets: true, extra: 1 })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    const b = await makeBackup();
    r = await read(await listRoute.GET());
    expect(r.body.passphraseSet).toBe(true);
    expect(r.body.backups).toHaveLength(1);
    expect(r.body.backups[0]).toMatchObject({
      id: b.id,
      status: "ok",
      fileExists: true,
      kind: "manual",
    });

    const dl = await downloadRoute.GET(
      req("GET", `/api/backups/${b.id}/download`),
      ctx({ id: String(b.id) }),
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="${b.fileName}"`);
    expect(dl.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("UMBACKUP");
    expect(Number(dl.headers.get("content-length"))).toBe(bytes.length);
    r = await read(
      await downloadRoute.GET(req("GET", "/api/backups/999/download"), ctx({ id: "999" })),
    );
    expect(r).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    r = await read(
      await downloadRoute.GET(req("GET", "/api/backups/x/download"), ctx({ id: "x" })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "INVALID_ID" } });
    fs.renameSync(path.join(b.folder, b.fileName), path.join(env.dir, "tasindi.umbk"));
    r = await read(
      await downloadRoute.GET(
        req("GET", `/api/backups/${b.id}/download`),
        ctx({ id: String(b.id) }),
      ),
    );
    expect(r).toMatchObject({ status: 410, body: { code: "BACKUP_FILE_MISSING" } });

    r = await read(
      await itemRoute.DELETE(req("DELETE", `/api/backups/${b.id}`), ctx({ id: String(b.id) })),
    );
    expect(r).toEqual({ status: 200, body: { deleted: true } });
    r = await read(
      await itemRoute.DELETE(req("DELETE", `/api/backups/${b.id}`), ctx({ id: String(b.id) })),
    );
    expect(r).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });

    const audits = (await env.db.select().from(auditLog)).map((a) => a.action);
    for (const a of ["backup.passphrase.set", "backup.create", "backup.download", "backup.delete"])
      expect(audits).toContain(a);
    expect(JSON.stringify(await env.db.select().from(auditLog))).not.toContain(TEST_PASS);
  });

  it("ayarlar: geçersiz klasör 400 BACKUP_FOLDER_INVALID; geçerli klasör kaydedilir; bilinmeyen alan VALIDATION", async () => {
    const base = {
      auto: true,
      onStartup: false,
      weekly: true,
      keepStartup: 3,
      keepWeekly: 8,
      includeSecrets: false,
    };
    let r = await read(
      await settingsRoute.PUT(req("PUT", "/api/backups/settings", { ...base, folder: "göreli" })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "BACKUP_FOLDER_INVALID" } });
    r = await read(
      await settingsRoute.PUT(req("PUT", "/api/backups/settings", { ...base, folder: null, x: 1 })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    r = await read(
      await settingsRoute.PUT(
        req("PUT", "/api/backups/settings", { ...base, keepStartup: 0, folder: null }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    const ext = path.join(env.dir, "harici");
    fs.mkdirSync(ext);
    r = await read(
      await settingsRoute.PUT(req("PUT", "/api/backups/settings", { ...base, folder: ext })),
    );
    expect(r).toEqual({ status: 200, body: { schedule: base, folder: fs.realpathSync(ext) } });
    r = await read(await listRoute.GET());
    expect(r.body).toMatchObject({
      schedule: base,
      folderIsDefault: false,
      folder: fs.realpathSync(ext),
    });
  });
});

describe("geri yükleme uçları", () => {
  it("listeden doğrula (yanlış/doğru parola) → planla (onay, süre, tekillik) → bekleyen → iptal", async () => {
    await setPass();
    await insertLead(env.raw(), { createdAt: Date.now(), name: "Kafe API" });
    const b = await makeBackup();
    let r = await read(
      await verifyRoute.POST(
        req("POST", "/api/backups/restore/verify", {
          backupId: b.id,
          passphrase: "yanlış-parola-9",
        }),
      ),
    );
    expect(r).toMatchObject({ status: 422, body: { code: "BACKUP_WRONG_PASSPHRASE" } });
    r = await read(
      await verifyRoute.POST(
        req("POST", "/api/backups/restore/verify", { backupId: 999, passphrase: TEST_PASS }),
      ),
    );
    expect(r).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    r = await read(
      await verifyRoute.POST(
        req("POST", "/api/backups/restore/verify", {
          backupId: b.id,
          path: "/x.umbk",
          passphrase: TEST_PASS,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    r = await read(
      await verifyRoute.POST(
        req("POST", "/api/backups/restore/verify", { backupId: b.id, passphrase: TEST_PASS }),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.summary.counts.leads).toBe(1);
    expect(r.body).toMatchObject({ migrationNeeded: false, hasSecrets: true });
    const stageId = r.body.stageId as string;

    r = await read(
      await restoreRoute.POST(
        req("POST", "/api/backups/restore", { stageId, confirm: false, restoreSecrets: true }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "RESTORE_CONFIRM_REQUIRED" } });
    r = await read(
      await restoreRoute.POST(
        req("POST", "/api/backups/restore", {
          stageId: "f".repeat(32),
          confirm: true,
          restoreSecrets: true,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 410, body: { code: "RESTORE_STAGE_NOT_FOUND" } });
    r = await read(
      await restoreRoute.POST(
        req("POST", "/api/backups/restore", {
          stageId: "../x",
          confirm: true,
          restoreSecrets: true,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    r = await read(
      await restoreRoute.POST(
        req("POST", "/api/backups/restore", { stageId, confirm: true, restoreSecrets: true }),
      ),
    );
    expect(r).toEqual({ status: 202, body: { restartRequired: true } });
    r = await read(
      await restoreRoute.POST(
        req("POST", "/api/backups/restore", { stageId, confirm: true, restoreSecrets: true }),
      ),
    );
    expect(r).toMatchObject({ status: 409, body: { code: "LIFECYCLE_PENDING" } });
    r = await read(
      await verifyRoute.POST(
        req("POST", "/api/backups/restore/verify", { backupId: b.id, passphrase: TEST_PASS }),
      ),
    );
    expect(r).toMatchObject({ status: 409, body: { code: "LIFECYCLE_PENDING" } });

    r = await read(await pendingRoute.GET());
    expect(r.body.pending).toMatchObject({ kind: "restore", stageId, restoreSecrets: true });
    r = await read(await listRoute.GET());
    expect(r.body.pending).toMatchObject({ kind: "restore" });
    r = await read(await pendingRoute.DELETE());
    expect(r).toEqual({ status: 200, body: { cancelled: true } });
    r = await read(await pendingRoute.DELETE());
    expect(r).toEqual({ status: 200, body: { cancelled: false } });
    r = await read(
      await stageRoute.DELETE(req("DELETE", `/api/backups/restore/${stageId}`), ctx({ stageId })),
    );
    expect(r).toEqual({ status: 200, body: { cancelled: true } });

    const audits = (await env.db.select().from(auditLog)).map((a) => a.action);
    for (const a of ["backup.restore.verify", "backup.restore.schedule", "data.pending.cancel"])
      expect(audits).toContain(a);
    expect(JSON.stringify(await env.db.select().from(auditLog))).not.toContain(TEST_PASS);
  });

  it("çok parçalı yükleme ile doğrulama; bildirilen boyut sınırı aşarsa 413; bozuk form 400", async () => {
    await setPass();
    const b = await makeBackup();
    const bytes = fs.readFileSync(path.join(b.folder, b.fileName));
    const form = new FormData();
    form.set("file", new Blob([bytes]), "yedek.umbk");
    form.set("passphrase", TEST_PASS);
    let r = await read(
      await verifyRoute.POST(
        new Request(`${ORIGIN}/api/backups/restore/verify`, { method: "POST", body: form }),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.stageId).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readdirSync(path.join(env.dir, "backup-tmp"))).toEqual([]); // yüklenen geçici dosya silindi
    const noPass = new FormData();
    noPass.set("file", new Blob([bytes]), "yedek.umbk");
    r = await read(
      await verifyRoute.POST(
        new Request(`${ORIGIN}/api/backups/restore/verify`, { method: "POST", body: noPass }),
      ),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    const big = new Request(`${ORIGIN}/api/backups/restore/verify`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(300 * 1024 * 1024),
      },
    });
    r = await read(await verifyRoute.POST(big));
    expect(r).toMatchObject({ status: 413, body: { code: "BACKUP_TOO_LARGE" } });
    // Yolda kesilmiş gövde (ara katman kopyalama sınırı): bildirilenden az bayt → "bozuk" değil, 413.
    const cut = new Request(`${ORIGIN}/api/backups/restore/verify`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "5000" },
      body: "--x\r\nkesik",
    });
    r = await read(await verifyRoute.POST(cut));
    expect(r).toMatchObject({ status: 413, body: { code: "BACKUP_TOO_LARGE" } });
  });
});

describe("veri uçları", () => {
  it("saklama: önizleme, ayar (yalnızca 1–12 ay), bayat önizleme 409, çalıştırma", async () => {
    const old = Date.now() - 800 * 86_400_000;
    await insertLead(env.raw(), { createdAt: old });
    await insertLead(env.raw(), { createdAt: old });
    let r = await read(await retentionRoute.GET());
    expect(r.body).toMatchObject({
      settings: { enabled: true, months: 12 },
      preview: { leads: 2 },
      lastRun: null,
    });
    r = await read(
      await retentionRoute.PUT(req("PUT", "/api/data/retention", { enabled: true, months: 24 })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    r = await read(
      await retentionRoute.PUT(req("PUT", "/api/data/retention", { enabled: true, months: 6 })),
    );
    expect(r).toMatchObject({
      status: 200,
      body: { settings: { enabled: true, months: 6 }, preview: { leads: 2 } },
    });
    r = await read(
      await retentionRunRoute.POST(req("POST", "/api/data/retention/run", { expectedMax: 1 })),
    );
    expect(r).toMatchObject({ status: 409, body: { code: "RETENTION_PREVIEW_STALE" } });
    r = await read(
      await retentionRunRoute.POST(req("POST", "/api/data/retention/run", { expectedMax: -1 })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    r = await read(
      await retentionRunRoute.POST(req("POST", "/api/data/retention/run", { expectedMax: 2 })),
    );
    expect(r).toMatchObject({ status: 200, body: { deleted: 2 } });
    r = await read(await retentionRoute.GET());
    expect(r.body).toMatchObject({ preview: { leads: 0 }, lastRun: { deleted: 2 } });
    const audits = (await env.db.select().from(auditLog)).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["retention.settings", "retention.run"]));
  });

  it("tüm verilerimi sil: yanlış ifade 400; planlanır (202) → bekleyen → iptal; sonuç bildirimi kapatılır", async () => {
    let r = await read(
      await wipeRoute.POST(req("POST", "/api/data/wipe", { confirm: "sil", deleteBackups: false })),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "WIPE_CONFIRM_MISMATCH" } });
    r = await read(
      await wipeRoute.POST(
        req("POST", "/api/data/wipe", { confirm: "Delete My Data", deleteBackups: true }),
      ),
    );
    expect(r).toEqual({ status: 202, body: { restartRequired: true } });
    r = await read(
      await wipeRoute.POST(
        req("POST", "/api/data/wipe", { confirm: "VERİLERİMİ SİL", deleteBackups: true }),
      ),
    );
    expect(r).toMatchObject({ status: 409, body: { code: "LIFECYCLE_PENDING" } });
    r = await read(await pendingRoute.GET());
    expect(r.body.pending).toMatchObject({ kind: "wipe", deleteBackups: true });
    expect(r.body.pending.customBackupFolder).toBeUndefined();
    r = await read(await pendingRoute.DELETE());
    expect(r.body).toEqual({ cancelled: true });
    expect((await read(await pendingRoute.GET())).body).toEqual({ pending: null });

    writeResult(env.dir, { v: 1, kind: "restore", ok: true, at: 5, secretsRestored: false });
    r = await read(await listRoute.GET());
    expect(r.body.lastResult).toMatchObject({ kind: "restore", ok: true });
    expect((await read(await resultRoute.DELETE())).body).toEqual({ dismissed: true });
    expect((await read(await resultRoute.DELETE())).body).toEqual({ dismissed: false });
    const audits = (await env.db.select().from(auditLog)).map((a) => a.action);
    expect(audits).toEqual(
      expect.arrayContaining(["data.wipe.schedule", "data.pending.cancel", "data.result.dismiss"]),
    );
  });

  it("her yaşam döngüsü hata kodunun TR ve EN metni var", () => {
    for (const c of LIFECYCLE_ERROR_CODES) {
      expect(tr[`apiError.${c}`], c).toBeTruthy();
      expect(en[`apiError.${c}`], c).toBeTruthy();
    }
  });
});
