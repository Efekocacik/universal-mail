import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, InStatement } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { queryLeads, type LeadFilters } from "@/lib/leads/query";
import { comboFilters, medianMs, perfCases, singleFilters } from "./helpers/perf-cases";
import { seedLeads, type SeedLeadsResult } from "./helpers/seed-leads";

/**
 * Faz 6 (paket G, NFR-03, yol haritası madde 9): 100.000 lead'de her Keşfet sorgusu < 300 ms.
 *
 * - Veri `seed-leads.ts` ile belirlenimci üretilir (`UM_PERF_N` ile değiştirilebilir; varsayılan 100 000).
 * - Her durum: bir ısınma + 3 ölçümün ORTANCASI. CI'da aynı anda başka test dosyaları da çalıştığı için eşiği aşan
 *   durumlar tüm durumlar bittikten SONRA en çok iki tur daha ölçülür ve en iyi ortanca alınır (gürültüye karşı; gerçek
 *   yavaşlık üç turda da aşar).
 * - İki kip: istatistiksiz (uygulama `ANALYZE` çalıştırmaz; gerçek kurulumdaki durum) ve `ANALYZE` sonrası (sözleşme).
 * - Zamandan bağımsız (belirlenimci) koruma: sorgu planlarında eksik indeks belirtisi (otomatik indeks, sürücü tablo
 *   dışında tam tarama) yoktur ve liste sayfası geniş sütunları yalnızca seçili kimlikler için okur.
 */

/** Derleme anında eksiksiz: `LeadFilters`'a yeni bir süzgeç eklenince burası (ve durum listesi) güncellenmelidir. */
const ALL_FILTER_KEYS: Record<keyof LeadFilters, true> = {
  q: true,
  countries: true,
  city: true,
  categories: true,
  novelty: true,
  leadStatus: true,
  businessStatus: true,
  source: true,
  registryMatch: true,
  bbox: true,
  hasWebsite: true,
  ratingMin: true,
  ratingMax: true,
  scanId: true,
  emailStatus: true,
  notFound: true,
  archived: true,
  ids: true,
  lifecycle: true,
  detectedSince: true,
};

const N = Number(process.env.UM_PERF_N ?? 100_000);
const LIMIT_MS = 300;
const ROUNDS = 3;

let dir = "";
let db: Db;
let client: Client;
let seeded: SeedLeadsResult;
let ids: number[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-perf-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = path.join(dir, "perf.db");
  process.env.UM_MIGRATIONS_DIR = path.resolve(__dirname, "..", "drizzle");
  process.env.UM_STATIC_DATA_DIR = path.resolve(__dirname, "..", "data");
  const h = await openDatabase(process.env.UM_DB_PATH);
  db = h.db;
  client = h.client;
  await runMigrations(db, client);
  seeded = await seedLeads(client, { n: N, seed: 42 });
  ids = (await client.execute("SELECT id FROM leads ORDER BY id DESC LIMIT 2000")).rows.map((r) =>
    Number(r.id),
  );
}, 180_000);

afterAll(() => {
  client?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function measureAll(): Promise<{ failures: string[]; worst: [string, number] }> {
  const cases = perfCases({ scanId: seeded.scanIds[1], now: seeded.now, ids });
  const best = new Map<string, number>();
  // İlk tur her durumu ölçer; eşiği aşanlar turun SONUNDA yeniden ölçülür (ertelenmiş tekrar). Paralel çalışan başka test
  // dosyalarının yarattığı geçici yük o arada geçer; gerçek yavaşlık ise her turda aşar.
  let pending = cases;
  for (let round = 0; round < ROUNDS && pending.length; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 2000));
    for (const c of pending) {
      const ms = await medianMs(() => c.run(db), 3);
      best.set(c.name, Math.min(best.get(c.name) ?? Infinity, ms));
    }
    pending = pending.filter((c) => best.get(c.name)! >= LIMIT_MS);
  }
  let worst: [string, number] = ["", 0];
  for (const [name, ms] of best) if (ms > worst[1]) worst = [name, ms];
  return { failures: pending.map((c) => `${c.name}: ${best.get(c.name)!.toFixed(0)} ms`), worst };
}

/** Bir çağrının çalıştırdığı SQL ifadelerini (parametreleriyle) yakalar. */
async function captureStatements(fn: () => Promise<unknown>): Promise<InStatement[]> {
  const seen: InStatement[] = [];
  const original = client.execute.bind(client);
  const spy = ((stmt: InStatement) => {
    seen.push(stmt);
    return original(stmt as never);
  }) as Client["execute"];
  client.execute = spy;
  try {
    await fn();
  } finally {
    client.execute = original as Client["execute"];
  }
  return seen;
}

