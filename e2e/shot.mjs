// Geliştirme aracı: sayfaların ekran görüntüsünü alır (kurulu Chrome ile, ek tarayıcı indirmeden).
import { chromium } from "@playwright/test";

const [, , url, out, width = "1440", height = "900", action] = process.argv;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 1,
});
const logs = [];
page.on("console", (m) => {
  if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "networkidle" });
if (action) await page.evaluate(action);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(logs.length ? logs.join("\n") : "konsol temiz");
await browser.close();
