import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { maintenancePathFor } from "@/lib/db/maintenance";
import { runMigrations } from "@/lib/db/migrate";
import { RollbackError } from "@/lib/db/rollback-0003";
import {
  AUDIT_ACTION_0004,
  executeRollback0004,
  FAZ4_INDEXES_ON_EXISTING,
  FAZ4_TABLES,
  planRollback0004,
  rollbackFaz4,
} from "@/lib/db/rollback-0004";

/**
 * Migrasyon 0004 (Faz 4 P0): YALNIZCA EKLEME (yeni tablolar, `ALTER TABLE … ADD` sütunlar, indeksler). Dolu bir 0003
 * veritabanında veri korunur, varsayılanlar doğru, kısıtlar veritabanı düzeyinde çalışır, eski sürüm yazımları çalışır ve
 * geri alma (kayıplı, onaylı) 0003 şemasını bire bir geri getirir. Yalnızca GEÇİCİ dosya veritabanları; gerçek `.data`
 * kullanılmaz.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(tmpBase);
const REPO = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(REPO, "drizzle");
const T = 1_790_000_000_000;

function partialMigrations(count: number): string {
  const d = fs.mkdtempSync(path.join(tmpBase, "um-mig4-"));
  fs.mkdirSync(path.join(d, "meta"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(d, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[])
    fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(d, `${e.tag}.sql`));
  return d;
}

const UPTO_0003 = partialMigrations(4);
afterAll(() => fs.rmSync(UPTO_0003, { recursive: true, force: true }));

let dir: string;
let file: string;
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-m4-"));
  file = path.join(dir, "test.db");
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = file;
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows'ta geçici dosya silme hatası (bilinen ortam sorunu) */
  }
});

