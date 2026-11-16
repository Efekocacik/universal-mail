import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPendingLifecycleInMain,
  LIFECYCLE_IPC_CHANNELS,
  registerLifecycleIpc,
  type LifecycleIpcEvent,
} from "../electron/lifecycle";
import {
  createPending,
  newNonce,
  parsePending,
  PENDING_FILE,
  readPending,
  readPendingState,
  readResult,
  removeResult,
  writeResult,
} from "@/lib/lifecycle/pending";
import { wipeDataDir, wipePhraseMatches, wipeUserData } from "@/lib/lifecycle/wipe";

/**
 * Paket Y.6: "Tüm verilerimi sil". Veri klasörü ve kullanıcı klasörü listeleri, özel yedek klasöründe YALNIZCA desenle
 * eşleşen dosyalar, düz kopyaların her zaman silinmesi, idempotentlik, işaretin her durumda kaldırılması, onay ifadesi
 * ve Electron ana süreç dikişleri (IPC köken denetimi dahil). Yalnızca geçici klasörler.
 */

let root: string;
let data: string;
let user: string;
let custom: string;

const touch = (p: string, body = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-wipe-"));
  user = path.join(root, "Universal Mail");
  data = path.join(user, "data");
  custom = path.join(root, "Harici Disk", "Yedekler");
  for (const f of [
    "universal-mail.db",
    "universal-mail.db-wal",
    "universal-mail.db-shm",
    "secrets.json",
    "secrets.json.lock",
    "secrets.json.corrupt-1700000000000",
    "secrets.json.pre-restore-2026",
    "google-session.db",
    "google-session.db-wal",
    "worker-status.json",
    "migrate-result.json",
    "migrate.lock",
    "maintenance.lock",
    "lifecycle-result.json",
    "restore-staging/abc/db",
    "backup-tmp/w-1/snapshot.db",
    "backups/pre-migrate-2026-11-01.db",
    "backups/pre-migrate-2026-11-01.db-wal",
    "backups/pre-restore-2026-11-02.db",
    "backups/universal-mail-20261101-080000-startup.umbk",
    "kullanicinin-notu.txt",
  ])
    touch(path.join(data, f));
  for (const f of [
    "master.key.enc",
    "ui-prefs.json",
    "notified-alerts.json",
    "logs/main.log",
    "Preferences",
  ])
    touch(path.join(user, f));
  for (const f of [
    "universal-mail-20261101-080000-manual.umbk",
    "universal-mail-20261101-090000-weekly.umbk.part",
    "baska-program.umbk",
    "tatil-fotografi.jpg",
  ])
    touch(path.join(custom, f));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ls = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

describe("onay ifadesi", () => {
  it("TR veya EN; büyük/küçük harf, I/İ ve fazla boşluk önemsiz; başka metin reddedilir", () => {
    for (const ok of [
      "VERİLERİMİ SİL",
      "verilerimi sil",
      "VERILERIMI SIL",
      "  Verilerimi   Sil ",
      "DELETE MY DATA",
      "delete my data",
    ])
      expect(wipePhraseMatches(ok), ok).toBe(true);
    for (const bad of ["", "SİL", "verilerimi silme", "DELETE", "delete all data"])
      expect(wipePhraseMatches(bad), bad).toBe(false);
  });
});

describe("veri klasörünü silme", () => {
  it("yedekler kalsın: uygulama dosyaları ve düz kopyalar silinir, .umbk yedekler ve tanınmayan dosyalar kalır", () => {
    const r = wipeDataDir({ dataDir: data, deleteBackups: false, customBackupFolder: custom });
    expect(r.failed).toEqual([]);
    expect(ls(data)).toEqual(["backups", "kullanicinin-notu.txt"]);
    expect(ls(path.join(data, "backups"))).toEqual(["universal-mail-20261101-080000-startup.umbk"]);
    expect(ls(custom)).toHaveLength(4); // özel klasöre dokunulmaz
  });

  it("yedekleri de sil: varsayılan klasör boşalıp kalkar; özel klasörde YALNIZCA universal-mail-*.umbk(.part) silinir", () => {
    const r = wipeDataDir({ dataDir: data, deleteBackups: true, customBackupFolder: custom });
    expect(r.failed).toEqual([]);
    expect(ls(data)).toEqual(["kullanicinin-notu.txt"]);
    expect(ls(custom)).toEqual(["baska-program.umbk", "tatil-fotografi.jpg"]);
    expect(fs.existsSync(custom)).toBe(true);
    // İdempotent: ikinci çağrı hata vermez, hiçbir şey silmez.
    expect(wipeDataDir({ dataDir: data, deleteBackups: true, customBackupFolder: custom })).toEqual(
      {
        removed: 0,
        failed: [],
      },
    );
  });

  it("sembolik bağlantı izlenmez (desenle eşleşse bile hedef silinmez)", () => {
    const target = path.join(root, "hedef.umbk");
    touch(target);
    fs.symlinkSync(target, path.join(custom, "universal-mail-20261102-080000-manual.umbk"));
    wipeDataDir({ dataDir: data, deleteBackups: true, customBackupFolder: custom });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("kullanıcı klasörü: ana anahtar, tercihler, bildirim izi ve günlükler; başka dosyalar kalır", () => {
    const r = wipeUserData(user);
    expect(r.removed).toBe(4);
    expect(ls(user)).toEqual(["Preferences", "data"]);
  });
});

describe("bekleyen işlem işareti", () => {
  it("doğrulama: bilinmeyen alan, yanlış tür, göreli klasör veya geçersiz nonce reddedilir", () => {
    const base = { v: 1, kind: "wipe", deleteBackups: true, at: 1, nonce: newNonce() };
    expect(parsePending(base)).toEqual(base);
    expect(parsePending({ ...base, customBackupFolder: "/mutlak" })).toMatchObject({
      customBackupFolder: "/mutlak",
    });
    expect(parsePending({ ...base, customBackupFolder: "göreli" })).toBeNull();
    expect(parsePending({ ...base, extra: 1 })).toBeNull();
    expect(parsePending({ ...base, nonce: "x" })).toBeNull();
    expect(parsePending({ ...base, kind: "format" })).toBeNull();
    expect(
      parsePending({
        v: 1,
        kind: "restore",
        stageId: "../x",
        restoreSecrets: true,
        at: 1,
        nonce: newNonce(),
      }),
    ).toBeNull();
    expect(() => createPending(data, { ...base, nonce: "x" } as never)).toThrow();
  });

  it("tek işaret: ikinci oluşturma false döner, içerik değişmez; sonuç dosyası okunur/silinir", () => {
    const a = {
      v: 1 as const,
      kind: "wipe" as const,
      deleteBackups: false,
      at: 1,
      nonce: newNonce(),
    };
    expect(createPending(data, a)).toBe(true);
    expect(createPending(data, { ...a, deleteBackups: true, nonce: newNonce() })).toBe(false);
    expect(readPending(data)).toEqual(a);
    expect(fs.readdirSync(data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    writeResult(data, { v: 1, kind: "wipe", ok: false, code: "WIPE_PARTIAL", at: 5 });
    expect(readResult(data)).toEqual({
      v: 1,
      kind: "wipe",
      ok: false,
      code: "WIPE_PARTIAL",
      at: 5,
    });
    removeResult(data);
    expect(readResult(data)).toBeNull();
    fs.writeFileSync(path.join(data, "lifecycle-result.json"), '{"v":1,"kind":"x"}');
    expect(readResult(data)).toBeNull();
  });
});

describe("Electron ana süreç", () => {
  it("bekleyen silme: veri + kullanıcı klasörü silinir, işaret kalkar, sonuç yazılır; ikinci açılışta hiçbir şey olmaz", async () => {
    createPending(data, {
      v: 1,
      kind: "wipe",
      deleteBackups: true,
      at: 1,
      nonce: newNonce(),
      customBackupFolder: custom,
    });
    const logs: string[] = [];
    const r = await applyPendingLifecycleInMain({
      userDataDir: user,
      dataDir: data,
      log: (m) => logs.push(m),
      now: 7,
    });
    expect(r).toEqual({ applied: { kind: "wipe", ok: true } });
    expect(ls(user)).toEqual(["Preferences", "data"]);
    expect(ls(data)).toEqual(["kullanicinin-notu.txt", "lifecycle-result.json"]);
    expect(readResult(data)).toEqual({ v: 1, kind: "wipe", ok: true, at: 7 });
    expect(ls(custom)).toEqual(["baska-program.umbk", "tatil-fotografi.jpg"]);
    expect(logs.join("\n")).not.toContain(root); // günlükte tam yol yok
    expect(
      await applyPendingLifecycleInMain({ userDataDir: user, dataDir: data, log: () => undefined }),
    ).toEqual({
      applied: null,
    });
  });

  it("geri yükleme işareti ve bozuk işaret ana süreçte uygulanmaz (geçiş sürecine kalır)", async () => {
    createPending(data, {
      v: 1,
      kind: "restore",
      stageId: "b".repeat(32),
      restoreSecrets: false,
      at: 1,
      nonce: newNonce(),
    });
    expect(
      await applyPendingLifecycleInMain({ userDataDir: user, dataDir: data, log: () => undefined }),
    ).toEqual({
      applied: null,
    });
    expect(readPendingState(data).state).toBe("ok");
    fs.writeFileSync(path.join(data, PENDING_FILE), "bozuk");
    expect(
      (
        await applyPendingLifecycleInMain({
          userDataDir: user,
          dataDir: data,
          log: () => undefined,
        })
      ).applied,
    ).toBeNull();
    expect(fs.existsSync(path.join(user, "master.key.enc"))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "kısmi hata: işaret YİNE kaldırılır (her açılışta yeniden silme döngüsü olmaz), sonuç ok:false",
    async () => {
      createPending(data, { v: 1, kind: "wipe", deleteBackups: false, at: 1, nonce: newNonce() });
      fs.chmodSync(path.join(data, "restore-staging", "abc"), 0o500);
      try {
        const r = await applyPendingLifecycleInMain({
          userDataDir: user,
          dataDir: data,
          log: () => undefined,
        });
        expect(r.applied).toEqual({ kind: "wipe", ok: false });
        expect(readPendingState(data).state).toBe("none");
        expect(readResult(data)).toMatchObject({ ok: false, code: "WIPE_PARTIAL" });
      } finally {
        fs.chmodSync(path.join(data, "restore-staging", "abc"), 0o700);
      }
    },
  );

  it("IPC: yalnızca yerel kökenden gelen çağrılar kabul edilir", async () => {
    const handlers = new Map<string, (e: LifecycleIpcEvent, ...a: unknown[]) => unknown>();
    const relaunch = vi.fn(async () => undefined);
    registerLifecycleIpc(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      {
        isLocal: (u) => u.startsWith("http://127.0.0.1:"),
        relaunch,
        chooseFolder: async () => "/klasör",
        chooseFile: async () => "/yedek.umbk",
      },
    );
    expect([...handlers.keys()].sort()).toEqual([...LIFECYCLE_IPC_CHANNELS].sort());
    const local = { senderFrame: { url: "http://127.0.0.1:3000/settings" } };
    const evil = { senderFrame: { url: "https://kotu.example/" } };
    expect(await handlers.get("um:choose-folder")!(local)).toBe("/klasör");
    expect(await handlers.get("um:choose-folder")!(evil)).toBeNull();
    expect(await handlers.get("um:choose-backup-file")!(local)).toBe("/yedek.umbk");
    expect(await handlers.get("um:choose-backup-file")!({ senderFrame: null })).toBeNull();
    expect(await handlers.get("um:relaunch")!(evil)).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    expect(await handlers.get("um:relaunch")!(local)).toBe(true);
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
