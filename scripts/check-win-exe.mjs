#!/usr/bin/env node
/**
 * CI (Windows paket işi): paketlenmiş `Universal Mail.exe` kaynaklarının düzenlendiğini doğrular. electron-builder
 * simgeyi ve sürüm bilgisini (ProductName = "Universal Mail") AYNI resedit adımında gömer; düzenleme yapılmadıysa .exe
 * Electron'un varsayılan bilgisini ("Electron") ve simgesini taşır. Sürüm bilgisi UTF-16LE olarak aranır; uygulama
 * kodu .exe'de değil `resources/app.asar`'dadır, bu yüzden bu dize yalnızca düzenlenmiş kaynaklardan gelebilir.
 * Kullanım: `node scripts/check-win-exe.mjs [exe yolu]`. Çıkış 0 = gömülü.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function hasEmbeddedProductName(buf, productName) {
  const needle = Buffer.from(`ProductName\0${productName}`, "utf16le");
  // VS_VERSIONINFO dizgeleri 4 bayta hizalanır: anahtar ile değer arasında fazladan dolgu olabilir.
  const padded = Buffer.from(`ProductName\0\0${productName}`, "utf16le");
  return buf.includes(needle) || buf.includes(padded);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exe = process.argv[2] ?? path.join("release", "win-unpacked", "Universal Mail.exe");
  if (!fs.existsSync(exe)) {
    console.error(`✖ ${exe} bulunamadı. Önce \`npm run dist\` çalıştırın.`);
    process.exit(1);
  }
  if (!hasEmbeddedProductName(fs.readFileSync(exe), "Universal Mail")) {
    console.error(
      "✖ .exe kaynakları düzenlenmemiş (ProductName 'Universal Mail' yok): simge ve sürüm bilgisi gömülmedi.\n" +
        "  electron-builder.config.cjs → win.signAndEditExecutable true olmalı (imzalama signExecutable ile ayrı).",
    );
    process.exit(1);
  }
  console.log("✔ Universal Mail.exe: simge ve sürüm bilgisi gömülü.");
}
