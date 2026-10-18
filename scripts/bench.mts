/**
 * Geliştirme aracı: 100.000 kayıtlık sentetik veritabanında liste/filtre/harita sorgu sürelerini ölçer (NFR-03: < 300 ms).
 * Kullanım: npx tsx scripts/bench.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-bench-"));
process.env.UM_DATA_DIR = dir;
process.env.UM_DB_PATH = path.join(dir, "bench.db");
process.env.UM_MIGRATIONS_DIR = path.resolve("drizzle");
process.env.UM_STATIC_DATA_DIR = path.resolve("data");

const { openDatabase } = await import("../src/lib/db/client");
const { runMigrations } = await import("../src/lib/db/migrate");
const { queryFacets, queryLeads, queryPoints } = await import("../src/lib/leads/query");
const { seedCategories } = await import("../src/lib/scan/categories");

const N = Number(process.env.BENCH_N ?? 100_000);
const { db, client } = await openDatabase(process.env.UM_DB_PATH);
await runMigrations(db, client);
await seedCategories(db);

const cities = [
  ["GB", "London", 51.5, -0.12],
  ["GB", "Manchester", 53.48, -2.24],
  ["NL", "Amsterdam", 52.37, 4.89],
  ["BE", "Brussels", 50.85, 4.35],
  ["FR", "Paris", 48.85, 2.35],
  ["DE", "Berlin", 52.52, 13.4],
  ["ES", "Madrid", 40.41, -3.7],
  ["IT", "Milan", 45.46, 9.19],
] as const;
const types = ["cafe", "coffee_shop", "pub", "bar", "restaurant", "bakery", "hotel"];
const labels = ["future_opening", "high", "likely", "low", "low", "low", "low", "low"];
const statuses = [
  "OPERATIONAL",
  "OPERATIONAL",
  "OPERATIONAL",
  "FUTURE_OPENING",
  "CLOSED_TEMPORARILY",
];
const now = Date.now();

console.log(`${N.toLocaleString("tr-TR")} kayıt oluşturuluyor…`);
const t0 = performance.now();
const BATCH = 2000;
for (let i = 0; i < N; i += BATCH) {
  const pl: string[] = [];
  const ld: string[] = [];
  for (let j = i; j < Math.min(N, i + BATCH); j++) {
    const c = cities[j % cities.length]!;
    const id = `p${j}`;
    const lat = c[2] + (Math.random() - 0.5) * 0.4;
    const lng = c[3] + (Math.random() - 0.5) * 0.6;
    const t = types[j % types.length]!;
    const st = statuses[j % statuses.length]!;
    pl.push(
      `('${id}','demo','Işletme ${j} ${t}','${j} Main St, ${c[1]}',${lat},${lng},'${c[0]}','${c[1]}','${t}','["${t}"]','${st}',${now},${now - (j % 90) * 86400000},${now},${now})`,
    );
    const lb = labels[j % labels.length]!;
    ld.push(
      `('${id}','demo',${lb === "future_opening" ? 100 : lb === "high" ? 70 : lb === "likely" ? 35 : j % 25},'${lb}','new',${now},${now})`,
    );
  }
  await client.execute(
    `INSERT INTO places (place_id,source,name,formatted_address,lat,lng,country_code,city,primary_type,types,business_status,google_fetched_at,first_seen_at,created_at,updated_at) VALUES ${pl.join(",")}`,
  );
  await client.execute(
    `INSERT INTO leads (place_id,source,novelty_score,novelty_label,status,created_at,updated_at) VALUES ${ld.join(",")}`,
  );
}
console.log(
  `  hazır: ${((performance.now() - t0) / 1000).toFixed(1)} sn, dosya ${(fs.statSync(process.env.UM_DB_PATH).size / 1e6).toFixed(0)} MB\n`,
);
await client.execute("ANALYZE");

async function time(name: string, fn: () => Promise<unknown>, runs = 5): Promise<number> {
  await fn(); // ısınma
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  const med = xs[Math.floor(xs.length / 2)]!;
  console.log(`${med < 300 ? "✔" : "✖"} ${name.padEnd(58)} ${med.toFixed(0).padStart(5)} ms`);
  return med;
}

const results: number[] = [];
const london = { south: 51.4, west: -0.3, north: 51.6, east: 0.1 };
results.push(
  await time("Liste: varsayılan (yenilik sırası, ilk 80 + toplam)", () =>
    queryLeads(db, {}, { limit: 80 }),
  ),
);
results.push(
  await time("Liste: derin sayfa (offset 50.000)", () =>
    queryLeads(db, {}, { limit: 80, offset: 50_000 }),
  ),
);
results.push(
  await time("Liste: ülke + yenilik süzgeci", () =>
    queryLeads(db, { countries: ["GB"], novelty: ["future_opening", "high"] }, { limit: 80 }),
  ),
);
results.push(
  await time("Liste: şehir + kategori", () =>
    queryLeads(db, { city: "London", categories: ["cafe"] }, { limit: 80 }),
  ),
);
results.push(
  await time("Liste: metin araması ('Işletme 12')", () =>
    queryLeads(db, { q: "Işletme 12" }, { limit: 80 }),
  ),
);
results.push(
  await time("Liste: harita kutusu", () => queryLeads(db, { bbox: london }, { limit: 80 })),
);
results.push(await time("Liste: ad sırası", () => queryLeads(db, {}, { sort: "name", limit: 80 })));
results.push(
  await time("Liste: en yeni tespit sırası", () =>
    queryLeads(db, {}, { sort: "recent", limit: 80 }),
  ),
);
results.push(await time("Harita noktaları (en çok 20.000)", () => queryPoints(db, {})));
results.push(
  await time("Harita noktaları: harita kutusu", () => queryPoints(db, { bbox: london })),
);
results.push(await time("Süzgeç sayıları (facet)", () => queryFacets(db, {})));

client.close();
fs.rmSync(dir, { recursive: true, force: true });
const worst = Math.max(...results);
console.log(`\nEn yavaş: ${worst.toFixed(0)} ms (hedef < 300 ms)`);
process.exit(worst < 300 ? 0 : 1);
