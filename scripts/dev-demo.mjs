#!/usr/bin/env node
/**
 * Yerel demo ortamı: `npm run dev` ile aynı (web + işçi), ama AYRI bir veri klasörüyle (`.data-demo`) ve Faz 3 demo
 * bayrakları açık. Böylece kampanya gönderimi (yalnızca demo posta kutusu, bellekteki sahte sağlayıcı) ve demo gelen
 * kutusu simülatörü localhost'ta denenebilir; gerçek veri klasörüne (`.data`) dokunulmaz.
 *
 * Gerçek gönderim bu bayraklarla AÇILMAZ: canlı kilitler (`LIVE_SENDING_ENABLED`, `LEGAL_APPROVALS`) kodda sabittir.
 * Veri klasörünü değiştirmek için: `UM_DATA_DIR=/yol npm run dev:demo`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const data = path.resolve(process.env.UM_DATA_DIR ?? ".data-demo");
fs.mkdirSync(data, { recursive: true });

const env = {
  ...process.env,
  UM_DATA_DIR: data,
  FAZ3_DEMO_SCHEDULER_ENABLED: "1",
  FAZ3_DEMO_INBOX_ENABLED: "1",
};

console.log(`▶ Demo ortamı: veri klasörü ${data}`);
console.log("  Demo kampanya gönderimi ve demo gelen kutusu açık; gerçek gönderim kapalı.");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "dev"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const stop = (signal) => child.kill(signal);
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