async function planOf(stmt: InStatement): Promise<string[]> {
  const s = typeof stmt === "string" ? { sql: stmt, args: [] } : stmt;
  const r = await client.execute({ sql: `EXPLAIN QUERY PLAN ${s.sql}`, args: s.args ?? [] });
  return r.rows.map((x) => String(x.detail));
}

describe(`NFR-03: ${N.toLocaleString("tr-TR")} lead'de Keşfet sorguları < ${LIMIT_MS} ms`, () => {
  it("veri beklenen dağılımdadır", () => {
    expect(seeded.leads).toBe(N);
    expect(seeded.archived).toBeGreaterThan(0);
    expect(seeded.registry).toBeGreaterThan(0);
    expect(ids.length).toBe(Math.min(2000, N));
  });

  it("istatistiksiz (uygulamanın gerçek durumu): her durum eşiğin altında", async () => {
    const { failures, worst } = await measureAll();
    console.info(`[perf] istatistiksiz en yavaş: ${worst[0]} ${worst[1].toFixed(0)} ms`);
    expect(failures).toEqual([]);
  }, 300_000);

  it("ANALYZE sonrası: her durum eşiğin altında", async () => {
    await client.execute("ANALYZE");
    const { failures, worst } = await measureAll();
    console.info(`[perf] ANALYZE sonrası en yavaş: ${worst[0]} ${worst[1].toFixed(0)} ms`);
    expect(failures).toEqual([]);
  }, 300_000);

  it("sorgu planları: otomatik indeks yok, sürücü tablo dışında tam tarama yok", async () => {
    const ctx = { scanId: seeded.scanIds[1], now: seeded.now, ids };
    const problems: string[] = [];
    for (const c of perfCases(ctx)) {
      for (const stmt of await captureStatements(() => c.run(db))) {
        for (const line of await planOf(stmt)) {
          if (/AUTOMATIC/i.test(line)) problems.push(`${c.name}: ${line}`);
          // Yalnızca sürücü tablo `leads` indekssiz taranabilir; diğer tablolar indeksle aranır ya da (kısmi) indeks
          // üzerinden taranır (`SCAN places USING INDEX places_future_watch_idx` gibi).
          const scan = /^SCAN (\S+)(.*)$/.exec(line);
          if (
            scan &&
            !/USING (COVERING )?INDEX|VIRTUAL TABLE/.test(scan[2]!) &&
            scan[1] !== "leads"
          )
            problems.push(`${c.name}: ${line}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("liste sayfası geç satır okuma yapar: geniş sütunlar yalnızca sayfadaki kimlikler için okunur", async () => {
    const stmts = await captureStatements(() => queryLeads(db, {}, { limit: 80, offset: 50_000 }));
    const list = stmts.find((s) => /lead_emails/.test(typeof s === "string" ? s : s.sql));
    expect(list).toBeDefined();
    const plan = await planOf(list!);
    // Dış sorgu `leads`'i birincil anahtarla arar (tam tarama değil); sıralama yalnızca iç kimlik sorgusundadır.
    expect(plan.some((l) => /^SEARCH leads USING INTEGER PRIMARY KEY/.test(l))).toBe(true);
    expect(plan.filter((l) => /^SCAN leads\b/.test(l))).toHaveLength(1);
  });

  it("geç satır okuma sonucu değiştirmez: sayfalar örtüşmez, sıra ve toplam tutarlıdır", async () => {
    for (const sort of ["novelty", "name", "recent"] as const) {
      const a = await queryLeads(db, { countries: ["GB"] }, { sort, limit: 100, offset: 0 });
      const b = await queryLeads(db, { countries: ["GB"] }, { sort, limit: 100, offset: 100 });
      const both = await queryLeads(db, { countries: ["GB"] }, { sort, limit: 200, offset: 0 });
      expect(both.rows.map((r) => r.leadId)).toEqual([...a.rows, ...b.rows].map((r) => r.leadId));
      expect(a.total).toBe(both.total);
      expect(a.rows).toHaveLength(100);
    }
    const deep = await queryLeads(db, {}, { limit: 80, offset: N - 10 });
    expect(deep.rows.length).toBeLessThanOrEqual(10);
  });

  it("durum listesi tüm tek süzgeçleri ve temsilî birleşimleri kapsar", () => {
    const ctx = { scanId: 1, now: 0, ids: [1] };
    const keys = new Set(singleFilters(ctx).flatMap(([, f]) => Object.keys(f)));
    for (const k of Object.keys(ALL_FILTER_KEYS)) expect(keys.has(k), k).toBe(true);
    expect(comboFilters(ctx).length).toBeGreaterThanOrEqual(11);
  });
});
