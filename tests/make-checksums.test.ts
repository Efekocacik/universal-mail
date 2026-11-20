import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/make-checksums.mjs`: teslimat dosyalarının SHA-256 özet listesi (CI paket işi). Biçim `shasum -c` ile
 * uyumludur; yalnızca istenen uzantılar alınır; dosya yoksa hata verir. Geçici klasörde çalışır.
 */
const SCRIPT = path.resolve(__dirname, "..", "scripts", "make-checksums.mjs");
let dir: string;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-sums-"));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows dosya kilidi: geçici klasör */
  }
});

async function lines(exts: string[]): Promise<string[]> {
  const mod = (await import(/* @vite-ignore */ pathToUrl(SCRIPT))) as {
    checksumLines: (d: string, e: string[]) => string[];
  };
  return mod.checksumLines(dir, exts);
}
const pathToUrl = (p: string) => new URL(`file:///${p.replace(/\\/g, "/")}`).href;

describe("make-checksums", () => {
  it("yalnızca istenen uzantılar, ada göre sıralı; biçim '<sha256>  <ad>' ve içerikle eşleşir", async () => {
    const dmg = Buffer.from("dmg-icerik");
    const zip = Buffer.alloc(3 * 1024 * 1024 + 5, 7); // birden çok blok
    fs.writeFileSync(path.join(dir, "Universal-Mail-1.0.0-mac-arm64.zip"), zip);
    fs.writeFileSync(path.join(dir, "Universal-Mail-1.0.0-mac-arm64.dmg"), dmg);
    fs.writeFileSync(path.join(dir, "latest-mac.yml"), "x");
    fs.writeFileSync(path.join(dir, "Universal-Mail-1.0.0-mac-arm64.dmg.blockmap"), "x");
    expect(await lines(["dmg", "zip"])).toEqual([
      `${sha(dmg)}  Universal-Mail-1.0.0-mac-arm64.dmg`,
      `${sha(zip)}  Universal-Mail-1.0.0-mac-arm64.zip`,
    ]);
    expect(await lines([".DMG"])).toHaveLength(1); // uzantı büyük/küçük harf ve nokta duyarsız
  });

  it("eşleşen dosya yoksa hata verir (boş liste 'başarılı' sayılmaz)", async () => {
    fs.writeFileSync(path.join(dir, "notlar.txt"), "x");
    await expect(lines(["dmg"])).rejects.toThrow(/bulunamadı/);
  });

  it("komut satırı: çıktı dosyasını yazar, bozuk kullanımda 2, eksik dosyada 1 ile çıkar", () => {
    const f = path.join(dir, "A.zip");
    fs.writeFileSync(f, "abc");
    const out = path.join(dir, "SHA256SUMS-macOS.txt");
    const ok = spawnSync(process.execPath, [SCRIPT, dir, out, "zip"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(`${sha("abc")}  A.zip\n`);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status).toBe(2);
    expect(
      spawnSync(process.execPath, [SCRIPT, dir, out, "dmg"], { encoding: "utf8" }).status,
    ).toBe(1);
  });
});
