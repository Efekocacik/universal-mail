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

if (process.argv.includes("--relay")) {
  const outArg = process.argv.find((a) => a.startsWith("--outdir="));
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

  await build({
    ...common,
    entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
    outdir: "dist/electron",
    external: ["electron"],
  });

  console.log("✔ dist/worker ve dist/electron hazır.");
}
