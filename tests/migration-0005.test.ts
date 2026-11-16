import { spawn } from "node:child_process";
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
  AUDIT_ACTION_0005,
  executeRollback0005,
  FAZ5_COLUMNS,
  FAZ5_TABLES,
  planRollback0005,
  rollbackFaz5,
} from "@/lib/db/rollback-0005";

/**
 * Migrasyon 0005 (Faz 5 P0): YALNIZCA EKLEME (yeni tablolar, `ALTER TABLE … ADD` sütunlar, indeksler). Dolu bir 0004
 * veritabanında veri korunur, varsayılanlar doğru, kısıtlar (tekil etkin sicil çalışması, tek onaylı giriş, bileşik FK
 * CASCADE, tek yönlü eşleşme CHECK'i) veritabanı düzeyinde çalışır, eski sürüm yazımları çalışır ve geri alma (kayıplı,
 * onaylı) 0004 şemasını bire bir geri getirir. Yalnızca GEÇİCİ dosya veritabanları; gerçek `.data` kullanılmaz.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(tmpBase);
const REPO = path.resolve(__dirname, "..");
/** Depodaki tam migrasyon klasörü (SQL ve anlık görüntüler buradan okunur). */
const SOURCE_MIGRATIONS = path.join(REPO, "drizzle");
const T = 1_795_000_000_000;

