import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleError } from "@/lib/backup/errors";
import {
  decryptBackup,
  deriveKey,
  readBackupHeader,
  writeEncryptedBackup,
  type BackupMeta,
} from "@/lib/backup/format";
import {
  checkNewPassphrase,
  checkPassphrase,
  normalizePassphrase,
  passphraseStrength,
} from "@/lib/backup/passphrase";

/**
 * Paket Y.1: `.umbk` biçimi. Gidiş-dönüş, yanlış parola, başlık/meta/yük/etiket bozulması, kesik dosya, aralık dışı
 * KDF ve gzip bombası koruması. Düşük scrypt maliyeti (log2N=14) yalnızca test hızı içindir.
 */

const PASS = "doğru-parola-123";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-fmt-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const meta = (over: Partial<BackupMeta> = {}): BackupMeta => ({
  app: "universal-mail",
  appVersion: "0.1.0",
  createdAt: 1_796_000_000_000,
  kind: "manual",
  schemaMigrations: 7,
  includesSecrets: true,
  compression: "gzip",
  ...over,
});

async function make(
  dbBytes: Buffer,
  opts: { secrets?: Record<string, string>; manifestOverride?: object; log2N?: number } = {},
) {
  const db = path.join(dir, "src.db");
  fs.writeFileSync(db, dbBytes);
  const out = path.join(dir, "b.umbk");
  const res = await writeEncryptedBackup({
    passphrase: PASS,
    meta: meta(),
    manifest: (opts.manifestOverride as never) ?? {
      dbBytes: dbBytes.length,
      dbSha256: crypto.createHash("sha256").update(dbBytes).digest("hex"),
      ...(opts.secrets ? { secrets: opts.secrets } : {}),
    },
    dbFile: db,
    out: fs.createWriteStream(out),
    log2N: opts.log2N ?? 14,
  });
  return { out, res };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof LifecycleError ? e.code : `OTHER:${(e as Error).message}`;
  }
}

