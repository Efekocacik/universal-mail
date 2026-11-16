/**
 * Faz 6 (paket G): gizlilik denetimi için YALITILMIŞ sunucu. `e2e/serve.mjs`'nin paylaşılan sunucusuna dokunmaz:
 * kendi geçici veri klasörü, kendi bağlantı noktası; migrasyon, web sunucusu ve işçi `scripts/egress-guard.cjs` ile
 * (`NODE_OPTIONS=--require`) çalışır. Bekçi `block` kipindeyken yerel olmayan her bağlantı/DNS denemesi engellenir ve
 * `egress.jsonl`'e yazılır; böylece denetim gerçek ağa hiç çıkmadan "dışarıya istek yok" kanıtı üretir.
 *
 * Önce `npm run build` çalıştırılmış olmalıdır.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Playwright bu dosyayı CJS'e dönüştürerek yükler (`import.meta` yok); komutlar depo kökünden çalışır.
const ROOT = process.cwd();
const STANDALONE = path.join(ROOT, ".next", "standalone");
const GUARD = path.join(ROOT, "scripts", "egress-guard.cjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {
      // sunucu henüz açılmadı
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Yalıtılmış sunucu ${timeoutMs} ms içinde hazır olmadı.`);
}

/**
 * @param {{ mode?: "block" | "record", env?: Record<string, string> }} [opts]
 * @returns {Promise<{ url: string, port: number, dataDir: string, egressLog: string,
 *   egress: () => Array<{t:number, proc:string, kind:string, host:string, port:number|null}>,
 *   output: () => string, waitForOutput: (re: RegExp, timeoutMs?: number) => Promise<void>,
 *   stop: () => Promise<void> }>}
 */
export async function startIsolatedServer(opts = {}) {
  for (const f of ["server.js", "worker.cjs", "migrate.cjs"]) {
    if (!fs.existsSync(path.join(STANDALONE, f)))
      throw new Error("✖ .next/standalone hazır değil. Önce `npm run build` çalıştırın.");
  }
  const tmpRoot = process.env.TMPDIR ?? os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, "um-privacy-"));
  const egressLog = path.join(dataDir, "egress.jsonl");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Ortam, kullanıcının/CI'ın anahtarlarını TAŞIMAZ: yalnızca gereken değişkenler (temiz kurulum).
  const base = {
    PATH: process.env.PATH ?? "",
    HOME: dataDir,
    USERPROFILE: dataDir,
    TMPDIR: tmpRoot,
    TEMP: tmpRoot,
    TMP: tmpRoot,
    SystemRoot: process.env.SystemRoot ?? "",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    UM_DATA_DIR: dataDir,
    UM_MIGRATIONS_DIR: path.join(STANDALONE, "drizzle"),
    UM_STATIC_DATA_DIR: path.join(STANDALONE, "data"),
    UM_EGRESS_LOG: egressLog,
    UM_EGRESS_MODE: opts.mode ?? "block",
    NODE_OPTIONS: `--require ${JSON.stringify(GUARD)}`,
    ...opts.env,
  };
  const env = (proc) => ({ ...base, UM_EGRESS_PROC: proc });
  const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true });

  const mig = spawnSync(process.execPath, [path.join(STANDALONE, "migrate.cjs")], {
    cwd: STANDALONE,
    env: env("migrate"),
    encoding: "utf8",
  });
  if (mig.status !== 0) {
    cleanup();
    throw new Error(`Migrasyon başarısız (${mig.status}): ${mig.stderr?.slice(0, 2000)}`);
  }

  let output = "";
  const children = [];
  const exitError = { value: null };
  for (const [proc, file] of [
    ["server", "server.js"],
    ["worker", "worker.cjs"],
  ]) {
    const child = spawn(process.execPath, [path.join(STANDALONE, file)], {
      cwd: STANDALONE,
      env: env(proc),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (d) => {
      output += `[${proc}] ${d}`;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) exitError.value = `${proc} çıktı (${code})`;
    });
    children.push(child);
  }

  const stop = async () => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    await Promise.all(
      children.map(
        (c) =>
          new Promise((resolve) => {
            if (c.exitCode !== null) return resolve();
            const timer = setTimeout(() => {
              c.kill("SIGKILL");
              resolve();
            }, 5000);
            c.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
    cleanup();
  };

  try {
    await waitForHealth(url, 60_000);
  } catch (e) {
    await stop();
    throw new Error(`${e.message}\n${output.slice(-4000)}`);
  }

  return {
    url,
    port,
    dataDir,
    egressLog,
    egress: () =>
      fs.existsSync(egressLog)
        ? fs
            .readFileSync(egressLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    output: () => output,
    waitForOutput: async (re, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!re.test(output)) {
        if (exitError.value) throw new Error(`${exitError.value}\n${output.slice(-4000)}`);
        if (Date.now() > deadline)
          throw new Error(`Beklenen çıktı gelmedi: ${re}\n${output.slice(-4000)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    stop,
  };
}
