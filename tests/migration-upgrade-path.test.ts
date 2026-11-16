import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import {
  partialMigrations as makePartial,
  SOURCE_MIGRATIONS,
  TOTAL_MIGRATIONS,
} from "./helpers/migration-dirs";

/**
 * Faz 6 (sözleşme K.3, NFR-10): GEÇMİŞTEKİ HER şema sürümünden (0000..0005) güncel sürüme yükseltme. Her k için:
 *   1. yalnızca 0..k geçişlerini içeren geçici bir migrasyon klasörüyle yeni veritabanı kurulur (o sürümün kurulumu),
 *   2. tests/fixtures/schema/0000..k.sql fikstürleri SIRAYLA yüklenir (o sürüme kadar oluşmuş, temsilî veri),
 *   3. tam migrasyon klasörüyle `runMigrations` çalışır (yeni sürümün açılışı).
 * Beklenenler: bekleyen geçiş sayısı = toplam − (k+1); geçiş öncesi yedek dosyası var; bütünlük ve yabancı anahtar
 * denetimi temiz; ESKİ tablolardaki her satırın eski sütunları bire bir aynı; fikstür başına açık değer beklentileri;
 * `__drizzle_migrations` = toplam; ikinci açılış hiçbir şey değiştirmez. Yalnızca geçici klasörler; gerçek `.data` yok.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const SOURCE = SOURCE_MIGRATIONS;
const FIXTURES = path.join(__dirname, "fixtures", "schema");
const TOTAL = TOTAL_MIGRATIONS;
/** Fikstürü olan geçmiş şemalar (güncel 0006 hariç). */
const HISTORIC = [0, 1, 2, 3, 4, 5] as const;

const partialDirs: string[] = [];
function partialMigrations(count: number): string {
  const d = makePartial(count, "um-up-mig-");
  partialDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of partialDirs) fs.rmSync(d, { recursive: true, force: true });
});

const fixture = (k: number) =>
  fs.readFileSync(path.join(FIXTURES, `${String(k).padStart(4, "0")}.sql`), "utf8");

type Row = unknown[];
async function q(c: Client, sql: string): Promise<Row[]> {
  const r = await c.execute(sql);
  return r.rows.map((row) => r.columns.map((col) => row[col]));
}

/**
 * Fikstür başına AÇIK beklentiler (anlık görüntü değil). k. şemadan yükseltmede 0..k fikstürlerinin beklentileri hem
 * yükseltmeden önce (fikstür gerçekten yüklendi) hem sonra (veri korundu) aynı olmalıdır. Her beklenti yalnızca kendi
 * fikstüründe yazılan ve sonraki fikstürlerin değiştirmediği değerlere bakar.
 */