describe("yedek biçimi (.umbk)", () => {
  it("gidiş-dönüş: veritabanı baytları, meta ve gizli bilgiler aynen geri gelir; özet ve boyut dosyayla tutar", async () => {
    const data = crypto.randomBytes(300_000);
    const { out, res } = await make(data, { secrets: { "google.placesKey": "AIza-örnek" } });
    const file = fs.readFileSync(out);
    expect(file.subarray(0, 8).toString("ascii")).toBe("UMBACKUP");
    expect(res.bytes).toBe(file.length);
    expect(res.sha256).toBe(crypto.createHash("sha256").update(file).digest("hex"));
    const h = readBackupHeader(out);
    expect(h.meta).toEqual(meta());
    expect(h.kdf.log2N).toBe(14);
    const target = path.join(dir, "out.db");
    const r = await decryptBackup({ file: out, passphrase: PASS, outDbFile: target });
    expect(fs.readFileSync(target).equals(data)).toBe(true);
    expect(r.manifest.secrets).toEqual({ "google.placesKey": "AIza-örnek" });
    // Düz metin dosyada görünmez (şifreli).
    expect(file.includes(Buffer.from("AIza-örnek"))).toBe(false);
  });

  it("parola normalleştirmesi: baştaki/sondaki boşluk ve NFC farkı aynı anahtarı verir", async () => {
    const { out } = await make(Buffer.from("x".repeat(1000)));
    const target = path.join(dir, "o.db");
    expect(
      await codeOf(decryptBackup({ file: out, passphrase: `  ${PASS}\n`, outDbFile: target })),
    ).toBe("OK");
    const salt = crypto.randomBytes(16);
    const a = await deriveKey("café-parola-12", { log2N: 14, r: 8, p: 1, salt });
    const b = await deriveKey("café-parola-12", { log2N: 14, r: 8, p: 1, salt });
    expect(a.equals(b)).toBe(true);
  });

  it("yanlış parola → BACKUP_WRONG_PASSPHRASE ve çıktı dosyası kalmaz", async () => {
    const { out } = await make(Buffer.from("veri"));
    const target = path.join(dir, "o.db");
    expect(
      await codeOf(decryptBackup({ file: out, passphrase: "yanlış-parola-99", outDbFile: target })),
    ).toBe("BACKUP_WRONG_PASSPHRASE");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("herhangi bir baytı bozulan dosya asla açılmaz; yük/etiket bozulması CORRUPT, sihirli sözcük BAD_FORMAT", async () => {
    const { out } = await make(crypto.randomBytes(5000));
    const orig = fs.readFileSync(out);
    const metaLen = orig.readUInt32BE(85);
    const target = path.join(dir, "o.db");
    const flip = async (i: number) => {
      const f = Buffer.from(orig);
      f[i] = f[i]! ^ 0x01;
      const p = path.join(dir, `flip-${i}.umbk`);
      fs.writeFileSync(p, f);
      return codeOf(decryptBackup({ file: p, passphrase: PASS, outDbFile: target }));
    };
    expect(await flip(0)).toBe("BACKUP_BAD_FORMAT"); // sihirli sözcük
    expect(await flip(8)).toBe("BACKUP_BAD_FORMAT"); // sürüm
    // Tuz/doğrulayıcı: anahtar farklılaşır → parola tutmaz sayılır (ayırt edilemez), açılmaz.
    expect(await flip(20)).toBe("BACKUP_WRONG_PASSPHRASE");
    expect(await flip(50)).toBe("BACKUP_WRONG_PASSPHRASE");
    expect(await flip(75)).toBe("BACKUP_CORRUPT"); // yük nonce'u (AAD)
    expect(["BACKUP_CORRUPT", "BACKUP_BAD_FORMAT"]).toContain(await flip(89 + 3)); // meta (AAD)
    expect(await flip(89 + metaLen + 10)).toBe("BACKUP_CORRUPT"); // yük
    expect(await flip(orig.length - 1)).toBe("BACKUP_CORRUPT"); // etiket
    expect(fs.existsSync(target)).toBe(false);
  });

  it("kesik dosya ve çok kısa dosya reddedilir", async () => {
    const { out } = await make(crypto.randomBytes(20_000));
    const orig = fs.readFileSync(out);
    const target = path.join(dir, "o.db");
    const cut = path.join(dir, "cut.umbk");
    fs.writeFileSync(cut, orig.subarray(0, orig.length - 100));
    expect(await codeOf(decryptBackup({ file: cut, passphrase: PASS, outDbFile: target }))).toBe(
      "BACKUP_CORRUPT",
    );
    fs.writeFileSync(cut, orig.subarray(0, 60));
    expect(await codeOf(decryptBackup({ file: cut, passphrase: PASS, outDbFile: target }))).toBe(
      "BACKUP_BAD_FORMAT",
    );
    expect(
      await codeOf(
        decryptBackup({ file: path.join(dir, "yok.umbk"), passphrase: PASS, outDbFile: target }),
      ),
    ).toBe("BACKUP_FILE_MISSING");
  });

  it("aralık dışı scrypt maliyeti (log2N 21 veya 13) ve geçersiz meta BAD_FORMAT", async () => {
    const { out } = await make(Buffer.from("veri"));
    const orig = fs.readFileSync(out);
    const target = path.join(dir, "o.db");
    for (const v of [13, 21]) {
      const f = Buffer.from(orig);
      f[10] = v;
      fs.writeFileSync(out, f);
      expect(await codeOf(decryptBackup({ file: out, passphrase: PASS, outDbFile: target }))).toBe(
        "BACKUP_BAD_FORMAT",
      );
    }
    const f = Buffer.from(orig);
    f.writeUInt32BE(5000, 85);
    fs.writeFileSync(out, f);
    expect(() => readBackupHeader(out)).toThrow(LifecycleError);
    await expect(
      writeEncryptedBackup({
        passphrase: PASS,
        meta: meta(),
        manifest: { dbBytes: 1, dbSha256: "0".repeat(64) },
        dbFile: out,
        out: new Writable({ write: (_c, _e, cb) => cb() }),
        log2N: 22,
      }),
    ).rejects.toThrow();
  });

  it("gzip bombası: manifestin bildirdiğinden fazla bayt gelir gelmez durur (CORRUPT); eksik bayt da CORRUPT", async () => {
    const big = Buffer.alloc(2_000_000); // sıfırlar: çok iyi sıkışır
    const sha = crypto.createHash("sha256").update(big).digest("hex");
    const target = path.join(dir, "o.db");
    const lie = await make(big, { manifestOverride: { dbBytes: 1000, dbSha256: sha } });
    expect(
      await codeOf(decryptBackup({ file: lie.out, passphrase: PASS, outDbFile: target })),
    ).toBe("BACKUP_CORRUPT");
    expect(fs.existsSync(target)).toBe(false);
    const short = await make(Buffer.from("abc"), {
      manifestOverride: { dbBytes: 10, dbSha256: sha },
    });
    expect(
      await codeOf(decryptBackup({ file: short.out, passphrase: PASS, outDbFile: target })),
    ).toBe("BACKUP_CORRUPT");
    const badSha = await make(Buffer.from("abc"), {
      manifestOverride: { dbBytes: 3, dbSha256: "f".repeat(64) },
    });
    expect(
      await codeOf(decryptBackup({ file: badSha.out, passphrase: PASS, outDbFile: target })),
    ).toBe("BACKUP_CORRUPT");
    // Bildirilen boyut sınırın (16 GiB) üstünde: manifest geçersiz.
    const huge = await make(Buffer.from("abc"), {
      manifestOverride: { dbBytes: 2 ** 40, dbSha256: sha },
    });
    expect(
      await codeOf(decryptBackup({ file: huge.out, passphrase: PASS, outDbFile: target })),
    ).toBe("BACKUP_CORRUPT");
    expect(zlib.gzipSync(big).length).toBeLessThan(10_000); // bomba gerçekten küçük dosya
  });
});

describe("yedek parolası kuralı", () => {
  it("10–256 karakter, hepsi aynı değil; kırpma ve NFC uygulanır", () => {
    expect(checkPassphrase("  abcdefghij  ")).toBe("abcdefghij");
    expect(() => checkPassphrase("kısa")).toThrow(LifecycleError);
    expect(() => checkPassphrase("aaaaaaaaaaaa")).toThrow(/kısa veya çok basit/);
    expect(() => checkPassphrase("x".repeat(255) + "y" + "z")).toThrow(LifecycleError);
    expect(checkPassphrase("ğ".repeat(9) + "ü")).toHaveLength(10); // kod noktası sayılır
    expect(normalizePassphrase("café")).toBe("café");
  });

  it("onay eşleşmesi önce denetlenir; güç ipucu 0–3", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return "OK";
      } catch (e) {
        return (e as LifecycleError).code;
      }
    };
    expect(code(() => checkNewPassphrase("abcdefghijk", "abcdefghijX"))).toBe(
      "BACKUP_PASSPHRASE_MISMATCH",
    );
    expect(code(() => checkNewPassphrase("kısa", "kısa"))).toBe("BACKUP_PASSPHRASE_WEAK");
    expect(code(() => checkNewPassphrase(" abcdefghijk", "abcdefghijk "))).toBe("OK");
    expect(passphraseStrength("abc")).toBe(0);
    expect(passphraseStrength("abcdefghijk")).toBe(1);
    expect(passphraseStrength("abcdefgh1234")).toBe(2);
    expect(passphraseStrength("Abcdefgh-1234-xyz")).toBe(3);
  });
});
