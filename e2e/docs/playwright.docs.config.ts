import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Kullanım kılavuzu ekran görüntüleri (`npm run docs:shots`). Normal uçtan uca çalıştırmaya GİRMEZ: ana yapılandırma
 * yalnızca `*.spec.ts` dosyalarını alır, bu yapılandırma yalnızca `*.docs.ts` dosyalarını. Önce `npm run build`.
 *
 * Kendi sunucusunu (`e2e/serve.mjs`) ayrı bir bağlantı noktasında ve YENİ, boş bir geçici veri klasörüyle başlatır:
 * ilk açılış gerçekten ilk açılıştır, demo sağlayıcı kullanılır, dış ağa çıkılmaz ve geliştiricinin veya kullanıcının
 * veri klasörüne dokunulmaz. Görüntüler `docs/img/kullanim/` altına yazılır (açık tema, 1280×800).
 */
const port = process.env.DOCS_PORT ?? "3240";
const root = path.resolve(__dirname, "../..");

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.docs\.ts/,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command: "node e2e/serve.mjs",
    cwd: root,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_PORT: port },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
