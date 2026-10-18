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
const data = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-e2e-"));
const env = {
  ...process.env,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: port,
  UM_DATA_DIR: data,
  UM_MIGRATIONS_DIR: path.join(dir, "drizzle"),
  UM_STATIC_DATA_DIR: path.join(dir, "data"),
};
const mig = spawnSync(process.execPath, [path.join(dir, "migrate.cjs")], {
  cwd: dir,
  env,
  stdio: "inherit",
});
if (mig.status !== 0) process.exit(mig.status ?? 1);

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
const stop = () => {
  worker.kill("SIGTERM");
  server.kill("SIGTERM");
  setTimeout(() => {
    fs.rmSync(data, { recursive: true, force: true });
    process.exit(0);
  }, 1500);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", stop);
