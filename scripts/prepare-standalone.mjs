#!/usr/bin/env node
/**
 * `next build` sonrası standalone çıktıyı paketlemeye hazırlar:
 *  1) statik dosyaları ve public klasörünü yanına kopyalar,
 *  2) libsql'in İŞLETİM SİSTEMİNE ÖZGÜ yerel paketini ekler (Next'in izleyicisi bu dinamik require'ı yakalamaz),
 *  3) işçi ve şema geçişi paketlerini aynı klasöre koyar (aynı node_modules'tan çözülsünler),
 *  4) çalışma anında gerekmeyen büyük paketleri siler,
 *  5) yerel modülün gerçekten yüklenebildiğini doğrular.
 * Çıktı klasörü: .next/standalone
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("✖ .next/standalone/server.js yok. Önce `next build` çalıştırın.");
  process.exit(1);
}

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, force: true });

// 1) statik dosyalar
copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
fs.mkdirSync(path.join(standalone, "public"), { recursive: true });
if (fs.existsSync(path.join(root, "public")))
  copy(path.join(root, "public"), path.join(standalone, "public"));

// 2) libsql yerel paketleri (bu makinede kurulu olan platform)
const libsqlDir = path.join(root, "node_modules", "@libsql");
let natives = 0;
for (const name of fs.readdirSync(libsqlDir)) {
  if (!/^(darwin|linux|win32|freebsd)-/.test(name)) continue;
  copy(path.join(libsqlDir, name), path.join(standalone, "node_modules", "@libsql", name));
  natives++;
  console.log(`  + @libsql/${name}`);
}
if (natives === 0) {
  console.error(
    "✖ libsql yerel paketi bulunamadı (@libsql/<platform>). `npm ci` ile bu işletim sisteminde kurun.",
  );
  process.exit(1);
}

// 3) işçi + şema geçişi
for (const f of ["worker.cjs", "migrate.cjs"]) {
  const src = path.join(root, "dist", "worker", f);
  if (!fs.existsSync(src)) {
    console.error(`✖ ${src} yok. Önce \`npm run build:bundles\` çalıştırın.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(standalone, f));
}

// 4) gereksizleri sil (görüntü iyileştirme ve TypeScript çalışma anında kullanılmaz)
for (const rel of [
  "node_modules/typescript",
  "node_modules/sharp",
  "node_modules/@img",
  "node_modules/caniuse-lite",
  "node_modules/@types",
]) {
  fs.rmSync(path.join(standalone, rel), { recursive: true, force: true });
}

// 5) doğrulama
const req = createRequire(path.join(standalone, "server.js"));
try {
  const Database = req("libsql");
  const db = new Database(":memory:");
  const v = db.prepare("select sqlite_version() as v").get();
  db.close();
  console.log(`✔ libsql yerel modülü yüklendi (SQLite ${v.v}).`);
} catch (e) {
  console.error("✖ libsql yerel modülü yüklenemedi:", e.message);
  process.exit(1);
}

const size = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return n;
};
console.log(`✔ standalone hazır: ${(size(standalone) / 1e6).toFixed(0)} MB`);