async function handle(f = file) {
  const h = await openDatabase(f);
  clients.push(h.client);
  return h;
}
async function rows(c: Client, sql: string): Promise<Record<string, unknown>[]> {
  return (await c.execute(sql)).rows.map((r) => ({ ...r }));
}
const num = async (c: Client, sql: string) => Number((await c.execute(sql)).rows[0]?.[0] ?? 0);
async function tryx(c: Client, sql: string): Promise<string> {
  try {
    await c.execute(sql);
    return "OK";
  } catch (e) {
    return String((e as Error).message);
  }
}
const norm = (s: unknown) =>
  String(s ?? "")
    .replace(/["`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function dump(c: Client): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const names = (
    await rows(
      c,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
  ).map((r) => String(r.name));
  for (const t of names) out[t] = await rows(c, `SELECT * FROM "${t}" ORDER BY rowid`);
  out.__seq = await rows(c, "SELECT name, seq FROM sqlite_sequence ORDER BY name");
  return out;
}
async function schema(c: Client): Promise<string[]> {
  return (
    await rows(
      c,
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND sql IS NOT NULL ORDER BY type, name",
    )
  ).map((r) => `${r.type}:${r.name}:${norm(r.sql)}`);
}

/** 0003 şemasında (ilk 4 geçiş) veritabanı. */
async function build0003(f = file) {
  const h = await handle(f);
  process.env.UM_MIGRATIONS_DIR = UPTO_0003;
  await runMigrations(h.db, h.client);
  return h;
}

async function upgrade(h: Awaited<ReturnType<typeof handle>>) {
  process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
  return runMigrations(h.db, h.client);
}

/** Faz 1–3 verisi (0003 şeması): her etkilenen tabloda satır, silinmiş en yüksek tarama kimliği. */
async function seed0003(c: Client): Promise<void> {
  const geo = `'{"bbox":{"south":51.4,"west":-0.2,"north":51.6,"east":0.1}}'`;
  await c.batch(
    [
      `INSERT INTO regions(id,name,kind,geometry,created_at) VALUES (1,'Londra','city',${geo},${T}),(2,'Boş bölge','bbox',${geo},${T})`,
      `INSERT INTO scans(id,region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,pause_reason,created_at,finished_at) VALUES
        (1,1,'k1','[1]','[]','text','discovery','mock','completed',NULL,${T},${T + 10}),
        (2,1,'k1','[1]','[]','text','discovery','mock','paused','Bütçe doldu',${T + 20},NULL),
        (3,1,'k2','[2]','[]','nearby','enrich','mock','completed',NULL,${T + 30},${T + 40})`,
      "DELETE FROM scans WHERE id = 3",
      `INSERT INTO scan_units(scan_id,south,west,north,east,kind,term_kind,term,status,updated_at) VALUES (1,51.4,-0.2,51.6,0.1,'text','type','cafe','done',${T}),(2,51.4,-0.2,51.6,0.1,'text','type','cafe','queued',${T})`,
      `INSERT INTO places(place_id,source,lat,lng,coords_fetched_at,was_future,is_closed,first_seen_scan_id,first_seen_at,new_detected_at,opened_detected_at,created_at,updated_at) VALUES
        ('p1','demo',51.5,-0.1,${T},0,0,1,${T},${T},NULL,${T},${T}),
        ('p2','demo',51.5,-0.1,${T},1,0,1,${T},NULL,NULL,${T},${T}),
        ('p3','demo',NULL,NULL,${T},0,0,1,${T},NULL,${T + 5},${T},${T})`,
      "INSERT INTO place_snapshots(scan_id,place_id,was_future) VALUES (1,'p1',0),(1,'p2',1)",
      `INSERT INTO leads(id,place_id,source,display_name,status,created_at,updated_at) VALUES (1,'p1','demo','Örnek Kafe','new',${T},${T}),(2,'p2','demo',NULL,'do_not_contact',${T},${T}),(3,NULL,'import','İçe aktarılan','sent',${T},${T})`,
      `INSERT INTO lead_enrichment(lead_id,status,email_status,attempts,pages_fetched,updated_at) VALUES (1,'done','found_verified',1,3,${T}),(3,'failed','not_found',2,1,${T})`,
      `INSERT INTO templates(id,name,language,kind,subject,body_html,body_text,created_at,updated_at) VALUES (1,'İlk','en','initial','Hello','<p>Hi</p>','Hi',${T},${T}),(2,'Takip','en','followup','Re','<p>Again</p>','Again',${T},${T})`,
      `INSERT INTO mailboxes(id,provider,label,address,status,created_at,updated_at) VALUES (1,'demo','Demo','demo@universal-mail.invalid','connected',${T},${T})`,
      `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,received_at,created_at) VALUES ('in','inbound',1,'<a@t>','h','d.test','received',${T},${T})`,
      `INSERT INTO settings(key,value,updated_at) VALUES ('budget.monthlyUsd','30',${T})`,
      `INSERT INTO audit_log(at,action,entity,entity_id,detail) VALUES (${T},'consent.accepted','consent','1','{}')`,
    ],
    "write",
  );
}

/** 0004 eklemeleri: yeni sütunların varsayılanları ve yeni tablolar. */
const NEW_COLUMNS: Record<string, Record<string, unknown>> = {
  scans: { origin: "manual", schedule_id: null, schedule_slot: null, pause_code: null },
  places: { place_id_checked_at: null, gone_at: null, status_checked_at: null },
  leads: { archived_at: null },
  lead_enrichment: { site_domain: null },
  templates: { followup_reuse_subject: 1 },
};

describe.skipIf(unsafeTmp)("0004: veri korunur, varsayılanlar, şema", () => {
  it("dolu 0003 veritabanında hiçbir satır kaybolmaz/değişmez; yeni sütunlar varsayılanla gelir; şema taze kurulumla aynı", async () => {
    const h = await build0003();
    await seed0003(h.client);
    const before = await dump(h.client);
    const res = await upgrade(h);
    expect(res.pending).toBe(1);
    expect(res.backupPath && fs.existsSync(res.backupPath)).toBe(true);
    const after = await dump(h.client);

    for (const t of Object.keys(before)) {
      const added = NEW_COLUMNS[t];
      if (!added) {
        expect(after[t], t).toEqual(before[t]);
        continue;
      }
      expect(after[t], t).toHaveLength(before[t]!.length);
      after[t]!.forEach((row, i) =>
        expect(row, `${t}#${i}`).toEqual({ ...before[t]![i], ...added }),
      );
    }
    for (const t of FAZ4_TABLES) expect(after[t], t).toEqual([]);
    expect(after.__seq).toEqual(before.__seq); // silinmiş en yüksek kimlik yeniden kullanılmaz

    // Taze kurulum ile yükseltilmiş veritabanı aynı şemada
    const fresh = await handle(path.join(dir, "fresh.db"));
    process.env.UM_DB_PATH = path.join(dir, "fresh.db");
    await runMigrations(fresh.db, fresh.client);
    process.env.UM_DB_PATH = file;
    expect(await schema(h.client)).toEqual(await schema(fresh.client));
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await num(h.client, "PRAGMA foreign_keys")).toBe(1);
    expect(await rows(h.client, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("migrasyon SQL'i yalnızca ekler: tablo yeniden kurma, DROP, veri taşıma yok; adlar tekil", () => {
    const text = fs.readFileSync(path.join(MIGRATIONS, "0004_faz4.sql"), "utf8");
    const statements = text
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((l) => !l.startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(statements.join("\n")).not.toMatch(
      /\bDROP\b|__new|\bINSERT\b|\bRENAME\b|\bPRAGMA\b|^\s*UPDATE\b/im,
    );
    for (const s of statements)
      expect(s).toMatch(
        /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE `(scans|places|leads|lead_enrichment|templates)` ADD `)/,
      );
    const names = [...text.matchAll(/INDEX IF NOT EXISTS `([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const i of FAZ4_INDEXES_ON_EXISTING) expect(names).toContain(i);
    // Günlük ve anlık görüntü tutarlı (tek 0004)
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.map((e) => e.tag).slice(-1)).toEqual(["0004_faz4"]);
    expect(journal.entries[4]!.when).toBeGreaterThan(journal.entries[3]!.when);
    const snap = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "0004_snapshot.json"), "utf8"),
    ) as { tables: Record<string, unknown>; prevId: string };
    const prev = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "0003_snapshot.json"), "utf8"),
    ) as { id: string };
    expect(snap.prevId).toBe(prev.id);
    for (const t of FAZ4_TABLES) expect(Object.keys(snap.tables)).toContain(t);
  });

  it("yarıda kalan 0004 hiçbir iz bırakmaz (tek işlem); engel kalkınca yeniden uygulanır", async () => {
    const h = await build0003();
    await seed0003(h.client);
    // Son ifadelerden birini bozacak çakışma: 0004'ün eklediği sütun önceden var
    await h.client.execute("ALTER TABLE `templates` ADD `followup_reuse_subject` integer");
    const before = await schema(h.client);
    const dBefore = await dump(h.client);
    await expect(upgrade(h)).rejects.toThrow(/duplicate column|followup_reuse_subject/i);
    expect(await schema(h.client)).toEqual(before); // yeni tablo, sütun, indeks yok
    expect(await dump(h.client)).toEqual(dBefore);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    await h.client.execute("ALTER TABLE `templates` DROP COLUMN `followup_reuse_subject`");
    expect((await upgrade(h)).pending).toBe(1);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
    for (const tbl of FAZ4_TABLES)
      expect(await num(h.client, `SELECT COUNT(*) FROM sqlite_master WHERE name = '${tbl}'`)).toBe(
        1,
      );
  });

  it("şema (schema.ts) ile 0004 anlık görüntüsü aynı: drizzle-kit generate yeni migrasyon üretmez", () => {
    // Elle yazılmış 0004'ün schema.ts ile kaymadığının kanıtı. Kopya klasörde çalışır; depodaki drizzle/ değişmez.
    const work = fs.mkdtempSync(path.join(tmpBase, "um-dk-"));
    try {
      fs.cpSync(MIGRATIONS, path.join(work, "drizzle"), { recursive: true });
      // drizzle-kit --out değerini çalışma klasörüne göre yorumlar: göreli yol verilir
      const out = path.relative(REPO, path.join(work, "drizzle"));
      const r = spawnSync(
        process.execPath,
        [
          path.join(REPO, "node_modules", "drizzle-kit", "bin.cjs"),
          "generate",
          "--dialect",
          "sqlite",
          "--schema",
          "./src/lib/db/schema.ts",
          "--out",
          out,
        ],
        { cwd: REPO, encoding: "utf8", timeout: 60_000 },
      );
      const output = `${r.stdout}\n${r.stderr}`;
      expect(r.status, output).toBe(0);
      expect(output).toMatch(/No schema changes/);
      expect(fs.readdirSync(path.join(work, "drizzle")).filter((f) => f.endsWith(".sql"))).toEqual(
        fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")),
      );
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it("boş veritabanında ve ikinci çalıştırmada etkisiz", async () => {
    const h = await handle();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    expect((await runMigrations(h.db, h.client)).pending).toBe(5);
    expect((await runMigrations(h.db, h.client)).pending).toBe(0);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
  });
});

describe.skipIf(unsafeTmp)("0004: kısıtlar veritabanı düzeyinde", () => {
  async function upgraded() {
    const h = await build0003();
    await seed0003(h.client);
    await upgrade(h);
    return h.client;
  }
  const sched = (id: number, key: string, extra = "", vals = "") =>
    `INSERT INTO scan_schedules(id,region_id,scan_key,category_set_ids,strategy,field_profile,interval_days,next_run_at,created_at,updated_at${extra}) VALUES (${id},1,'${key}','[1]','text','discovery',14,${T},${T},${T}${vals})`;

  it("scan_schedules: aralık, JSON, onay çifti, atlama kodu, tek scan_key; FK CASCADE/SET NULL", async () => {
    const c = await upgraded();
    expect(await tryx(c, sched(1, "k1"))).toBe("OK");
    expect(await tryx(c, sched(2, "k1"))).toMatch(/UNIQUE/);
    expect(
      await tryx(
        c,
        `INSERT INTO scan_schedules(region_id,scan_key,category_set_ids,strategy,field_profile,interval_days,next_run_at,created_at,updated_at) VALUES (1,'kx','[1]','text','discovery',10,${T},${T},${T})`,
      ),
    ).toMatch(/scan_schedules_interval_ck/);
    expect(
      await tryx(
        c,
        `INSERT INTO scan_schedules(region_id,scan_key,category_set_ids,strategy,field_profile,interval_days,next_run_at,created_at,updated_at) VALUES (1,'ky','{}','text','discovery',7,${T},${T},${T})`,
      ),
    ).toMatch(/scan_schedules_json_ck/);
    expect(await tryx(c, sched(3, "k3", ",ack_max_usd", ",5"))).toMatch(/scan_schedules_ack_ck/);
    expect(await tryx(c, sched(3, "k3", ",ack_max_usd,ack_at", `,5,${T}`))).toBe("OK");
    expect(await tryx(c, sched(4, "k4", ",last_skip_code", ",'needs ack'"))).toMatch(
      /scan_schedules_skip_code_ck/,
    );
    expect(await tryx(c, sched(4, "k4", ",max_cost_usd", ",-1"))).toMatch(/scan_schedules_cost_ck/);
    expect(await tryx(c, sched(4, "k4", ",strategy_x", ",1"))).toMatch(/no column/);
    // last_scan_id → scans ON DELETE SET NULL
    await c.execute("UPDATE scan_schedules SET last_scan_id = 2 WHERE id = 1");
    await c.execute("DELETE FROM scan_units WHERE scan_id = 2");
    await c.execute("DELETE FROM scans WHERE id = 2");
    expect(
      await num(c, "SELECT COUNT(*) FROM scan_schedules WHERE id = 1 AND last_scan_id IS NULL"),
    ).toBe(1);
    // Demo temizliği kalıbı (leads/mutations.ts): taraması OLMAYAN ama zamanlaması olan bölge KALIR (CASCADE zamanlamayı
    // sessizce silerdi); ne taraması ne zamanlaması olan bölge silinir. Bölge silinirse zamanlaması CASCADE ile gider.
    await c.execute(
      `INSERT INTO scan_schedules(id,region_id,scan_key,category_set_ids,strategy,field_profile,interval_days,next_run_at,created_at,updated_at) VALUES (9,2,'k9','[1]','text','discovery',30,${T},${T},${T})`,
    );
    await c.execute(
      `INSERT INTO regions(id,name,kind,geometry,created_at) SELECT 3,'Boş 2',kind,geometry,created_at FROM regions WHERE id = 2`,
    );
    await c.execute(
      "DELETE FROM regions WHERE id NOT IN (SELECT region_id FROM scans) AND id NOT IN (SELECT region_id FROM scan_schedules)",
    );
    expect(await num(c, "SELECT COUNT(*) FROM scan_schedules WHERE id = 9")).toBe(1);
    expect((await rows(c, "SELECT id FROM regions ORDER BY id")).map((r) => Number(r.id))).toEqual([
      1, 2,
    ]);
    await c.execute("DELETE FROM regions WHERE id = 2");
    expect(await num(c, "SELECT COUNT(*) FROM scan_schedules WHERE id = 9")).toBe(0);
    expect(await rows(c, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("scans: origin, zamanlama anı tekliği, anı zorunlu, pause_code biçimi; zamanlama silinince SET NULL", async () => {
    const c = await upgraded();
    await c.execute(sched(1, "k1"));
    const scan = (id: number, cols: string, vals: string) =>
      `INSERT INTO scans(id,region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at${cols}) VALUES (${id},1,'k1','[1]','[]','text','discovery','mock','queued',${T}${vals})`;
    expect(await tryx(c, scan(10, ",origin", ",'cron'"))).toMatch(/scans_origin_ck/);
    expect(await tryx(c, scan(10, ",origin,schedule_id", ",'schedule',1"))).toMatch(
      /scans_schedule_slot_ck/,
    );
    // origin ile zamanlama alanları tutarlı: manual taramada zamanlama/an olamaz; schedule taramasında an zorunlu
    expect(await tryx(c, scan(10, ",schedule_id,schedule_slot", `,1,${T}`))).toMatch(
      /scans_schedule_slot_ck/,
    );
    expect(await tryx(c, scan(10, ",schedule_slot", `,${T}`))).toMatch(/scans_schedule_slot_ck/);
    expect(await tryx(c, scan(10, ",origin", ",'schedule'"))).toMatch(/scans_schedule_slot_ck/);
    // Zamanlaması silinmiş geçmiş taramanın durumu (ON DELETE SET NULL sonucu) doğrudan da geçerlidir
    expect(await tryx(c, scan(13, ",origin,schedule_slot", `,'schedule',${T}`))).toBe("OK");
    await c.execute("DELETE FROM scans WHERE id = 13");
    expect(await tryx(c, scan(10, ",origin,schedule_id,schedule_slot", `,'schedule',1,${T}`))).toBe(
      "OK",
    );
    expect(
      await tryx(c, scan(11, ",origin,schedule_id,schedule_slot", `,'schedule',1,${T}`)),
    ).toMatch(/UNIQUE/);
    expect(
      await tryx(c, scan(11, ",origin,schedule_id,schedule_slot", `,'schedule',1,${T + 1}`)),
    ).toBe("OK");
    expect(
      await tryx(c, scan(12, ",origin,schedule_id,schedule_slot", `,'schedule',99,${T}`)),
    ).toMatch(/FOREIGN KEY/);
    expect(await tryx(c, scan(12, ",pause_code", ",'budget blocked'"))).toMatch(
      /scans_pause_code_ck/,
    );
    expect(await tryx(c, scan(12, ",pause_code", ",'BUDGET_BLOCKED'"))).toBe("OK");
    await c.execute("DELETE FROM scan_schedules WHERE id = 1");
    expect(await num(c, "SELECT COUNT(*) FROM scans WHERE schedule_id IS NOT NULL")).toBe(0);
    // SET NULL sonrası: origin ve an korunur (bilinçli geçmiş durumu), satır kısmi tekil indeksin dışına çıkar
    expect(
      await num(
        c,
        "SELECT COUNT(*) FROM scans WHERE origin = 'schedule' AND schedule_id IS NULL AND schedule_slot IS NOT NULL",
      ),
    ).toBe(2);
  });

  it("notifications: tür, yinelenmeyen anahtar, nesne parametre, yalnızca uygulama içi yol", async () => {
    const c = await upgraded();
    const n = (key: string, kind = "scan.done", url = "/scans", params = "'{}'") =>
      `INSERT INTO notifications(kind,dedupe_key,params,url,created_at) VALUES ('${kind}','${key}',${params},'${url}',${T})`;
    expect(await tryx(c, n("a"))).toBe("OK");
    expect(await tryx(c, n("a"))).toMatch(/UNIQUE/);
    // Tür yalnızca BİÇİMCE denetlenir (izinli liste kodda): biçimsiz reddedilir, biçime uyan gelecekteki tür girer
    for (const [i, bad] of [
      "spam",
      "Scan.Done",
      "scan done",
      "scan.",
      "x".repeat(41) + ".y",
    ].entries())
      expect(await tryx(c, n(`b${i}`, bad)), bad).toMatch(/notifications_kind_ck/);
    expect(await tryx(c, n("future", "campaign.finished"))).toBe("OK");
    for (const kind of [
      "scan.failed",
      "scan.paused",
      "place.opened",
      "schedule.skipped",
      "background.skipped",
    ])
      expect(await tryx(c, n(`k-${kind}`, kind)), kind).toBe("OK");
    expect(await tryx(c, n("c", "scan.done", "//evil.example"))).toMatch(/notifications_url_ck/);
    expect(await tryx(c, n("d", "scan.done", "https://evil.example"))).toMatch(
      /notifications_url_ck/,
    );
    expect(await tryx(c, n("e", "scan.done", "/scans", "'[1]'"))).toMatch(
      /notifications_params_ck/,
    );
    expect(await tryx(c, n("f", "scan.done", "/scans", "'{bad'"))).toMatch(
      /notifications_params_ck/,
    );
    expect(await tryx(c, n("", "scan.done"))).toMatch(/notifications_dedupe_ck/);
  });

  it("domain_registrations, lead_enrichment.site_domain, saved_filters, templates, leads.archived_at", async () => {
    const c = await upgraded();
    const d = (domain: string, status: string, reg = "NULL") =>
      `INSERT INTO domain_registrations(domain,status,registered_at,next_check_at,created_at,updated_at) VALUES ('${domain}','${status}',${reg},${T},${T},${T})`;
    expect(await tryx(c, d("firma.de", "pending"))).toBe("OK");
    expect(await tryx(c, d("firma.de", "pending"))).toMatch(/UNIQUE|PRIMARY/);
    expect(await tryx(c, d("ok.de", "ok"))).toMatch(/domain_registrations_ok_ck/);
    expect(await tryx(c, d("ok.de", "ok", String(T)))).toBe("OK");
    expect(await tryx(c, d("Firma.DE", "pending"))).toMatch(/domain_registrations_domain_ck/);
    expect(await tryx(c, d("x.de", "weird"))).toMatch(/domain_registrations_status_ck/);

    expect(
      await tryx(c, "UPDATE lead_enrichment SET site_domain = 'Firma.de' WHERE lead_id = 1"),
    ).toMatch(/lead_enrichment_site_domain_ck/);
    expect(
      await tryx(c, "UPDATE lead_enrichment SET site_domain = 'firma.de' WHERE lead_id = 1"),
    ).toBe("OK");

    const sf = (name: string, key: string, payload = `'{"v":1}'`, sort = "'novelty'") =>
      `INSERT INTO saved_filters(name,name_key,payload,sort,created_at,updated_at) VALUES ('${name}','${key}',${payload},${sort},${T},${T})`;
    expect(await tryx(c, sf("İstanbul kafeler", "istanbul kafeler"))).toBe("OK");
    expect(await tryx(c, sf("istanbul kafeler", "istanbul kafeler"))).toMatch(/UNIQUE/);
    expect(await tryx(c, sf("  ", "x"))).toMatch(/saved_filters_name_ck/);
    expect(await tryx(c, sf("A", "a", "'[1]'"))).toMatch(/saved_filters_payload_ck/);
    expect(await tryx(c, sf("B", "b", `'{"v":1}'`, "'random'"))).toMatch(/saved_filters_sort_ck/);

    expect(await tryx(c, "UPDATE templates SET followup_reuse_subject = 2 WHERE id = 2")).toMatch(
      /templates_followup_reuse_subject_ck/,
    );
    expect(await tryx(c, `UPDATE leads SET archived_at = ${T} WHERE id = 1`)).toBe("OK");
  });

  it("gösterge paneli ve izleme sorguları yeni indeksleri kullanır", async () => {
    const c = await upgraded();
    const plan = async (sql: string) =>
      (await rows(c, `EXPLAIN QUERY PLAN ${sql}`)).map((r) => String(r.detail)).join(" | ");
    expect(await plan(`SELECT place_id FROM places WHERE opened_detected_at >= ${T}`)).toContain(
      "places_opened_detected_idx",
    );
    expect(await plan(`SELECT place_id FROM places WHERE new_detected_at >= ${T}`)).toContain(
      "places_new_detected_idx",
    );
    expect(
      await plan(`SELECT place_id FROM places WHERE was_future = 1 AND status_checked_at < ${T}`),
    ).toContain("places_future_watch_idx");
    expect(
      await plan(
        "SELECT COUNT(*) FROM messages WHERE direction='out' AND purpose='campaign' AND send_day BETWEEN '2026-11-01' AND '2026-11-12'",
      ),
    ).toContain("messages_out_day_idx");
    expect(
      await plan(`SELECT COUNT(*) FROM messages WHERE direction='in' AND received_at >= ${T}`),
    ).toContain("messages_in_received_idx");
    expect(await plan("SELECT id FROM notifications WHERE os_claimed_at IS NULL")).toContain(
      "notifications_os_pending_idx",
    );
    // Arşiv indeksi kısmi: yalnızca arşivlenmiş satırları tutar ve arşiv görünümünde kullanılır
    expect(await plan("SELECT id FROM leads WHERE archived_at IS NOT NULL")).toContain(
      "leads_archived_idx",
    );
    const idx = await rows(c, "SELECT sql FROM sqlite_master WHERE name = 'leads_archived_idx'");
    expect(norm(idx[0]?.sql)).toMatch(/WHERE leads\.archived_at IS NOT NULL$/);
  });
});

describe.skipIf(unsafeTmp)("0004: eski sürüm uyumu", () => {
  it("eski migrator yükseltilmiş veritabanını atlar; eski biçimli yazımlar varsayılanlarla çalışır", async () => {
    const h = await build0003();
    await seed0003(h.client);
    await upgrade(h);
    const c = h.client;
    await migrate(drizzle(c), { migrationsFolder: UPTO_0003 });
    expect(await num(c, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
    expect(
      await tryx(
        c,
        `INSERT INTO scans(region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at) VALUES (1,'k9','[1]','[]','text','discovery','mock','queued',${T})`,
      ),
    ).toBe("OK");
    expect(await num(c, "SELECT COUNT(*) FROM scans WHERE scan_key='k9' AND origin='manual'")).toBe(
      1,
    );
    expect(
      await tryx(
        c,
        `INSERT INTO templates(name,language,kind,subject,body_html,body_text,created_at,updated_at) VALUES ('Eski','tr','followup','S','<p>b</p>','b',${T},${T})`,
      ),
    ).toBe("OK");
    expect(await num(c, "SELECT followup_reuse_subject FROM templates WHERE name = 'Eski'")).toBe(
      1,
    );
    expect(
      await tryx(
        c,
        `INSERT INTO places(place_id,source,coords_fetched_at,first_seen_at,created_at,updated_at) VALUES ('p9','demo',${T},${T},${T},${T})`,
      ),
    ).toBe("OK");
    expect(
      await tryx(
        c,
        `UPDATE lead_enrichment SET status='done', updated_at=${T + 1} WHERE lead_id=3`,
      ),
    ).toBe("OK");
  });
});

describe.skipIf(unsafeTmp)("0004: geri alma (iki aşamalı, kayıplı ve onaylı)", () => {
  async function rb(c: Client, acceptDataLoss = false) {
    const plan = await planRollback0004(file, { migrationsFolder: MIGRATIONS });
    return rollbackFaz4(c, {
      dbFile: file,
      expectedCode: plan.code,
      migrationsFolder: MIGRATIONS,
      acceptDataLoss,
    });
  }
  const noAudit = (d: Record<string, Record<string, unknown>[]>) => {
    const { audit_log: _a, ...rest } = d;
    void _a;
    return { ...rest, __seq: rest.__seq!.filter((x) => x.name !== "audit_log") };
  };

  it("Faz 4 verisi yoksa: yukarı → aşağı → 0003 ile bire bir aynı; sıra korunur; yeniden yükseltme çalışır", async () => {
    const h = await build0003();
    await seed0003(h.client);
    const sBefore = await schema(h.client);
    const dBefore = await dump(h.client);
    await upgrade(h);
    const plan = await planRollback0004(file, { migrationsFolder: MIGRATIONS });
    expect(plan.blockers).toEqual([]);
    expect(plan.code).toMatch(/^RB4-[0-9A-F]{16}$/);
    expect(Object.values(plan.faz4Data).every((n) => n === 0)).toBe(true);
    const r = await rb(h.client);
    expect(fs.existsSync(r.backupPath)).toBe(true);
    expect(await schema(h.client)).toEqual(sBefore);
    expect(noAudit(await dump(h.client))).toEqual(noAudit(dBefore));
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    expect(
      await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action='${AUDIT_ACTION_0004}'`),
    ).toBe(1);
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    // silinmiş en yüksek tarama kimliği (3) yeniden kullanılmaz; scan_units bağlantısı sürer
    await h.client.execute(
      `INSERT INTO scans(region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at) VALUES (1,'k3','[1]','[]','text','discovery','mock','queued',${T})`,
    );
    expect(await num(h.client, "SELECT MAX(id) FROM scans")).toBe(4);
    expect(await tryx(h.client, "DELETE FROM scans WHERE id = 1")).toBe("OK"); // CASCADE scan_units/snapshots
    expect(await num(h.client, "SELECT COUNT(*) FROM scan_units WHERE scan_id = 1")).toBe(0);
    // yeniden yükseltme
    expect((await upgrade(h)).pending).toBe(1);
    expect(await num(h.client, "SELECT COUNT(*) FROM scans WHERE origin = 'manual'")).toBe(2);
  });

  it("Faz 4 verisi varsa plan sayıları gösterir; onaysız uygulanmaz; onayla silinir ve eski satırlar korunur", async () => {
    const h = await build0003();
    await seed0003(h.client);
    const sBefore = await schema(h.client);
    await upgrade(h);
    const c = h.client;
    await c.batch(
      [
        `INSERT INTO scan_schedules(id,region_id,scan_key,category_set_ids,strategy,field_profile,interval_days,next_run_at,last_scan_id,created_at,updated_at) VALUES (1,1,'k1','[1]','text','discovery',14,${T},1,${T},${T})`,
        `UPDATE scans SET origin='schedule', schedule_id=1, schedule_slot=${T}, pause_code='SHUTDOWN' WHERE id = 2`,
        `INSERT INTO notifications(kind,dedupe_key,params,url,created_at) VALUES ('scan.done','scan.done:1','{"n":3}','/?scan=1',${T})`,
        `INSERT INTO saved_filters(name,name_key,payload,created_at,updated_at) VALUES ('A','a','{"v":1}',${T},${T})`,
        `INSERT INTO domain_registrations(domain,status,next_check_at,created_at,updated_at) VALUES ('firma.de','pending',${T},${T},${T})`,
        `UPDATE leads SET archived_at=${T} WHERE id = 3`,
        `UPDATE places SET status_checked_at=${T}, gone_at=${T} WHERE place_id = 'p2'`,
        "UPDATE lead_enrichment SET site_domain='firma.de' WHERE lead_id = 1",
        "UPDATE templates SET followup_reuse_subject=0 WHERE id = 2",
      ],
      "write",
    );
    const keptBefore = {
      scans: await rows(
        c,
        "SELECT id, region_id, scan_key, status, pause_reason FROM scans ORDER BY id",
      ),
      leads: await rows(c, "SELECT id, place_id, status, display_name FROM leads ORDER BY id"),
    };
    const plan = await planRollback0004(file, { migrationsFolder: MIGRATIONS });
    expect(plan.faz4Data).toEqual({
      scanSchedules: 1,
      notifications: 1,
      domainRegistrations: 1,
      savedFilters: 1,
      scansWithFaz4Fields: 1,
      placesWithFaz4Fields: 1,
      archivedLeads: 1,
      enrichmentSiteDomains: 1,
      templatesReuseSubjectOff: 1,
    });
    expect(plan.requirements.join(" ")).toMatch(/--accept-data-loss/);
    const sUp = await schema(c);
    await expect(rb(c)).rejects.toThrow(/accept-data-loss/);
    expect(await schema(c)).toEqual(sUp); // hiçbir şey değişmedi
    await rb(c, true);
    expect(await schema(c)).toEqual(sBefore);
    expect(
      await rows(c, "SELECT id, region_id, scan_key, status, pause_reason FROM scans ORDER BY id"),
    ).toEqual(keptBefore.scans);
    expect(
      await rows(c, "SELECT id, place_id, status, display_name FROM leads ORDER BY id"),
    ).toEqual(keptBefore.leads);
    const audit = await rows(c, `SELECT detail FROM audit_log WHERE action='${AUDIT_ACTION_0004}'`);
    expect(JSON.parse(String(audit[0]!.detail)).faz4Data.scanSchedules).toBe(1);
  });

  it("0004 son geçiş değilse plan engeller; yanlış kod reddedilir; plan hiçbir şey değiştirmez", async () => {
    const h = await build0003();
    const p0 = await planRollback0004(file, { migrationsFolder: MIGRATIONS });
    expect(p0.blockers.join(" ")).toMatch(/SON uygulanan/);
    expect(p0.code).toBe("");
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = { d: await dump(h.client), s: await schema(h.client) };
    const filesBefore = fs.readdirSync(dir).sort();
    const p1 = await planRollback0004(file, { migrationsFolder: MIGRATIONS });
    expect((await planRollback0004(file, { migrationsFolder: MIGRATIONS })).code).toBe(p1.code);
    expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
    await expect(
      executeRollback0004(file, {
        confirmCode: "RB4-0000000000000000",
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toBeInstanceOf(RollbackError);
    await expect(
      executeRollback0004(file, {
        confirmCode: p1.code,
        migrationsFolder: MIGRATIONS,
        tempRoots: [path.join(dir, "baska")],
      }),
    ).rejects.toThrow(/allow-live-data/);
    expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
    await expect(
      executeRollback0004(path.join(dir, "olmayan.db"), { confirmCode: p1.code }),
    ).rejects.toThrow(/bulunamadı/);
    expect(fs.existsSync(path.join(dir, "olmayan.db"))).toBe(false);
  });
});

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "rollback-0004.ts"), ...args],
      { cwd: REPO, env: { ...process.env, UM_MIGRATIONS_DIR: MIGRATIONS, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe.skipIf(unsafeTmp)("rollback-0004 betiği (gerçek süreç)", () => {
  it("--db zorunlu; plan kod üretir ve hiçbir şeyi değiştirmez; kodla uygulanır", async () => {
    const h = await build0003();
    await seed0003(h.client);
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const none = await runCli([], { UM_DB_PATH: file });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/--db .* zorunlu/);
    const plan = await runCli(["--db", file]);
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain("hiçbir şey değiştirilmedi");
    const code = /RB4-[0-9A-F]{16}/.exec(plan.out)?.[0];
    expect(code).toBeDefined();
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
    const ok = await runCli(["--db", file, "--confirm", code!]);
    expect(ok.code, ok.err).toBe(0);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
  }, 60_000);
});
