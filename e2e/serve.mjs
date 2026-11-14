#!/usr/bin/env node
/**
 * E2E için üretim benzeri sunucu: standalone Next sunucusu + işçi, geçici veri klasörüyle.
 * Önce `npm run build` çalıştırılmış olmalıdır. Playwright `webServer` olarak başlatır, bitince sonlandırır.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.resolve(".next/standalone");
if (!fs.existsSync(path.join(dir, "server.js")) || !fs.existsSync(path.join(dir, "worker.cjs"))) {
  console.error("✖ .next/standalone hazır değil. Önce `npm run build` çalıştırın.");
  process.exit(1);
}
const port = process.env.E2E_PORT ?? "3210";
const tmpRoot = process.env.TMPDIR ?? os.tmpdir();
// Önceki çökmüş çalışmalardan kalan, bir günden eski geçici klasörler temizlenir (yalnızca `um-e2e-` önekliler).
const DAY_MS = 86_400_000;
for (const name of fs.readdirSync(tmpRoot)) {
  if (!name.startsWith("um-e2e-")) continue;
  const p = path.join(tmpRoot, name);
  try {
    if (Date.now() - fs.statSync(p).mtimeMs > DAY_MS)
      fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // başka bir çalışma siliyor olabilir
  }
}
const data = fs.mkdtempSync(path.join(tmpRoot, "um-e2e-"));
const cleanup = () => fs.rmSync(data, { recursive: true, force: true });
const env = {
  ...process.env,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: port,
  UM_DATA_DIR: data,
  UM_MIGRATIONS_DIR: path.join(dir, "drizzle"),
  UM_STATIC_DATA_DIR: path.join(dir, "data"),
  // Yalnızca E2E: demo gönderim zamanlayıcısı açılır (geçici veri klasörü). Gerçek gönderim kapısı kodda açıktır
  // (LIVE_SENDING_ENABLED=true), ancak burada bağlı Gmail kutusu, DNS denetimi ve kilidi açık ülke yoktur; yalnızca demo
  // posta kutusu ve bellekteki demo sağlayıcı kullanılabilir.
  FAZ3_DEMO_SCHEDULER_ENABLED: "1",
  // Yalnızca E2E: demo gelen kutusu simülatörü açılır (ağa çıkmaz; tasdik "demo_simulated"dır, gerçek doğrulama değildir).
  FAZ3_DEMO_INBOX_ENABLED: "1",
};
const mig = spawnSync(process.execPath, [path.join(dir, "migrate.cjs")], {
  cwd: dir,
  env,
  stdio: "inherit",
});
if (mig.status !== 0) {
  cleanup();
  process.exit(mig.status ?? 1);
}

const server = spawn(process.execPath, [path.join(dir, "server.js")], {
  cwd: dir,
  env,
  stdio: "inherit",
});
const worker = spawn(process.execPath, [path.join(dir, "worker.cjs")], {
  cwd: dir,
  env,
  stdio: "inherit",
});
// Tek kez durdurulur: sunucu ya da işçi beklenmedik şekilde çıkarsa diğeri de kapatılır (yarım ortamda test
// çalışmaz); Playwright SIGTERM gönderir (playwright.config.ts `gracefulShutdown`).
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  worker.kill("SIGTERM");
  server.kill("SIGTERM");
  setTimeout(() => {
    cleanup();
    process.exit(code);
  }, 1500);
};
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
server.on("exit", (c) => stop(stopping ? 0 : (c ?? 1)));
worker.on("exit", (c) => stop(stopping ? 0 : (c ?? 1)));