const CHECKS: Record<(typeof HISTORIC)[number], Array<[string, Row[]]>> = {
  0: [
    [
      "SELECT key, value FROM settings WHERE key IN ('setup.completed','budget.monthlyUsd','places.provider','targets.countries') ORDER BY key",
      [
        ["budget.monthlyUsd", "25"],
        ["places.provider", '"mock"'],
        ["setup.completed", "true"],
        ["targets.countries", '["GB","NL"]'],
      ],
    ],
    [
      "SELECT id, place_id, display_name, novelty_score, novelty_label, notes, tags, created_at FROM leads WHERE id <= 3 ORDER BY id",
      [
        [1, "fx-place-1", "Kafe 0001", 72, "high", "Not: kapı sağda", '["vip"]', 1795000060000],
        [2, "fx-place-2", "Kafe 0002", 90, "future_opening", null, "[]", 1795000060000],
        [3, "fx-place-3", "Kafe 0003", 10, "low", null, "[]", 1795000060000],
      ],
    ],
    [
      "SELECT place_id, was_future, is_closed, first_seen_at FROM places ORDER BY place_id",
      [
        ["fx-place-1", 0, 0, 1795000050000],
        ["fx-place-2", 1, 0, 1795000050000],
        ["fx-place-3", 0, 1, 1795000050000],
      ],
    ],
    [
      "SELECT id, scan_key, provider, status, is_baseline FROM scans WHERE id = 1",
      [[1, "fixture-london", "mock", "completed", 1]],
    ],
    ["SELECT COUNT(*) FROM place_snapshots WHERE scan_id = 1", [[3]]],
    [
      "SELECT id, name, geometry FROM regions",
      [[1, "Londra merkez", '{"south":51.48,"west":-0.17,"north":51.54,"east":-0.07}']],
    ],
    [
      "SELECT key, enabled, built_in FROM category_sets WHERE key = 'fixture_cafe'",
      [["fixture_cafe", 1, 0]],
    ],
    ["SELECT id, status, dedupe_key FROM jobs", [[1, "done", "scan:1"]]],
    ["SELECT action, entity_id FROM audit_log WHERE id = 1", [["scan.start", "1"]]],
  ],
  1: [
    [
      "SELECT id, lead_id, email, is_primary, primary_pinned, verify_status FROM lead_emails ORDER BY id",
      [
        [1, 1, "info@kafe-0001.example", 1, 0, "valid"],
        [2, 1, "ayse@kafe-0001.example", 0, 0, "unverified"],
        [3, 2, "hello@kafe-0002.example", 1, 1, "risky"],
      ],
    ],
    [
      "SELECT lead_id, type, url FROM lead_contacts",
      [[1, "instagram", "https://social.example/kafe0001"]],
    ],
    [
      "SELECT lead_id, status, email_status, external_used FROM lead_enrichment ORDER BY lead_id",
      [
        [1, "done", "found", 0],
        [2, "done", "found", 1],
      ],
    ],
  ],
  2: [
    [
      "SELECT id, provider, address, status FROM mailboxes",
      [[1, "demo", "demo@firma.example", "connected"]],
    ],
    [
      "SELECT id, kind, version, subject FROM templates WHERE id IN (1, 2) ORDER BY id",
      [
        [1, "initial", 2, "Hello {{business}}"],
        [2, "followup", 1, "Re: Hello"],
      ],
    ],
    [
      "SELECT id, status, mailbox_id, start_confirmed_at FROM campaigns",
      [[1, "running", 1, 1795000200000]],
    ],
    ["SELECT COUNT(*) FROM campaign_steps WHERE campaign_id = 1", [[2]]],
    [
      "SELECT id, status, next_step, recipient_hash FROM campaign_leads WHERE id = 1",
      [[1, "waiting_next", 1, "hash-0001"]],
    ],
    [
      "SELECT id, direction, purpose, status, idempotency_key, classification FROM messages WHERE id <= 3 ORDER BY id",
      [
        [1, "out", "campaign", "sent", "c1:l1:s0", null],
        [2, "out", "test", "sent", null, null],
        [3, "in", "inbound", "matched", null, "reply"],
      ],
    ],
    [
      "SELECT id, scope, reason, message_id FROM suppressions ORDER BY id",
      [
        [1, "domain", "manual", null],
        [2, "email", "unsubscribe", 3],
      ],
    ],
    [
      "SELECT mode FROM country_policies WHERE scope = 'demo' AND country_code = 'ZZ'",
      [["allowed"]],
    ],
    ["SELECT status, last_contacted_at FROM leads WHERE id = 1", [["sent", 1795000300000]]],
  ],
  3: [
    [
      "SELECT status, stop_reason FROM campaign_leads WHERE id = 2",
      [["unsubscribed", "complaint"]],
    ],
    [
      "SELECT classification, error_code FROM messages WHERE id = 4",
      [["complaint", "arf_complaint"]],
    ],
  ],
  4: [
    [
      "SELECT id, interval_days, enabled, last_outcome FROM scan_schedules",
      [[1, 7, 1, "completed"]],
    ],
    ["SELECT origin, schedule_id, schedule_slot FROM scans WHERE id = 2", [["schedule", 1, 1]]],
    ["SELECT kind, url, read_at FROM notifications", [["scan.done", "/scans", null]]],
    ["SELECT name_key, sort FROM saved_filters", [["londra kafeleri", "novelty"]]],
    ["SELECT domain, status FROM domain_registrations", [["kafe-0001.example", "ok"]]],
    ["SELECT id, archived_at FROM leads WHERE archived_at IS NOT NULL", [[3, 1795000650000]]],
    ["SELECT site_domain FROM lead_enrichment WHERE lead_id = 1", [["kafe-0001.example"]]],
  ],
  5: [
    ["SELECT id, status, matched_count FROM registry_runs", [[1, "done", 1]]],
    [
      "SELECT external_id, match_status, matched_place_id, lead_id FROM registry_companies",
      [["FX000001", "matched", "fx-place-1", 1]],
    ],
    ["SELECT batch_id, lead_id, row_number FROM import_batch_leads", [[1, 4, 2]]],
    [
      "SELECT id, source, website FROM leads WHERE id = 4",
      [[4, "import", "https://kafe-0004.example"]],
    ],
    ["SELECT lead_id, status, approved_at FROM lead_intros", [[1, "approved", 1795001100000]]],
    ["SELECT template_id FROM campaign_step_templates", [[1]]],
    ["SELECT message_id, open_count, source FROM message_opens", [[1, 2, "demo_simulated"]]],
    ["SELECT subject_b FROM templates WHERE id = 1", [["Hi {{business}}"]]],
    ["SELECT subject_variant FROM messages WHERE id = 1", [["a"]]],
  ],
};

