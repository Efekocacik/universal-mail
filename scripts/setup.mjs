#!/usr/bin/env node
/**
 * Geliştirme ortamı kurulumu: Node sürümünü denetler, .env.local oluşturur, veritabanını hazırlar.
 * Son kullanıcı bu betiği ÇALIŞTIRMAZ; kurulum paketi (dmg/exe) her şeyi içerir.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`✖ Node.js 22 veya üstü gerekli (şu an ${process.versions.node}).`);
  process.exit(1);
}
console.log(`✔ Node.js ${process.versions.node}`);

const env = path.resolve(".env.local");
if (!fs.existsSync(env)) {
  fs.copyFileSync(path.resolve(".env.example"), env);
  console.log(
    "✔ .env.local oluşturuldu. Google anahtarlarını isterseniz oraya (yalnızca geliştirme için) yazabilirsiniz.",
  );
} else {
  console.log("✔ .env.local mevcut.");
}

const r = spawnSync("npx", ["tsx", "scripts/migrate.ts"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("\nHazır. Başlatmak için: npm run dev  →  http://127.0.0.1:3000");
