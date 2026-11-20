#!/usr/bin/env node
/**
 * Kurulum dosyaları için SHA-256 özet listesi üretir (CI paket işi, docs/PAKETLEME.md "Teslimat süreci").
 *
 *   node scripts/make-checksums.mjs <klasör> <çıktı-dosyası> <uzantı[,uzantı…]>
 *   örn.  node scripts/make-checksums.mjs release release/SHA256SUMS-macOS.txt dmg,zip
 *
 * Çıktı biçimi `shasum -a 256 -c` / `sha256sum -c` ile uyumludur: "<64 onaltılık>  <dosya adı>" (iki boşluk).
 * Yalnızca belirtilen uzantılı dosyalar, ada göre sıralı, klasörün DOĞRUDAN içinden alınır; hiç dosya yoksa hata verir
 * (boş bir özet listesi sessizce "başarılı" sayılmaz). Dosya içerikleri veya yolları dışında hiçbir bilgi yazılmaz.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string} file */
export function sha256File(file) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * @param {string} dir
 * @param {string[]} exts uzantılar (nokta olmadan, küçük harf)
 * @returns {string[]} "<özet>  <ad>" satırları
 */
export function checksumLines(dir, exts) {
  const wanted = new Set(exts.map((e) => e.replace(/^\./, "").toLowerCase()));
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && wanted.has(path.extname(e.name).slice(1).toLowerCase()))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`"${dir}" içinde ${[...wanted].join("/")} uzantılı dosya bulunamadı.`);
  }
  return names.map((n) => `${sha256File(path.join(dir, n))}  ${n}`);
}

function main() {
  const [dir, out, extList] = process.argv.slice(2);
  if (!dir || !out || !extList) {
    console.error("Kullanım: node scripts/make-checksums.mjs <klasör> <çıktı> <uzantı[,uzantı…]>");
    process.exit(2);
  }
  const lines = checksumLines(dir, extList.split(",").filter(Boolean));
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
