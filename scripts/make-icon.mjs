#!/usr/bin/env node
// src/app/icon.svg dosyasından 1024px'lik uygulama simgesi (build/icon.png) üretir.
// electron-builder bu PNG'den macOS .icns ve Windows .ico dosyalarını kendisi çıkarır.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const svg = fs.readFileSync("src/app/icon.svg", "utf8");
fs.mkdirSync("build", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{width:1024px;height:1024px;display:block}</style>${svg}`,
);
await page.screenshot({
  path: path.join("build", "icon.png"),
  omitBackground: true,
  clip: { x: 0, y: 0, width: 1024, height: 1024 },
});
await browser.close();
console.log("✔ build/icon.png");