function partialMigrations(count: number): string {
  const d = fs.mkdtempSync(path.join(tmpBase, "um-mig5-"));
  fs.mkdirSync(path.join(d, "meta"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(SOURCE_MIGRATIONS, "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(d, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[])
    fs.copyFileSync(path.join(SOURCE_MIGRATIONS, `${e.tag}.sql`), path.join(d, `${e.tag}.sql`));
  return d;
}

const UPTO_0004 = partialMigrations(5);
/**
 * 0005 dönemi migrasyon klasörü (ilk 6 geçiş). Bu dosyadaki "son geçiş = 0005" senaryoları ve 0005 geri alma aracı bu
 * sürümün klasörüne karşı sınanır; 0006 (Faz 6), geri alması ve schema.ts ↔ anlık görüntü denetimi
 * tests/migration-0006.test.ts'tedir.
 */
const MIGRATIONS = partialMigrations(6);
afterAll(() => {
  fs.rmSync(UPTO_0004, { recursive: true, force: true });
  fs.rmSync(MIGRATIONS, { recursive: true, force: true });
});

let dir: string;
let file: string;
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-m5-"));
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

/** 0004 şemasında (ilk 5 geçiş) veritabanı. */
async function build0004(f = file) {
  const h = await handle(f);
  process.env.UM_MIGRATIONS_DIR = UPTO_0004;
  await runMigrations(h.db, h.client);
  return h;
}

async function upgrade(h: Awaited<ReturnType<typeof handle>>) {
  process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
  return runMigrations(h.db, h.client);
}

/** Faz 1–4 verisi (0004 şeması): yeni sütun alan her tabloda satır, kampanya adımı, ileti, silinmiş en yüksek lead kimliği. */
async function seed0004(c: Client): Promise<void> {
  const geo = `'{"bbox":{"south":51.4,"west":-0.2,"north":51.6,"east":0.1}}'`;
  await c.batch(
    [
      `INSERT INTO regions(id,name,kind,geometry,created_at) VALUES (1,'Londra','city',${geo},${T})`,
      `INSERT INTO scans(id,region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at,finished_at) VALUES (1,1,'k1','[1]','[]','text','discovery','mock','completed',${T},${T + 10})`,
      `INSERT INTO places(place_id,source,lat,lng,coords_fetched_at,was_future,is_closed,first_seen_scan_id,first_seen_at,created_at,updated_at) VALUES
        ('p1','demo',51.5,-0.1,${T},0,0,1,${T},${T},${T}),
        ('p2','demo',51.5,-0.1,${T},0,0,1,${T},${T},${T})`,
      `INSERT INTO leads(id,place_id,source,display_name,country_code,city,category_key,status,created_at,updated_at,archived_at) VALUES
        (1,'p1','demo','Örnek Kafe','GB','London','cafe','new',${T},${T},NULL),
        (2,'p2','demo',NULL,'GB','London','pub','sent',${T},${T},${T}),
        (3,NULL,'import','İçe aktarılan','FR','Paris',NULL,'new',${T},${T},NULL),
        (4,NULL,'demo','Silinecek',NULL,NULL,NULL,'new',${T},${T},NULL)`,
      "DELETE FROM leads WHERE id = 4",
      `INSERT INTO templates(id,name,language,kind,subject,body_html,body_text,created_at,updated_at) VALUES (1,'İlk','en','initial','Hello','<p>Hi</p>','Hi',${T},${T}),(2,'Takip','en','followup','Re','<p>Again</p>','Again',${T},${T})`,
      `INSERT INTO mailboxes(id,provider,label,address,status,created_at,updated_at) VALUES (1,'demo','Demo','demo@universal-mail.invalid','connected',${T},${T})`,
      `INSERT INTO campaigns(id,name,status,mailbox_id,selection,send_window,created_at,updated_at) VALUES (1,'K','draft',1,'{}','{"days":[1],"start":"09:00","end":"17:00"}',${T},${T})`,
      `INSERT INTO campaign_steps(campaign_id,step_index,language,template_id,delay_days) VALUES (1,0,'en',1,0),(1,1,'en',2,5)`,
      `INSERT INTO campaign_leads(id,campaign_id,lead_id,recipient_email,recipient_hash,recipient_domain,status,exclusion_reasons,added_at,updated_at) VALUES (1,1,1,'info@cafe.test','h1','cafe.test','completed','[]',${T},${T})`,
      `INSERT INTO messages(id,direction,purpose,campaign_id,campaign_lead_id,lead_id,mailbox_id,template_id,step_index,idempotency_key,to_address,peer_hash,peer_domain,send_day,subject_logged,status,created_at,sent_at) VALUES (1,'out','campaign',1,1,1,1,1,0,'cl:1:s:0','info@cafe.test','h1','cafe.test','2026-11-01','Hello','sent',${T},${T})`,
      `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,received_at,created_at) VALUES ('in','inbound',1,'<a@t>','h','d.test','received',${T},${T})`,
      `INSERT INTO settings(key,value,updated_at) VALUES ('enrichment.external','{"enabled":true,"provider":"hunter"}',${T})`,
      `INSERT INTO audit_log(at,action,entity,entity_id,detail) VALUES (${T},'consent.accepted','consent','1','{}')`,
    ],
    "write",
  );
}

/** 0005 eklemeleri: yeni sütunların varsayılanları. */
const NEW_COLUMNS: Record<string, Record<string, unknown>> = {
  leads: { website: null },
  templates: { subject_b: null, info_only: 0 },
  messages: { subject_variant: null },
};

describe.skipIf(unsafeTmp)("0005: veri korunur, varsayılanlar, şema", () => {
  it("dolu 0004 veritabanında hiçbir satır kaybolmaz/değişmez; yeni sütunlar varsayılanla gelir; şema taze kurulumla aynı", async () => {
    const h = await build0004();
    await seed0004(h.client);
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
    for (const t of FAZ5_TABLES) expect(after[t], t).toEqual([]);
    expect(after.__seq).toEqual(before.__seq); // silinmiş en yüksek lead kimliği yeniden kullanılmaz

    const fresh = await handle(path.join(dir, "fresh.db"));
    process.env.UM_DB_PATH = path.join(dir, "fresh.db");
    await runMigrations(fresh.db, fresh.client);
    process.env.UM_DB_PATH = file;
    expect(await schema(h.client)).toEqual(await schema(fresh.client));
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await num(h.client, "PRAGMA foreign_keys")).toBe(1);
    expect(await rows(h.client, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("migrasyon SQL'i yalnızca ekler: tablo yeniden kurma, DROP, veri taşıma yok; adlar tekil; günlük ve anlık görüntü tutarlı", () => {
    const text = fs.readFileSync(path.join(SOURCE_MIGRATIONS, "0005_faz5.sql"), "utf8");
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
        /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE `(leads|templates|messages)` ADD `)/,
      );
    const names = [...text.matchAll(/INDEX IF NOT EXISTS `([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    const added = [...text.matchAll(/ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)`/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(added).toEqual(FAZ5_COLUMNS.map(([t, c]) => [t, c]));
    // Eklenen sütunlarda indeks veya FK yok (geri alma DROP COLUMN ile yapılır)
    for (const [, c] of FAZ5_COLUMNS) {
      expect(text).not.toMatch(new RegExp(`ON \`(leads|templates|messages)\` \\([^)]*\`${c}\``));
    }
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.map((e) => e.tag).slice(-1)).toEqual(["0005_faz5"]);
    expect(journal.entries[5]!.idx).toBe(5);
    expect(journal.entries[5]!.when).toBeGreaterThan(journal.entries[4]!.when);
    const snap = JSON.parse(
      fs.readFileSync(path.join(SOURCE_MIGRATIONS, "meta", "0005_snapshot.json"), "utf8"),
    ) as { tables: Record<string, unknown>; prevId: string };
    const prev = JSON.parse(
      fs.readFileSync(path.join(SOURCE_MIGRATIONS, "meta", "0004_snapshot.json"), "utf8"),
    ) as { id: string };
    expect(snap.prevId).toBe(prev.id);
    for (const t of FAZ5_TABLES) expect(Object.keys(snap.tables)).toContain(t);
  });

  it("yarıda kalan 0005 hiçbir iz bırakmaz (tek işlem); engel kalkınca yeniden uygulanır", async () => {
    const h = await build0004();
    await seed0004(h.client);
    // Son ifadelerden birini bozacak çakışma: 0005'in eklediği sütun önceden var
    await h.client.execute("ALTER TABLE `messages` ADD `subject_variant` text");
    const before = await schema(h.client);
    const dBefore = await dump(h.client);
    await expect(upgrade(h)).rejects.toThrow(/duplicate column|subject_variant/i);
    expect(await schema(h.client)).toEqual(before);
    expect(await dump(h.client)).toEqual(dBefore);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
    await h.client.execute("ALTER TABLE `messages` DROP COLUMN `subject_variant`");
    expect((await upgrade(h)).pending).toBe(1);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    for (const tbl of FAZ5_TABLES)
      expect(await num(h.client, `SELECT COUNT(*) FROM sqlite_master WHERE name = '${tbl}'`)).toBe(
        1,
      );
  });

  it("boş veritabanında ve ikinci çalıştırmada etkisiz", async () => {
    const h = await handle();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    expect((await runMigrations(h.db, h.client)).pending).toBe(6);
    expect((await runMigrations(h.db, h.client)).pending).toBe(0);
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
  });
});

describe.skipIf(unsafeTmp)("0005: kısıtlar veritabanı düzeyinde", () => {
  let c: Client;
  beforeEach(async () => {
    const h = await build0004();
    await seed0004(h.client);
    await upgrade(h);
    c = h.client;
  });

  const run = (over: Record<string, string | undefined> = {}) => {
    const v: Record<string, string | undefined> = {
      source: "'companies_house'",
      status: "'queued'",
      activity_scheme: "'SIC2007'",
      activity_codes: `'["56102"]'`,
      window_from: "'2026-10-01'",
      window_to: "'2026-10-31'",
      locality: "NULL",
      error_code: "NULL",
      finished_at: "NULL",
      created_at: String(T),
      ...over,
    };
    return `INSERT INTO registry_runs(${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")})`;
  };

  it("registry_runs: kaynak başına tek etkin çalışma; tarih/JSON/hata/bitiş kuralları", async () => {
    expect(await tryx(c, run())).toBe("OK");
    expect(await tryx(c, run({ status: "'running'" }))).toMatch(/UNIQUE/);
    expect(await tryx(c, run({ source: "'insee'", activity_scheme: "'NAFRev2'" }))).toBe("OK");
    // Bitmiş çalışmalar tekil indeksin dışında
    expect(await tryx(c, run({ status: "'done'", finished_at: String(T) }))).toBe("OK");
    expect(
      await tryx(
        c,
        run({ status: "'failed'", finished_at: String(T), error_code: "'REGISTRY_AUTH'" }),
      ),
    ).toBe("OK");
    await c.execute(`UPDATE registry_runs SET status='done', finished_at=${T} WHERE id = 1`);
    expect(await tryx(c, run())).toBe("OK"); // eski etkin bitti → yenisi açılabilir
    for (const bad of [
      { source: "'opencorporates'" },
      { status: "'paused'" },
      { activity_scheme: "'ISIC'" },
      { activity_codes: "'[]'" },
      { activity_codes: "'\"56102\"'" },
      { activity_codes: "'not json'" },
      { window_from: "'2026-13-01'" },
      { window_from: "'01/10/2026'", window_to: "'31/10/2026'" }, // date() NULL döner: IS ile yakalanır
      { window_from: "'2026-11-02'", window_to: "'2026-11-01'" },
      { locality: "''" },
      { status: "'failed'", finished_at: String(T) }, // hata kodu zorunlu
      { status: "'done'" }, // bitiş zamanı zorunlu
      { finished_at: String(T) }, // kuyruktaki çalışmanın bitişi olmaz
      { status: "'failed'", finished_at: String(T), error_code: "'auth'" },
    ])
      expect(await tryx(c, run({ ...bad, source: "'insee'" })), JSON.stringify(bad)).toMatch(
        /CHECK|UNIQUE/,
      );
    expect(await tryx(c, "UPDATE registry_runs SET fetched_count = -1 WHERE id = 1")).toMatch(
      /CHECK/,
    );
  });

  const company = (over: Record<string, string | undefined> = {}) => {
    const v: Record<string, string | undefined> = {
      source: "'companies_house'",
      external_id: "'DEMO000001'",
      name: "'SAMPLE CAFE LTD'",
      name_norm: "'sample cafe'",
      country_code: "'GB'",
      activity_scheme: "'SIC2007'",
      activity_codes: `'["56102"]'`,
      incorporated_on: "'2026-10-15'",
      match_status: "'pending'",
      matched_place_id: "NULL",
      first_seen_at: String(T),
      last_seen_at: String(T),
      updated_at: String(T),
      ...over,
    };
    return `INSERT INTO registry_companies(${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")})`;
  };

  it("registry_companies: kaynak+kimlik tekil; eşleşme CHECK'i tek yönlü; yer/lead/çalışma silinince SET NULL", async () => {
    expect(await tryx(c, run())).toBe("OK");
    expect(
      await tryx(
        c,
        company({
          match_status: "'matched'",
          matched_place_id: "'p2'",
          match_score: "0.91",
          match_reason: "'name_postcode'",
          last_run_id: "1",
          lead_id: "2",
        }),
      ),
    ).toBe("OK");
    expect(await tryx(c, company())).toMatch(/UNIQUE/);
    expect(await tryx(c, company({ source: "'insee'", country_code: "'FR'" }))).toBe("OK");
    for (const bad of [
      { matched_place_id: "'p1'" }, // pending + yer = yasak
      { country_code: "'DE'" },
      { incorporated_on: "'15/10/2026'" },
      { match_status: "'maybe'" },
      { match_score: "1.5" },
      { match_reason: "'Name Postcode'" },
      { name: "''" },
      { activity_codes: "'{}'" },
      { postcode: `'${"X".repeat(17)}'` },
    ])
      expect(
        await tryx(c, company({ ...bad, external_id: "'DEMO000009'" })),
        JSON.stringify(bad),
      ).toMatch(/CHECK/);
    // Yer silinir → SET NULL; CHECK tek yönlü olduğundan 'matched' + NULL geçerli kalır
    await c.execute("DELETE FROM leads WHERE place_id = 'p2'");
    expect(await tryx(c, "DELETE FROM places WHERE place_id = 'p2'")).toBe("OK");
    expect(
      await rows(
        c,
        "SELECT match_status, matched_place_id, lead_id FROM registry_companies WHERE id = 1",
      ),
    ).toEqual([{ match_status: "matched", matched_place_id: null, lead_id: null }]);
    await c.execute(`UPDATE registry_runs SET status='done', finished_at=${T} WHERE id = 1`);
    expect(await tryx(c, "DELETE FROM registry_runs WHERE id = 1")).toBe("OK");
    expect(await num(c, "SELECT COUNT(*) FROM registry_companies WHERE last_run_id IS NULL")).toBe(
      2,
    );
  });

  it("import_batches ve import_batch_leads: sayı tutarlılığı, nesne eşleme, CASCADE", async () => {
    const batch = (over: Record<string, string | undefined> = {}) => {
      const v: Record<string, string | undefined> = {
        filename: "'liste.csv'",
        format: "'csv'",
        source_note: "'Fuar ziyaretçi listesi'",
        usage_ack_at: String(T),
        mapping: `'{"name":0,"country":1}'`,
        row_count: "3",
        created_count: "1",
        duplicate_count: "1",
        invalid_count: "1",
        created_at: String(T),
        ...over,
      };
      return `INSERT INTO import_batches(${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")})`;
    };
    expect(await tryx(c, batch())).toBe("OK");
    for (const bad of [
      { format: "'xls'" },
      { source_note: "'ab'" },
      { filename: "''" },
      { mapping: "'[0,1]'" },
      { created_count: "3" }, // toplam satırı aşar
      { row_count: "-1" },
    ])
      expect(await tryx(c, batch(bad)), JSON.stringify(bad)).toMatch(/CHECK/);
    expect(
      await tryx(c, "INSERT INTO import_batch_leads(batch_id,lead_id,row_number) VALUES (1,3,2)"),
    ).toBe("OK");
    expect(
      await tryx(c, "INSERT INTO import_batch_leads(batch_id,lead_id,row_number) VALUES (1,1,0)"),
    ).toMatch(/CHECK/);
    expect(
      await tryx(c, "INSERT INTO import_batch_leads(batch_id,lead_id,row_number) VALUES (1,99,1)"),
    ).toMatch(/FOREIGN KEY/);
    await c.execute("DELETE FROM leads WHERE id = 3");
    expect(await num(c, "SELECT COUNT(*) FROM import_batch_leads")).toBe(0);
    await c.execute("INSERT INTO import_batch_leads(batch_id,lead_id,row_number) VALUES (1,1,1)");
    await c.execute("DELETE FROM import_batches WHERE id = 1");
    expect(await num(c, "SELECT COUNT(*) FROM import_batch_leads")).toBe(0);
    expect(await num(c, "SELECT COUNT(*) FROM leads WHERE id = 1")).toBe(1); // lead kalır
  });

  it("lead_intros: lead ve dil başına tek onaylı giriş; onay zamanı çifti; dil/metin/model; lead silinince CASCADE", async () => {
    const intro = (over: Record<string, string | undefined> = {}) => {
      const v: Record<string, string | undefined> = {
        lead_id: "3",
        language: "'en'",
        text: "'A friendly sentence about the place.'",
        status: "'draft'",
        model: "'demo'",
        approved_at: "NULL",
        created_at: String(T),
        updated_at: String(T),
        ...over,
      };
      return `INSERT INTO lead_intros(${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")})`;
    };
    expect(await tryx(c, intro())).toBe("OK");
    expect(await tryx(c, intro())).toBe("OK"); // birden çok taslak serbest
    expect(await tryx(c, intro({ status: "'approved'", approved_at: String(T) }))).toBe("OK");
    expect(await tryx(c, intro({ status: "'approved'", approved_at: String(T) }))).toMatch(
      /UNIQUE/,
    );
    expect(
      await tryx(c, intro({ status: "'approved'", approved_at: String(T), language: "'de'" })),
    ).toBe("OK");
    for (const bad of [
      { status: "'approved'" }, // onay zamanı yok
      { approved_at: String(T) }, // taslakta onay zamanı olmaz
      { language: "'ja'" },
      { text: "''" },
      { text: `'${"x".repeat(401)}'` },
      { model: "'Claude Opus'" },
      { source_domain: "'Cafe.Example'" },
      { input_tokens: "-1" },
      { status: "'pending'" },
    ])
      expect(await tryx(c, intro(bad)), JSON.stringify(bad)).toMatch(/CHECK/);
    expect(
      await tryx(
        c,
        intro({
          model: "'claude-opus-5-5'",
          source_domain: "'cafe.example'",
          est_cost_usd: "0.002",
        }),
      ),
    ).toBe("OK");
    await c.execute("DELETE FROM leads WHERE id = 3");
    expect(await num(c, "SELECT COUNT(*) FROM lead_intros")).toBe(0);
  });

  it("campaign_step_templates: bileşik FK adımla CASCADE; şablon RESTRICT; kategori uzunluğu", async () => {
    await c.execute(
      `INSERT INTO templates(id,name,language,category_key,kind,subject,body_html,body_text,created_at,updated_at) VALUES (3,'Kafe','en','cafe','initial','Hi cafe','<p>x</p>','x',${T},${T})`,
    );
    const ins = (step: number, lang: string, cat: string, tpl = 3) =>
      `INSERT INTO campaign_step_templates(campaign_id,step_index,language,category_key,template_id) VALUES (1,${step},'${lang}','${cat}',${tpl})`;
    expect(await tryx(c, ins(0, "en", "cafe"))).toBe("OK");
    expect(await tryx(c, ins(0, "en", "cafe"))).toMatch(/UNIQUE|PRIMARY/);
    expect(await tryx(c, ins(0, "fr", "cafe"))).toMatch(/FOREIGN KEY/); // adım yok
    expect(await tryx(c, ins(2, "en", "cafe"))).toMatch(/FOREIGN KEY/);
    expect(await tryx(c, ins(0, "en", ""))).toMatch(/CHECK/);
    expect(await tryx(c, ins(0, "en", "pub", 99))).toMatch(/FOREIGN KEY/);
    expect(await tryx(c, "DELETE FROM templates WHERE id = 3")).toMatch(/FOREIGN KEY/);
    expect(await tryx(c, ins(1, "en", "cafe", 2))).toBe("OK");
    // Adımların yeniden yazılması (sil + ekle) kategori şablonlarını da temizler
    await c.execute("DELETE FROM campaign_steps WHERE campaign_id = 1 AND step_index = 0");
    expect(await num(c, "SELECT COUNT(*) FROM campaign_step_templates")).toBe(1);
    // Kampanya silinince adım → kategori şablonu zinciri CASCADE (iletisi olmayan kampanya)
    await c.execute(
      `INSERT INTO campaigns(id,name,selection,send_window,created_at,updated_at) VALUES (2,'K2','{}','{}',${T},${T})`,
    );
    await c.execute(
      "INSERT INTO campaign_steps(campaign_id,step_index,language,template_id,delay_days) VALUES (2,0,'en',1,0)",
    );
    await c.execute(
      "INSERT INTO campaign_step_templates(campaign_id,step_index,language,category_key,template_id) VALUES (2,0,'en','cafe',3)",
    );
    await c.execute("DELETE FROM campaigns WHERE id = 2");
    expect(await num(c, "SELECT COUNT(*) FROM campaign_step_templates WHERE campaign_id = 2")).toBe(
      0,
    );
  });

  it("message_opens ve yeni sütunlar: kaynak, sayaç, ileti silinince CASCADE; website/subject_b/info_only/subject_variant CHECK'leri", async () => {
    const open = (over: Record<string, string | undefined> = {}) => {
      const v: Record<string, string | undefined> = {
        message_id: "1",
        campaign_id: "1",
        first_opened_at: String(T),
        last_opened_at: String(T + 60_000),
        open_count: "2",
        source: "'demo_simulated'",
        ...over,
      };
      return `INSERT INTO message_opens(${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")})`;
    };
    for (const bad of [
      { source: "'beacon'" },
      { open_count: "0" },
      { last_opened_at: String(T - 1) },
    ])
      expect(await tryx(c, open(bad)), JSON.stringify(bad)).toMatch(/CHECK/);
    expect(await tryx(c, open({ message_id: "99" }))).toMatch(/FOREIGN KEY/);
    expect(await tryx(c, open())).toBe("OK");
    expect(await tryx(c, open())).toMatch(/UNIQUE|PRIMARY/);

    expect(await tryx(c, "UPDATE leads SET website='https://cafe.example/' WHERE id=1")).toBe("OK");
    expect(await tryx(c, "UPDATE leads SET website='a.b' WHERE id=1")).toMatch(/CHECK/);
    expect(await tryx(c, `UPDATE leads SET website='${"w".repeat(301)}' WHERE id=1`)).toMatch(
      /CHECK/,
    );
    expect(await tryx(c, "UPDATE templates SET subject_b='Konu B' WHERE id=1")).toBe("OK");
    expect(await tryx(c, "UPDATE templates SET subject_b='' WHERE id=1")).toMatch(/CHECK/);
    expect(await tryx(c, "UPDATE templates SET info_only=2 WHERE id=1")).toMatch(/CHECK/);
    expect(await tryx(c, "UPDATE messages SET subject_variant='b' WHERE id=1")).toBe("OK");
    expect(await tryx(c, "UPDATE messages SET subject_variant='c' WHERE id=1")).toMatch(/CHECK/);

    // İleti silinince açılma satırı CASCADE (uyum/silme akışı)
    await c.execute("DELETE FROM messages WHERE id = 1");
    expect(await num(c, "SELECT COUNT(*) FROM message_opens")).toBe(0);
  });

  it("sicil ve giriş listeleri yeni indeksleri kullanır", async () => {
    const plan = async (sql: string) =>
      (await rows(c, `EXPLAIN QUERY PLAN ${sql}`)).map((r) => String(r.detail)).join(" | ");
    expect(
      await plan(
        "SELECT id FROM registry_companies WHERE country_code='GB' AND incorporated_on >= '2026-10-01' ORDER BY incorporated_on DESC",
      ),
    ).toMatch(/registry_companies_country_inc_idx/);
    expect(await plan("SELECT id FROM registry_companies WHERE matched_place_id = 'p1'")).toMatch(
      /registry_companies_place_idx/,
    );
    expect(await plan("SELECT id FROM lead_intros WHERE lead_id = 1 AND language = 'en'")).toMatch(
      /lead_intros_(lead_idx|approved_uq)/,
    );
    expect(await plan("SELECT * FROM message_opens WHERE campaign_id = 1")).toMatch(
      /message_opens_campaign_idx/,
    );
  });
});

describe.skipIf(unsafeTmp)("0005: eski sürüm uyumu", () => {
  it("eski migrator yükseltilmiş veritabanını atlar; eski biçimli yazımlar varsayılanlarla çalışır", async () => {
    const h = await build0004();
    await seed0004(h.client);
    await upgrade(h);
    const c = h.client;
    await migrate(drizzle(c), { migrationsFolder: UPTO_0004 });
    expect(await num(c, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    expect(
      await tryx(
        c,
        `INSERT INTO templates(name,language,kind,subject,body_html,body_text,created_at,updated_at) VALUES ('Eski','tr','initial','S','<p>b</p>','b',${T},${T})`,
      ),
    ).toBe("OK");
    expect(await rows(c, "SELECT subject_b, info_only FROM templates WHERE name = 'Eski'")).toEqual(
      [{ subject_b: null, info_only: 0 }],
    );
    expect(
      await tryx(
        c,
        `INSERT INTO leads(place_id,source,display_name,status,created_at,updated_at) VALUES (NULL,'demo','Eski lead','new',${T},${T})`,
      ),
    ).toBe("OK");
    expect(
      await tryx(
        c,
        `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,received_at,created_at) VALUES ('in','inbound',1,'<b@t>','h','d.test','received',${T},${T})`,
      ),
    ).toBe("OK");
    expect(await tryx(c, "DELETE FROM campaign_steps WHERE campaign_id = 1")).toBe("OK");
  });
});

describe.skipIf(unsafeTmp)("0005: geri alma (iki aşamalı, kayıplı ve onaylı)", () => {
  async function rb(c: Client, acceptDataLoss = false) {
    const plan = await planRollback0005(file, { migrationsFolder: MIGRATIONS });
    return rollbackFaz5(c, {
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

  it("Faz 5 verisi yoksa: yukarı → aşağı → 0004 ile bire bir aynı; sıra korunur; yeniden yükseltme çalışır", async () => {
    const h = await build0004();
    await seed0004(h.client);
    const sBefore = await schema(h.client);
    const dBefore = await dump(h.client);
    await upgrade(h);
    const plan = await planRollback0005(file, { migrationsFolder: MIGRATIONS });
    expect(plan.blockers).toEqual([]);
    expect(plan.code).toMatch(/^RB5-[0-9A-F]{16}$/);
    expect(Object.values(plan.faz5Data).every((n) => n === 0)).toBe(true);
    expect(plan.keptLeads).toBe(1); // lead 3 (import) kalır
    expect(plan.notes.join(" ")).toMatch(/KALIR/);
    const r = await rb(h.client);
    expect(fs.existsSync(r.backupPath)).toBe(true);
    expect(await schema(h.client)).toEqual(sBefore);
    expect(noAudit(await dump(h.client))).toEqual(noAudit(dBefore));
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
    expect(
      await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action='${AUDIT_ACTION_0005}'`),
    ).toBe(1);
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    // silinmiş en yüksek lead kimliği (4) yeniden kullanılmaz
    await h.client.execute(
      `INSERT INTO leads(source,display_name,status,created_at,updated_at) VALUES ('demo','Yeni','new',${T},${T})`,
    );
    expect(await num(h.client, "SELECT MAX(id) FROM leads")).toBe(5);
    // yeniden yükseltme
    expect((await upgrade(h)).pending).toBe(1);
    expect(await num(h.client, "SELECT COUNT(*) FROM templates WHERE info_only = 0")).toBe(2);
  });

  it("Faz 5 verisi varsa plan sayıları gösterir; onaysız uygulanmaz; onayla silinir, eski satırlar ve içe aktarılan lead'ler korunur", async () => {
    const h = await build0004();
    await seed0004(h.client);
    const sBefore = await schema(h.client);
    await upgrade(h);
    const c = h.client;
    await c.batch(
      [
        `INSERT INTO registry_runs(id,source,status,activity_scheme,activity_codes,window_from,window_to,created_at,finished_at) VALUES (1,'companies_house','done','SIC2007','["56102"]','2026-10-01','2026-10-31',${T},${T})`,
        `INSERT INTO registry_companies(source,external_id,name,name_norm,country_code,activity_scheme,activity_codes,incorporated_on,match_status,matched_place_id,last_run_id,first_seen_at,last_seen_at,updated_at) VALUES ('companies_house','DEMO000001','SAMPLE CAFE LTD','sample cafe','GB','SIC2007','["56102"]','2026-10-15','matched','p1',1,${T},${T},${T})`,
        `INSERT INTO leads(id,source,display_name,country_code,status,created_at,updated_at,website) VALUES (5,'import','Liste Kafe','FR','new',${T},${T},'https://liste.example/')`,
        `INSERT INTO import_batches(id,filename,format,source_note,usage_ack_at,mapping,row_count,created_count,duplicate_count,invalid_count,created_at) VALUES (1,'l.csv','csv','Fuar listesi',${T},'{"name":0}',1,1,0,0,${T})`,
        "INSERT INTO import_batch_leads(batch_id,lead_id,row_number) VALUES (1,5,1)",
        `INSERT INTO lead_intros(lead_id,language,text,status,model,created_at,updated_at,approved_at) VALUES (1,'en','A nice intro sentence.','approved','demo',${T},${T},${T})`,
        "INSERT INTO campaign_step_templates(campaign_id,step_index,language,category_key,template_id) VALUES (1,0,'en','cafe',1)",
        `INSERT INTO message_opens(message_id,campaign_id,first_opened_at,last_opened_at,source) VALUES (1,1,${T},${T},'demo_simulated')`,
        "UPDATE templates SET subject_b='B konusu', info_only=1 WHERE id = 1",
        "UPDATE messages SET subject_variant='a' WHERE id = 1",
      ],
      "write",
    );
    const keptBefore = await rows(
      c,
      "SELECT id, place_id, source, status, display_name FROM leads ORDER BY id",
    );
    const plan = await planRollback0005(file, { migrationsFolder: MIGRATIONS });
    expect(plan.faz5Data).toEqual({
      registryRuns: 1,
      registryCompanies: 1,
      importBatches: 1,
      importBatchLeads: 1,
      leadIntros: 1,
      campaignStepTemplates: 1,
      messageOpens: 1,
      leadsWithWebsite: 1,
      templatesWithSubjectB: 1,
      templatesInfoOnly: 1,
      messagesWithSubjectVariant: 1,
    });
    expect(plan.keptLeads).toBe(2);
    expect(plan.requirements.join(" ")).toMatch(/--accept-data-loss/);
    expect(plan.notes.join(" ")).toMatch(/yalnızca bilgi/);
    const sUp = await schema(c);
    await expect(rb(c)).rejects.toThrow(/accept-data-loss/);
    expect(await schema(c)).toEqual(sUp);
    const r = await rb(c, true);
    expect(r.keptLeads).toBe(2);
    expect(await schema(c)).toEqual(sBefore);
    expect(
      await rows(c, "SELECT id, place_id, source, status, display_name FROM leads ORDER BY id"),
    ).toEqual(keptBefore);
    expect(await num(c, "SELECT COUNT(*) FROM messages")).toBe(2);
    expect(await num(c, "SELECT COUNT(*) FROM campaign_steps")).toBe(2);
    const audit = await rows(c, `SELECT detail FROM audit_log WHERE action='${AUDIT_ACTION_0005}'`);
    const detail = JSON.parse(String(audit[0]!.detail));
    expect(detail.faz5Data.registryCompanies).toBe(1);
    expect(detail.keptLeads).toBe(2);
    expect(await rows(c, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("0005 son geçiş değilse plan engeller; yanlış kod reddedilir; plan hiçbir şey değiştirmez; gerçek veri izni gerekir", async () => {
    const h = await build0004();
    const p0 = await planRollback0005(file, { migrationsFolder: MIGRATIONS });
    expect(p0.blockers.join(" ")).toMatch(/SON uygulanan/);
    expect(p0.code).toBe("");
    await expect(
      executeRollback0005(file, {
        confirmCode: "RB5-0000000000000000",
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toThrow(/SON uygulanan/);
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = { d: await dump(h.client), s: await schema(h.client) };
    const filesBefore = fs.readdirSync(dir).sort();
    const p1 = await planRollback0005(file, { migrationsFolder: MIGRATIONS });
    expect((await planRollback0005(file, { migrationsFolder: MIGRATIONS })).code).toBe(p1.code);
    expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
    await expect(
      executeRollback0005(file, {
        confirmCode: "RB5-0000000000000000",
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toBeInstanceOf(RollbackError);
    await expect(
      executeRollback0005(file, {
        confirmCode: p1.code,
        migrationsFolder: MIGRATIONS,
        tempRoots: [path.join(dir, "baska")],
      }),
    ).rejects.toThrow(/allow-live-data/);
    await expect(
      executeRollback0005(file, {
        confirmCode: p1.code,
        migrationsFolder: MIGRATIONS,
        tempRoots: [path.join(dir, "baska")],
        allowLiveData: true,
        typedDbName: "yanlis.db",
      }),
    ).rejects.toThrow(/type-db-name/);
    await expect(rollbackFaz5(h.client, { dbFile: file, expectedCode: "" })).rejects.toThrow(/kod/);
    await expect(
      rollbackFaz5(h.client, {
        dbFile: file,
        expectedCode: "RB5-0000000000000000",
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toThrow(/uyuşmuyor/);
    expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
    await expect(
      executeRollback0005(path.join(dir, "olmayan.db"), { confirmCode: p1.code }),
    ).rejects.toThrow(/bulunamadı/);
    expect(fs.existsSync(path.join(dir, "olmayan.db"))).toBe(false);
    // Korumalı uygulama: doğru kod + geçici dizin = uygulanır
    h.client.close();
    const r = await executeRollback0005(file, {
      confirmCode: p1.code,
      migrationsFolder: MIGRATIONS,
    });
    expect(fs.existsSync(r.backupPath)).toBe(true);
  });
});

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "rollback-0005.ts"), ...args],
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

describe.skipIf(unsafeTmp)("rollback-0005 betiği (gerçek süreç)", () => {
  it("--db zorunlu; plan kod üretir ve hiçbir şeyi değiştirmez; kodla uygulanır", async () => {
    const h = await build0004();
    await seed0004(h.client);
    await upgrade(h);
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const none = await runCli([], { UM_DB_PATH: file });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/--db .* zorunlu/);
    const plan = await runCli(["--db", file]);
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain("hiçbir şey değiştirilmedi");
    expect(plan.out).toContain("KALIR");
    const code = /RB5-[0-9A-F]{16}/.exec(plan.out)?.[0];
    expect(code).toBeDefined();
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(6);
    const ok = await runCli(["--db", file, "--confirm", code!]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("db.rollback_0005");
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(5);
  }, 60_000);
});
