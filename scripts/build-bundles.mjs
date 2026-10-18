#!/usr/bin/env node
/**
 * İşçi, şema geçişi ve Electron ana sürecini tek dosyalık CommonJS paketlere derler (esbuild).
 * Yerel (native) paketler (libsql) dışarıda bırakılır; çalışma anında standalone sunucunun
 * node_modules klasöründen çözülür (bkz. prepare-standalone.mjs).
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
