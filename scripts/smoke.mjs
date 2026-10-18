#!/usr/bin/env node
/**
 * Paketlenmiş (açılmış) uygulamayı pencere açmadan başlatır ve uçtan uca duman testi yapar:
 * şema geçişi, web sunucusu, işçi, yerel erişim koruması ve statik veri. CI'da `electron-builder --dir`
 * sonrası çalıştırılır. Çıkış kodu 0 = başarılı.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const release = path.resolve("release");
const candidates =
  process.platform === "darwin"
    ? ["mac-arm64", "mac"].map((d) =>
        path.join(release, d, "Universal Mail.app", "Contents", "MacOS", "Universal Mail"),
      )
    : process.platform === "win32"
      ? [path.join(release, "win-unpacked", "Universal Mail.exe")]
      : [path.join(release, "linux-unpacked", "universal-mail")];
const exe = process.env.UM_APP_EXECUTABLE ?? candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error(
    "✖ Paketlenmiş uygulama bulunamadı. Önce `npm run dist:dir` çalıştırın.\nAranan:",
    candidates.join("\n  "),
  );
  process.exit(1);
}

const userData = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-smoke-"));
console.log(`→ ${exe}\n→ geçici veri klasörü: ${userData}`);
const child = spawn(exe, [], {
  env: {
    ...process.env,
    UM_SMOKE_TEST: "1",
    UM_USER_DATA_DIR: userData,
    ELECTRON_ENABLE_LOGGING: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const timer = setTimeout(() => {
  console.error("✖ Zaman aşımı (120 sn).");
  child.kill("SIGKILL");
}, 120_000);

child.on("exit", (code) => {
  clearTimeout(timer);
  const line = out.split("\n").find((l) => l.includes("UM_SMOKE_RESULT"));
  console.log(line ? line.slice(line.indexOf("UM_SMOKE_RESULT")) : out.slice(-2000));
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
});
