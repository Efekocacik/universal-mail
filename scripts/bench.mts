/**
 * Geliştirme aracı: 100.000 kayıtlık sentetik veritabanında Keşfet sorgularının sürelerini ölçer (NFR-03: < 300 ms).
 * Veri `tests/helpers/seed-leads.ts`, durumlar `tests/helpers/perf-cases.ts` (otomatik test `tests/perf-100k.test.ts`
 * ile AYNI liste). Geçici klasör kullanır; gerçek veri klasörüne ve ağa dokunmaz.
 *
 * Kullanım: npm run bench            (BENCH_N=200000 npm run bench gibi kayıt sayısı değiştirilebilir)
 *           BENCH_NO_ANALYZE=1       istatistik tablosu (sqlite_stat1) olmadan ölçer.
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
const { seedLeads } = await import("../tests/helpers/seed-leads");
const { medianMs, perfCases } = await import("../tests/helpers/perf-cases");

const N = Number(process.env.BENCH_N ?? 100_000);
const LIMIT_MS = 300;
let worst = 0;
let failed = 0;
try {
  const { db, client } = await openDatabase(process.env.UM_DB_PATH);
  await runMigrations(db, client);
  console.log(`${N.toLocaleString("tr-TR")} kayıt oluşturuluyor…`);
  const t0 = performance.now();
  const seeded = await seedLeads(client, { n: N, seed: 42 });
  if (process.env.BENCH_NO_ANALYZE !== "1") await client.execute("ANALYZE");
  console.log(
    `  hazır: ${((performance.now() - t0) / 1000).toFixed(1)} sn, dosya ${(fs.statSync(process.env.UM_DB_PATH).size / 1e6).toFixed(0)} MB\n`,
  );
  const ids = (await client.execute("SELECT id FROM leads ORDER BY id DESC LIMIT 2000")).rows.map(
    (r) => Number(r.id),
  );
  for (const c of perfCases({ scanId: seeded.scanIds[1], now: seeded.now, ids })) {
    const ms = await medianMs(() => c.run(db), 3);
    worst = Math.max(worst, ms);
    if (ms >= LIMIT_MS) failed++;
    console.log(
      `${ms < LIMIT_MS ? "✔" : "✖"} ${c.name.padEnd(64)} ${ms.toFixed(0).padStart(5)} ms`,
    );
  }
  client.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\nEn yavaş: ${worst.toFixed(0)} ms (hedef < ${LIMIT_MS} ms), aşan: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
