#!/usr/bin/env node
/**
 * GeoNames "cities15000.txt" dosyasından Avrupa + Türkiye şehir listesini üretir.
 *
 * Kullanım:
 *   node scripts/build-cities.mjs /yol/cities15000.txt
 *
 * Kaynak: GeoNames (https://www.geonames.org), lisans CC BY 4.0.
 * Çıktı: data/cities.eu-tr.json  (nüfus >= 50.000 veya ülke başkenti)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
if (!input) {
  console.error("Kullanım: node scripts/build-cities.mjs /yol/cities15000.txt");
  process.exit(1);
}

// Avrupa + Türkiye. Rusya, Belarus ve Ukrayna bilinçli olarak dışarıda bırakılmıştır.
const COUNTRIES = new Set(
  (
    "AD AL AT BA BE BG CH CY CZ DE DK EE ES FI FR GB GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT " +
    "NL NO PL PT RO RS SE SI SK SM TR XK"
  ).split(" "),
);
const MIN_POP = 50_000;

const rows = fs.readFileSync(input, "utf8").split("\n");
const out = [];
for (const line of rows) {
  if (!line) continue;
  const c = line.split("\t");
  if (c.length < 19) continue;
  const [id, name, ascii, , lat, lng, , featureCode, cc, , , , , , pop] = c;
  if (!COUNTRIES.has(cc)) continue;
  // PPLX = bir şehrin bölümü/ilçesi (örn. "Paris 15 Vaugirard"); ana şehir zaten listede.
  if (featureCode === "PPLX") continue;
  const population = Number(pop) || 0;
  const capital = featureCode === "PPLC";
  if (population < MIN_POP && !capital) continue;
  out.push({
    id: Number(id),
    name,
    ascii,
    cc,
    lat: Math.round(Number(lat) * 1e4) / 1e4,
    lng: Math.round(Number(lng) * 1e4) / 1e4,
    pop: population,
    capital: capital || undefined,
  });
}

// "Paris 15 Vaugirard" gibi, ana şehri zaten listede olan numaralı bölge kayıtlarını ele.
const names = new Set(out.map((r) => `${r.cc}:${r.name}`));
const filtered = out.filter((r) => {
  const m = /^(.+?) \d{1,2}(?:\b|er\b|e\b)/.exec(r.name);
  return !(m && names.has(`${r.cc}:${m[1]}`));
});
out.length = 0;
out.push(...filtered);

out.sort((a, b) => a.cc.localeCompare(b.cc) || b.pop - a.pop);
const target = path.join(here, "..", "data", "cities.eu-tr.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));
const byCc = out.reduce((m, r) => ((m[r.cc] = (m[r.cc] ?? 0) + 1), m), {});
console.log(`${out.length} şehir yazıldı → ${path.relative(process.cwd(), target)}`);
console.log(
  Object.entries(byCc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}:${v}`)
    .join(" "),
);
