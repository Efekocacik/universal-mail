import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSecrets, isKnownSecretName, writeSecretsFile } from "@/lib/backup/secrets-io";
import {
  createPending,
  newNonce,
  readPending,
  readResult,
  stageDirOf,
} from "@/lib/lifecycle/pending";
import { runPreInitHooks } from "@/lib/lifecycle/pre-init";

/**
 * Paket Y: kenar durumları. Gizli bilgi aktarımı bozuk/eksik depoda ve anahtarsız çalışmada sessizce boş döner (değer
 * sızdırmaz, yedeği düşürmez); geri yükleme adımı yarıda düşerse mevcut veritabanı aynen kalır ve işaret kaldırılır.
 */

const KEY_A = "ab".repeat(32);
let dir: string;
const saved = {
  key: process.env.UM_MASTER_KEY,
  req: process.env.UM_REQUIRE_MASTER_KEY,
  db: process.env.UM_DB_PATH,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-bk-edge-"));
  process.env.UM_MASTER_KEY = KEY_A;
  delete process.env.UM_REQUIRE_MASTER_KEY;
  delete process.env.UM_DB_PATH;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ["UM_MASTER_KEY", saved.key],
    ["UM_REQUIRE_MASTER_KEY", saved.req],
    ["UM_DB_PATH", saved.db],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe("gizli bilgi aktarımı", () => {
  it("depo yok, bozuk JSON veya yanlış sürüm → boş, atlanan yok", () => {
    expect(exportSecrets(dir)).toEqual({ secrets: {}, skipped: 0 });
    fs.writeFileSync(path.join(dir, "secrets.json"), "{bozuk");
    expect(exportSecrets(dir)).toEqual({ secrets: {}, skipped: 0 });
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ v: 2, items: {} }));
    expect(exportSecrets(dir)).toEqual({ secrets: {}, skipped: 0 });
  });

  it("bilinmeyen ad ve çözülemeyen kayıt atlanıp sayılır; yedek parolası asla dışa aktarılmaz", () => {
    const file = path.join(dir, "secrets.json");
    writeSecretsFile(file, {
      "google.placesKey": "AIza-ornek",
      "backup.passphrase": "yedek-parolasi-1",
      "bilinmeyen.ad": "x",
      "gmail.refreshToken.7": "   ",
    });
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    // Bilinmeyen ad ve boş değer yazılmadı.
    expect(Object.keys(store.items).sort()).toEqual(["backup.passphrase", "google.placesKey"]);
    store.items["bilinmeyen.ad"] = store.items["google.placesKey"];
    store.items["gmail.refreshToken.7"] = {
      ...store.items["google.placesKey"],
      tag: crypto.randomBytes(16).toString("base64"),
    };
    fs.writeFileSync(file, JSON.stringify(store));
    expect(exportSecrets(dir)).toEqual({
      secrets: { "google.placesKey": "AIza-ornek" },
      skipped: 2,
    });

    // Ana anahtar yok (paketli uygulamada anahtarsız çalışma): hiçbir değer okunamaz, hepsi atlanır.
    delete process.env.UM_MASTER_KEY;
    process.env.UM_REQUIRE_MASTER_KEY = "1";
    expect(exportSecrets(dir)).toEqual({ secrets: {}, skipped: 3 });
  });

  it("bilinen adlar: sabit adlar, posta kutusu ve abonelikten çıkma anahtarları; diğerleri değil", () => {
    for (const ok of [
      "google.placesKey",
      "backup.passphrase",
      "gmail.refreshToken.12",
      "unsubscribe.signingKey.0123456789abcdef",
    ])
      expect(isKnownSecretName(ok), ok).toBe(true);
    for (const bad of ["gmail.refreshToken.0", "unsubscribe.signingKey.xyz", "../secrets", ""])
      expect(isKnownSecretName(bad), bad).toBe(false);
  });
});

describe("geri yükleme yarıda düşerse", () => {
  it("yedek klasörü oluşturulamazsa mevcut veritabanı aynen kalır; işaret kalkar; sonuç RESTORE_FAILED", async () => {
    const db = path.join(dir, "universal-mail.db");
    fs.writeFileSync(db, "MEVCUT");
    const stageId = crypto.randomBytes(16).toString("hex");
    const sd = stageDirOf(dir, stageId);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "db"), "YEDEK");
    fs.writeFileSync(path.join(sd, "stage.json"), JSON.stringify({ v: 1 }));
    // `backups` bir DOSYA: kopya klasörü oluşturulamaz → ilk adımda düşer.
    fs.writeFileSync(path.join(dir, "backups"), "");
    createPending(dir, {
      v: 1,
      kind: "restore",
      stageId,
      restoreSecrets: false,
      at: 1,
      nonce: newNonce(),
    });
    const logs: string[] = [];
    const r = await runPreInitHooks({ dataDir: dir, log: (m) => logs.push(m), now: 5 });
    expect(r.applied).toEqual({ kind: "restore", ok: false, code: "RESTORE_FAILED" });
    expect(fs.readFileSync(db, "utf8")).toBe("MEVCUT");
    expect(fs.existsSync(`${db}.restore-tmp`)).toBe(false);
    expect(readPending(dir)).toBeNull();
    expect(readResult(dir)).toMatchObject({ kind: "restore", ok: false, code: "RESTORE_FAILED" });
    expect(logs.join("\n")).toMatch(/geri yükleme başarısız/);
  });

  it("en yeni 3 geri yükleme öncesi kopya tutulur", async () => {
    const db = path.join(dir, "universal-mail.db");
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups);
    for (const ts of ["2026-01-01", "2026-02-01", "2026-03-01"])
      fs.writeFileSync(path.join(backups, `pre-restore-${ts}.db`), "eski");
    fs.writeFileSync(db, "MEVCUT");
    const stageId = crypto.randomBytes(16).toString("hex");
    const sd = stageDirOf(dir, stageId);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "db"), "YEDEK");
    fs.writeFileSync(path.join(sd, "stage.json"), JSON.stringify({ v: 1 }));
    createPending(dir, {
      v: 1,
      kind: "restore",
      stageId,
      restoreSecrets: false,
      at: 1,
      nonce: newNonce(),
    });
    const r = await runPreInitHooks({
      dataDir: dir,
      log: () => undefined,
      now: Date.UTC(2026, 10, 16),
    });
    expect(r.applied).toEqual({ kind: "restore", ok: true });
    expect(fs.readFileSync(db, "utf8")).toBe("YEDEK");
    const copies = fs
      .readdirSync(backups)
      .filter((f) => f.startsWith("pre-restore-"))
      .sort();
    expect(copies).toHaveLength(3);
    expect(copies).not.toContain("pre-restore-2026-01-01.db");
    expect(fs.readFileSync(path.join(backups, copies[2]!), "utf8")).toBe("MEVCUT");
  });
});
