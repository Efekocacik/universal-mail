#!/usr/bin/env node
/**
 * İşçi, şema geçişi ve Electron ana sürecini tek dosyalık CommonJS paketlere derler (esbuild).
 * Yerel (native) paketler (libsql) dışarıda bırakılır; çalışma anında standalone sunucunun
 * node_modules klasöründen çözülür (bkz. prepare-standalone.mjs).
 *
 * `--relay` (npm run build:relay): YALNIZCA bağımsız abonelikten çıkış aktarıcısını derler
 * (src/relay/main.ts → dist/relay/relay.cjs; `--outdir=<dizin>` ile başka dizine). Aktarıcı ayrı bir Linux
 * sunucusunda çalışır (deploy/relay/README.md) ve masaüstü paketine girmez. Dış bağımlılığı yoktur (yalnızca Node
 * yerleşikleri); libsql/drizzle İÇERMEMELİDİR (bkz. tests/relay-server.test.ts).
 *
 * `--worker` (npm run build:worker): YALNIZCA Cloudflare Worker aktarıcısını derler (src/relay/worker.ts →
 * dist/cloudflare-worker/worker.js, tek dosyalık ES modülü; `--outdir=<dizin>` ile başka dizine, `--metafile` ile
 * yanına esbuild girdi listesi). `dist/worker/` masaüstü uygulamasının arka plan işçisine aittir; karışmasın diye
 * ayrı dizin kullanılır ve masaüstü paketine (electron-builder.yml) girmez. Workers çalışma ortamı için
 * tarayıcı platformuyla derlenir: hiçbir `node:` modülü, libsql/drizzle/next İÇEREMEZ (içerirse derleme başarısız
 * olur; bkz. tests/unsubscribe-worker.test.ts). Dağıtım: deploy/cloudflare-worker/README.md.
 */
import { build } from "esbuild";
import fs from "node:fs";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  logLevel: "info",
  legalComments: "none",
  tsconfig: "tsconfig.json",
  outExtension: { ".js": ".cjs" },
  define: { "process.env.NODE_ENV": '"production"' },
};

const outArg = process.argv.find((a) => a.startsWith("--outdir="));

if (process.argv.includes("--worker")) {
  const outdir = outArg ? outArg.slice("--outdir=".length) : "dist/cloudflare-worker";
  const outfile = `${outdir}/worker.js`;
  fs.rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: ["src/relay/worker.ts"],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    logLevel: "info",
    legalComments: "none",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    external: [],
  });
  if (process.argv.includes("--metafile")) {
    fs.writeFileSync(`${outdir}/worker.meta.json`, JSON.stringify(result.metafile));
  }
  console.log(`✔ ${outfile} hazır (Cloudflare Worker).`);
} else if (process.argv.includes("--relay")) {
  const outdir = outArg ? outArg.slice("--outdir=".length) : "dist/relay";
  fs.rmSync(outdir, { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: { relay: "src/relay/main.ts" },
    outdir,
    external: [],
  });
  console.log(`✔ ${outdir}/relay.cjs hazır.`);
} else {
  fs.rmSync("dist", { recursive: true, force: true });

  await build({
    ...common,
    entryPoints: { worker: "src/worker/index.ts", migrate: "scripts/migrate.ts" },
    outdir: "dist/worker",
    external: ["libsql", "@libsql/*"],
  });

  // Faz 4: ana süreç menü/pencere metinleri için src/lib/i18n sözlüğünü ve bildirim bağlantısı doğrulaması için
  // src/lib/client/app-path.ts'i de içerir (veritabanı katmanı İÇERMEZ; ~350 KB).
  await build({
    ...common,
    entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
    outdir: "dist/electron",
    external: ["electron"],
  });

  console.log("✔ dist/worker ve dist/electron hazır.");
}