async function tablesOf(c: Client): Promise<string[]> {
  return (
    await q(
      c,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
  ).map((r) => String(r[0]));
}
async function columnsOf(c: Client, table: string): Promise<string[]> {
  return (await q(c, `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)).map((r) =>
    String(r[0]),
  );
}
/** Tablo → (yalnızca verilen sütunlar, rowid sırasıyla) satırlar. */
async function dump(c: Client, cols: Record<string, string[]>): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [t, cs] of Object.entries(cols))
    out[t] = await q(c, `SELECT ${cs.map((x) => `"${x}"`).join(", ")} FROM "${t}" ORDER BY rowid`);
  return out;
}

const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let dir = "";
const clients: Client[] = [];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-up-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = path.join(dir, "universal-mail.db");
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function open() {
  const h = await openDatabase(process.env.UM_DB_PATH!);
  clients.push(h.client);
  return h;
}

describe.each(HISTORIC)("şema %i sürümünden güncel sürüme yükseltme", (k) => {
  it("veri korunur, yedek alınır, bütünlük temiz, ikinci açılış değişiklik yapmaz", async () => {
    // 1) Eski sürümün kurulumu (yalnızca 0..k geçişleri) ve o sürüme kadar oluşmuş veri.
    process.env.UM_MIGRATIONS_DIR = partialMigrations(k + 1);
    const old = await open();
    expect((await runMigrations(old.db, old.client)).pending).toBe(k + 1);
    for (let j = 0; j <= k; j++) await old.client.executeMultiple(fixture(j));
    for (let j = 0; j <= k; j++)
      for (const [sql, rows] of CHECKS[j as (typeof HISTORIC)[number]])
        expect(await q(old.client, sql), `önce: ${sql}`).toEqual(rows);
    const oldTables = await tablesOf(old.client);
    const oldCols: Record<string, string[]> = {};
    for (const t of oldTables) oldCols[t] = await columnsOf(old.client, t);
    const before = await dump(old.client, oldCols);
    const seqBefore = await q(old.client, "SELECT name, seq FROM sqlite_sequence ORDER BY name");
    expect(Object.values(before).reduce((n, rows) => n + rows.length, 0)).toBeGreaterThan(10);
    old.client.close();
    clients.splice(clients.indexOf(old.client), 1);

    // 2) Yeni sürümün açılışı: tam migrasyon klasörü.
    process.env.UM_MIGRATIONS_DIR = SOURCE;
    const h = await open();
    const r = await runMigrations(h.db, h.client);
    expect(r.pending).toBe(TOTAL - (k + 1));
    expect(r.backupPath).toBeTruthy();
    expect(path.dirname(r.backupPath!)).toBe(path.join(dir, "backups"));
    expect(path.basename(r.backupPath!)).toMatch(/^pre-migrate-[0-9A-Za-z-]+\.db$/);
    expect(fs.existsSync(r.backupPath!)).toBe(true);

    // 3) Bütünlük.
    expect(await q(h.client, "PRAGMA integrity_check")).toEqual([["ok"]]);
    expect(await q(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await q(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toEqual([[TOTAL]]);

    // 4) Eski tabloların eski sütunları bire bir aynı; tablo kaybolmadı; açık beklentiler.
    const newTables = await tablesOf(h.client);
    for (const t of oldTables) expect(newTables, t).toContain(t);
    expect(await dump(h.client, oldCols)).toEqual(before);
    for (let j = 0; j <= k; j++)
      for (const [sql, rows] of CHECKS[j as (typeof HISTORIC)[number]])
        expect(await q(h.client, sql), `sonra: ${sql}`).toEqual(rows);
    for (const [name, seq] of seqBefore) {
      const now = await q(
        h.client,
        `SELECT seq FROM sqlite_sequence WHERE name = '${String(name)}'`,
      );
      expect(Number(now[0]?.[0]), String(name)).toBeGreaterThanOrEqual(Number(seq));
    }

    // 5) Yedek, yükseltme öncesi veriyi taşır (geri dönüş gerçekten mümkün).
    const bak = await openDatabase(r.backupPath!);
    clients.push(bak.client);
    expect(await dump(bak.client, oldCols)).toEqual(before);
    expect(await q(bak.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toEqual([[k + 1]]);

    // 6) İkinci açılış: bekleyen yok, yeni yedek yok, veri aynı.
    const backupsBefore = fs.readdirSync(path.join(dir, "backups")).sort();
    const again = await runMigrations(h.db, h.client);
    expect(again).toEqual({ pending: 0 });
    expect(fs.readdirSync(path.join(dir, "backups")).sort()).toEqual(backupsBefore);
    expect(await dump(h.client, oldCols)).toEqual(before);
  }, 60_000);
});

describe("fikstürler", () => {
  it("her geçmiş şema için bir fikstür var ve gerçek kişi/alan adı içermez", () => {
    const files = fs.readdirSync(FIXTURES).sort();
    expect(files).toEqual(HISTORIC.map((k) => `${String(k).padStart(4, "0")}.sql`));
    for (const f of files) {
      const sql = fs.readFileSync(path.join(FIXTURES, f), "utf8");
      // Yalnızca ayrılmış/örnek alan adları: .example
      for (const m of sql.matchAll(/@([a-z0-9.-]+)/gi)) expect(m[1], f).toMatch(/\.example$/);
      for (const m of sql.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))
        expect(m[1], f).toMatch(/\.example$/);
    }
  });
});
