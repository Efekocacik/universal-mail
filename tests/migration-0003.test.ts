import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toLibsqlUrl } from "@/lib/config/paths";
import { openDatabase } from "@/lib/db/client";
import {
  acquireMaintenance,
  activeMaintenance,
  maintenancePathFor,
  MaintenanceError,
} from "@/lib/db/maintenance";
import { MigrationBlockedError, runMigrations } from "@/lib/db/migrate";
import {
  AUDIT_ACTION,
  executeRollback,
  isLiveTarget,
  planRollback,
  rollbackFaz3ArfComplaint,
  RollbackError,
} from "@/lib/db/rollback-0003";
import { withFileLock } from "@/lib/util/file-lock";

/**
 * Migrasyon 0003 (Aşama 15.10-1): `messages.classification` CHECK'ine `complaint` eklenmesi (tablo yeniden oluşturma) ve
 * `campaign_leads.stop_reason` sütunu; geri doldurma, bütünlük bekçileri, eski sürüm uyumu, kayıpsız geri alma, tek süreç
 * kilidi (K2), bakım kilidi (K3) ve süre ön denetimi (K4). Yalnızca GEÇİCİ dosya veritabanları; gerçek `.data` kullanılmaz.
 *
 * Windows'ta Türkçe karakter içeren geçici dizinlerde (bilinen sorun) atlanır; CI (Linux) kararlıdır.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(tmpBase);
const REPO = path.resolve(__dirname, "..");
const SOURCE_MIGRATIONS = path.join(REPO, "drizzle");
const T = 1_700_000_000_000;

let dir: string;
let file: string;
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"];

function partialMigrations(count: number): string {
  const d = fs.mkdtempSync(path.join(tmpBase, "um-mig3-"));
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

/**
 * 0003 dönemi migrasyon klasörü (ilk 4 geçiş). Bu dosyadaki "son geçiş = 0003" senaryoları ve 0003 geri alma aracı, bu
 * sürümün klasörüne karşı sınanır; 0004 (Faz 4) ve geri alması tests/migration-0004.test.ts'tedir.
 */
const MIGRATIONS = partialMigrations(4);
afterAll(() => fs.rmSync(MIGRATIONS, { recursive: true, force: true }));

/** `pre-rollback-*` yedekleri (yükseltme yedeği `pre-migrate-*` ayrıdır). */
function rollbackBackups(): string[] {
  const d = path.join(dir, "backups");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("pre-rollback-")) : [];
}

/** Çekirdek geri alma: plana bağlı doğrulama koduyla (kod olmadan çağrılamaz). */
async function rb(c: Client) {
  const plan = await planRollback(file, { migrationsFolder: MIGRATIONS });
  return rollbackFaz3ArfComplaint(c, {
    dbFile: file,
    expectedCode: plan.code,
    migrationsFolder: MIGRATIONS,
  });
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-m3-"));
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

/** 0002 şemasında (yalnızca ilk 3 geçiş) veritabanı kurar. */
async function build0002(f = file) {
  const h = await handle(f);
  process.env.UM_MIGRATIONS_DIR = partialMigrations(3);
  await runMigrations(h.db, h.client);
  return h;
}

/** Kenar durumlu örnek veri (0002 şeması). */
async function seed0002(c: Client): Promise<void> {
  await c.execute(
    `INSERT INTO mailboxes(provider,label,created_at,updated_at) VALUES('demo','m',${T},${T})`,
  );
  await c.execute(
    `INSERT INTO templates(name,language,kind,subject,body_html,body_text,created_at,updated_at) VALUES('t','tr','initial','s','h','t',${T},${T})`,
  );
  await c.execute(
    `INSERT INTO campaigns(name,selection,send_window,created_at,updated_at) VALUES('c','{}','{}',${T},${T})`,
  );
  for (let i = 1; i <= 8; i++)
    await c.execute(`INSERT INTO leads(source,created_at,updated_at) VALUES('manual',${T},${T})`);
  const st = [
    "unsubscribed",
    "unsubscribed",
    "unsubscribed",
    "completed",
    "replied",
    "pending",
    "unsubscribed",
    "scheduled",
  ];
  const ex = [
    '["arf_complaint"]',
    "[]",
    '["foo"]',
    "[]",
    "[]",
    "[]",
    '["arf_complaint","x"]',
    "[]",
  ];
  for (let i = 1; i <= 8; i++)
    await c.execute(
      `INSERT INTO campaign_leads(campaign_id,lead_id,recipient_email,recipient_hash,recipient_domain,status,exclusion_reasons,added_at,updated_at) VALUES(1,${i},'a${i}@d${i}.test','h${i}','d${i}.test','${st[i - 1]}','${ex[i - 1]}',${T},${T})`,
    );
  for (let i = 1; i <= 8; i++)
    await c.execute(
      `INSERT INTO messages(direction,purpose,campaign_id,campaign_lead_id,lead_id,mailbox_id,template_id,step_index,idempotency_key,rfc_message_id,to_address,peer_hash,peer_domain,send_day,status,created_at,sent_at) VALUES('out','campaign',1,${i},${i},1,1,0,'k${i}','<o${i}@t>','a${i}@d${i}.test','h${i}','d${i}.test','2026-11-01','sent',${T},${T})`,
    );
  const inb: [string | null, string | null][] = [
    ["other", "arf_complaint"],
    ["other", "arf_complaint:no_match"],
    ["other", null],
    ["unsubscribe", null],
    ["reply", null],
    ["other", "arf_complainted"],
    [null, null],
  ];
  for (let i = 0; i < inb.length; i++)
    await c.execute({
      sql: `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,classification,error_code,created_at,received_at) VALUES('in','inbound',1,?,?,?,'matched',?,?,${T},${T})`,
      args: [`<i${i}@t>`, `h${i + 1}`, `d${i + 1}.test`, inb[i]![0], inb[i]![1]],
    });
  await c.execute(
    `INSERT INTO suppressions(scope,email_hash,hash_alg,domain,reason,source,message_id,added_at) VALUES('email','s1','x','d1.test','complaint','inbox',9,${T})`,
  );
  await c.execute(
    `INSERT INTO suppressions(scope,email_hash,hash_alg,domain,reason,source,message_id,added_at) VALUES('email','s2','x','d2.test','unsubscribe','inbox',12,${T})`,
  );
  await c.execute(
    `INSERT INTO suppressions(scope,email_hash,hash_alg,domain,reason,source,message_id,added_at) VALUES('email','s3','x','d3.test','manual','manual',NULL,${T})`,
  );
  // AUTOINCREMENT boşluğu: en yüksek kimliği ekle ve sil (kimlik yeniden kullanılmamalı)
  await c.execute(
    `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,created_at) VALUES('in','inbound',1,'<gone@t>','hx','dx.test','received',${T})`,
  );
  await c.execute(`DELETE FROM messages WHERE rfc_message_id='<gone@t>'`);
}

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

/** Tüm geçişlerle (taze kurulum) şema. */
async function freshSchema(): Promise<string[]> {
  const f = path.join(dir, "fresh.db");
  const h = await handle(f);
  process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
  const prevDb = process.env.UM_DB_PATH;
  process.env.UM_DB_PATH = f;
  await runMigrations(h.db, h.client);
  process.env.UM_DB_PATH = prevDb;
  return schema(h.client);
}

describe.skipIf(unsafeTmp)("0003: veri korunur, geri doldurma, şema", () => {
  it("hiçbir satır kaybolmaz; yalnızca belgelenmiş geri doldurma değişir; şema taze kurulumla aynı", async () => {
    const h = await build0002();
    await seed0002(h.client);
    const before = await dump(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    const res = await runMigrations(h.db, h.client);
    expect(res.pending).toBe(1);
    expect(res.backupPath && fs.existsSync(res.backupPath)).toBe(true);
    const after = await dump(h.client);

    for (const t of Object.keys(before)) {
      if (t === "messages" || t === "campaign_leads") continue;
      expect(after[t], t).toEqual(before[t]);
    }
    // messages: yalnızca ARF işaretli iki satırın sınıfı değişir; kimlikler ve her sütun aynı
    expect(after.messages).toHaveLength(before.messages.length);
    for (let i = 0; i < before.messages.length; i++) {
      const b = before.messages[i]!;
      const a = after.messages[i]!;
      const isArf =
        b.classification === "other" && /^arf_complaint(:.*)?$/.test(String(b.error_code));
      expect({ ...a, classification: undefined }).toEqual({ ...b, classification: undefined });
      expect(a.classification).toBe(isArf ? "complaint" : b.classification);
    }
    // campaign_leads: yalnızca stop_reason eklenir
    const stripped = after.campaign_leads.map((r) => {
      const { stop_reason: _s, ...rest } = r;
      void _s;
      return rest;
    });
    expect(stripped).toEqual(before.campaign_leads);
    expect(after.campaign_leads.map((r) => r.stop_reason)).toEqual([
      "complaint",
      "unsubscribe",
      "unsubscribe",
      null,
      null,
      null,
      "complaint",
      null,
    ]);
    // 'arf_complainted' benzeri metin yanlışlıkla eşleşmez
    expect(
      await num(
        h.client,
        "SELECT COUNT(*) FROM messages WHERE error_code='arf_complainted' AND classification='other'",
      ),
    ).toBe(1);
    // sqlite_sequence: silinmiş en yüksek kimlik yeniden kullanılmaz
    expect(after.__seq).toEqual(before.__seq);
    await h.client.execute(
      `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,created_at) VALUES('in','inbound',1,'<next@t>','h','d.test','received',1)`,
    );
    expect(await num(h.client, "SELECT id FROM messages WHERE rfc_message_id='<next@t>'")).toBe(17);
    // şema: yükseltilmiş veritabanı == taze kurulum
    expect(await schema(h.client)).toEqual(await freshSchema());
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await num(h.client, "PRAGMA foreign_keys")).toBe(1);
  });

  it("suppressions.message_id bağlantıları aynen korunur; SET NULL ve kısıtlar çalışmaya devam eder", async () => {
    const h = await build0002();
    await seed0002(h.client);
    const before = await rows(h.client, "SELECT id, message_id FROM suppressions ORDER BY id");
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await runMigrations(h.db, h.client);
    expect(await rows(h.client, "SELECT id, message_id FROM suppressions ORDER BY id")).toEqual(
      before,
    );
    const c = h.client;
    const m = (extra: string) =>
      `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,${extra}`;
    // yeni CHECK
    expect(
      await tryx(
        c,
        m(
          "classification,created_at) VALUES('in','inbound',1,'<c1@t>','h','d.test','matched','complaint',1)",
        ),
      ),
    ).toBe("OK");
    expect(
      await tryx(
        c,
        m(
          "classification,created_at) VALUES('in','inbound',1,'<c2@t>','h','d.test','matched','bogus',1)",
        ),
      ),
    ).toMatch(/messages_classification_ck/);
    expect(await tryx(c, "UPDATE campaign_leads SET stop_reason='zzz' WHERE id=1")).toMatch(
      /campaign_leads_stop_reason_ck/,
    );
    // 3 kısmi benzersiz indeks hâlâ ihlali reddeder
    expect(
      await tryx(c, m("created_at) VALUES('in','inbound',1,'<i0@t>','h','d.test','received',1)")),
    ).toMatch(/UNIQUE/);
    const out = (key: string, domain: string, day: string, status: string) =>
      `INSERT INTO messages(direction,purpose,campaign_id,campaign_lead_id,lead_id,mailbox_id,template_id,step_index,idempotency_key,to_address,peer_hash,peer_domain,send_day,status,created_at) VALUES('out','campaign',1,1,1,1,1,0,'${key}','x@y.test','h','${domain}','${day}','${status}',1)`;
    expect(await tryx(c, out("k1", "dz.test", "2026-11-02", "queued"))).toMatch(/UNIQUE/);
    expect(await tryx(c, out("kNEW", "d1.test", "2026-11-01", "sent"))).toMatch(/UNIQUE/);
    // yabancı anahtarlar
    expect(await tryx(c, "DELETE FROM campaigns WHERE id=1")).toMatch(/FOREIGN KEY/);
    expect(
      await tryx(c, m("created_at) VALUES('in','inbound',999,'<fk@t>','h','d.test','received',1)")),
    ).toMatch(/FOREIGN KEY/);
    await c.execute("DELETE FROM messages WHERE id=12");
    expect(
      await num(c, "SELECT COUNT(*) FROM suppressions WHERE id=2 AND message_id IS NULL"),
    ).toBe(1);
  });

  it("boş veritabanı ve tekrar çalıştırma: etkisiz", async () => {
    const h = await build0002();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    const r1 = await runMigrations(h.db, h.client);
    expect(r1.pending).toBe(1);
    expect((await runMigrations(h.db, h.client)).pending).toBe(0);
    expect(await num(h.client, "SELECT COUNT(*) FROM messages")).toBe(0);
  });
});

describe.skipIf(unsafeTmp)("0003: bekçiler işlemi geri alır (K5)", () => {
  it("yabancı anahtar ihlali varsa geçiş başlamaz gibi geri alınır: şema ve veri değişmez", async () => {
    const h = await build0002();
    await seed0002(h.client);
    await h.client.execute("PRAGMA foreign_keys=OFF");
    await h.client.execute(
      "INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,created_at) VALUES('in','inbound',777,'<bad@t>','h','d.test','received',1)",
    );
    await h.client.execute("PRAGMA foreign_keys=ON");
    const sBefore = await schema(h.client);
    const dBefore = await dump(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await expect(runMigrations(h.db, h.client)).rejects.toThrow();
    expect(await schema(h.client)).toEqual(sBefore);
    // Geri almanın kendi denetim kaydı hariç her şey bire bir aynı
    const noAudit = (d: Awaited<ReturnType<typeof dump>>) => {
      const { audit_log: _a, ...rest } = d;
      void _a;
      return { ...rest, __seq: rest.__seq.filter((x) => x.name !== "audit_log") };
    };
    expect(noAudit(await dump(h.client))).toEqual(noAudit(dBefore));
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(3);
    expect(await num(h.client, "PRAGMA foreign_keys")).toBe(1);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false); // bakım kilidi bırakıldı
    expect(
      await num(h.client, "SELECT COUNT(*) FROM sqlite_master WHERE name='__new_messages'"),
    ).toBe(0);
  });
});

describe.skipIf(unsafeTmp)("0003: eski sürüm uyumu", () => {
  it("eski migrator yeni veritabanını atlar; eski biçimli yazımlar çalışır; yeni okuma onları doğru yorumlar", async () => {
    const h = await build0002();
    await seed0002(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await runMigrations(h.db, h.client);
    const c = h.client;
    // Eski sürümün migrator'ı (yalnızca 3 giriş bilir) 4 kayıtlı veritabanında hiçbir şey yapmaz
    const old = partialMigrations(3);
    await migrate(drizzle(c), { migrationsFolder: old });
    expect(await num(c, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    // Eski kodun yazdığı biçimler (yeni sütunu bilmez)
    expect(
      await tryx(
        c,
        `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,classification,error_code,created_at) VALUES('in','inbound',1,'<old1@t>','h2','d2.test','matched','other','arf_complaint',${T})`,
      ),
    ).toBe("OK");
    expect(
      await tryx(
        c,
        `UPDATE campaign_leads SET status='unsubscribed',exclusion_reasons='["arf_complaint"]' WHERE id=6`,
      ),
    ).toBe("OK");
    expect(await tryx(c, `UPDATE campaign_leads SET status='unsubscribed' WHERE id=8`)).toBe("OK");
    expect(await tryx(c, "SELECT * FROM campaign_leads")).toBe("OK");
    // Yeni kodun geçiş okuması: stop_reason boşsa eski işarete düşer
    const eff =
      "COALESCE(stop_reason, CASE WHEN exclusion_reasons LIKE '%\"arf_complaint\"%' THEN 'complaint' ELSE 'unsubscribe' END)";
    const r = await rows(
      c,
      `SELECT id, ${eff} AS eff FROM campaign_leads WHERE status='unsubscribed' ORDER BY id`,
    );
    expect(r.map((x) => [x.id, x.eff])).toEqual([
      [1, "complaint"],
      [2, "unsubscribe"],
      [3, "unsubscribe"],
      [6, "complaint"],
      [7, "complaint"],
      [8, "unsubscribe"],
    ]);
    const isArf =
      "classification = 'complaint' OR (classification = 'other' AND (error_code = 'arf_complaint' OR error_code LIKE 'arf_complaint:%'))";
    expect(await num(c, `SELECT COUNT(*) FROM messages WHERE direction='in' AND (${isArf})`)).toBe(
      3,
    );
  });
});

describe.skipIf(unsafeTmp)("0003: kayıpsız geri alma", () => {
  it("yukarı → aşağı → önceki durumla bire bir aynı; 0003 kaydı silinir; yeniden yükseltme çalışır", async () => {
    const h = await build0002();
    await seed0002(h.client);
    const sBefore = await schema(h.client);
    const dBefore = await dump(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await runMigrations(h.db, h.client);
    const r = await rb(h.client);
    expect(fs.existsSync(r.backupPath)).toBe(true);
    expect(r.complaintMessagesDowngraded).toBe(2);
    expect(r.complaintSequencesMarked).toBe(2);
    expect(await schema(h.client)).toEqual(sBefore);
    // Geri almanın kendi denetim kaydı hariç her şey bire bir aynı
    const noAudit = (d: Awaited<ReturnType<typeof dump>>) => {
      const { audit_log: _a, ...rest } = d;
      void _a;
      return { ...rest, __seq: rest.__seq.filter((x) => x.name !== "audit_log") };
    };
    expect(noAudit(await dump(h.client))).toEqual(noAudit(dBefore));
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(3);
    expect(await rows(h.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    // Yeniden yükseltme
    expect((await runMigrations(h.db, h.client)).pending).toBe(1);
    expect(
      await num(h.client, "SELECT COUNT(*) FROM messages WHERE classification='complaint'"),
    ).toBe(2);
  });

  it("yeni 'complaint' kayıtları kaybolmaz: eski gösterimde işaretle korunur (işaretsiz olanlar onarılır)", async () => {
    const h = await build0002();
    await seed0002(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await runMigrations(h.db, h.client);
    const c = h.client;
    const ins = (n: string, err: string | null) =>
      c.execute({
        sql: `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,classification,error_code,created_at) VALUES('in','inbound',1,?,'h','d.test','matched','complaint',?,1)`,
        args: [n, err],
      });
    await ins("<n1@t>", "arf_complaint");
    await ins("<n2@t>", "arf_complaint:no_match");
    await ins("<n3@t>", null); // çift yazma ihlali: onarılır
    await c.execute(
      `UPDATE campaign_leads SET status='unsubscribed',stop_reason='complaint',exclusion_reasons='[]' WHERE id=6`,
    );
    await c.execute(
      `UPDATE campaign_leads SET status='unsubscribed',stop_reason='unsubscribe' WHERE id=8`,
    );
    const idsBefore = (await rows(c, "SELECT id FROM messages ORDER BY id")).map((x) => x.id);
    const sup = await rows(c, "SELECT id, message_id FROM suppressions ORDER BY id");
    await rb(c);
    expect((await rows(c, "SELECT id FROM messages ORDER BY id")).map((x) => x.id)).toEqual(
      idsBefore,
    );
    expect(await rows(c, "SELECT id, message_id FROM suppressions ORDER BY id")).toEqual(sup);
    const got = await rows(
      c,
      "SELECT rfc_message_id r, classification c, error_code e FROM messages WHERE rfc_message_id IN ('<n1@t>','<n2@t>','<n3@t>') ORDER BY r",
    );
    expect(got).toEqual([
      { r: "<n1@t>", c: "other", e: "arf_complaint" },
      { r: "<n2@t>", c: "other", e: "arf_complaint:no_match" },
      { r: "<n3@t>", c: "other", e: "arf_complaint" },
    ]);
    const cl = await rows(
      c,
      "SELECT id, status, exclusion_reasons x FROM campaign_leads WHERE id IN (6, 8) ORDER BY id",
    );
    expect(cl).toEqual([
      { id: 6, status: "unsubscribed", x: '["arf_complaint"]' },
      { id: 8, status: "unsubscribed", x: "[]" },
    ]);
    // eski CHECK geri geldi
    expect(
      await tryx(
        c,
        `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,classification,created_at) VALUES('in','inbound',1,'<z@t>','h','d.test','matched','complaint',1)`,
      ),
    ).toMatch(/messages_classification_ck/);
  });

  it("0003 uygulanmamışsa veya son geçiş değilse geri alma reddedilir; başka yazıcı varsa başlamaz", async () => {
    const h = await build0002();
    await expect(rb(h.client)).rejects.toBeInstanceOf(RollbackError);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    await runMigrations(h.db, h.client);
    const other = createClient({ url: toLibsqlUrl(file) });
    clients.push(other);
    const tx = await other.transaction("write");
    await tx.execute("UPDATE mailboxes SET label = label");
    const sBefore = await schema(h.client);
    await expect(rb(h.client)).rejects.toThrow(/başka bir süreç/);
    await tx.commit();
    expect(await schema(h.client)).toEqual(sBefore);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
  });
});

describe.skipIf(unsafeTmp)("K2: tek süreç; K3: bakım kilidi; K4: süre ön denetimi", () => {
  it("K2: iki eşzamanlı geçiş çağrısından yalnızca biri uygular, diğeri 'bekleyen yok' görür", async () => {
    const a = await build0002();
    const b = await handle();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    const [r1, r2] = await Promise.all([
      runMigrations(a.db, a.client),
      runMigrations(b.db, b.client),
    ]);
    expect([r1.pending, r2.pending].sort()).toEqual([0, 1]);
    expect(await num(a.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    expect(await rows(a.client, "PRAGMA foreign_key_check")).toEqual([]);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
  });

  it("K3: başka bir canlı süreç bakım tutarken veritabanı çağrıları bekler, bitince devam eder", async () => {
    const h = await build0002();
    const lockFile = maintenancePathFor(file);
    // ebeveyn süreç (vitest işçisinin üstü) canlı başka bir süreç gibi davranır
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.ppid, startedAt: Date.now(), purpose: "test" }),
    );
    await new Promise((r) => setTimeout(r, 250)); // denetim sonucu 200 ms önbelleklenir
    const t0 = Date.now();
    setTimeout(() => fs.rmSync(lockFile, { force: true }), 500);
    const n = await num(h.client, "SELECT COUNT(*) FROM mailboxes");
    expect(n).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it("K3: bayat (sahibi ölü) bakım kilidi yok sayılır ve kaldırılır; kendi sürecimizin kilidi kendimizi bekletmez", async () => {
    const h = await build0002();
    const lockFile = maintenancePathFor(file);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 2_147_483_000, startedAt: Date.now(), purpose: "olu" }),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(await num(h.client, "SELECT COUNT(*) FROM mailboxes")).toBe(0);
    expect(fs.existsSync(lockFile)).toBe(false);
    const own = await acquireMaintenance(file, "test");
    const t0 = Date.now();
    expect(await num(h.client, "SELECT COUNT(*) FROM mailboxes")).toBe(0);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(activeMaintenance(file)?.pid).toBe(process.pid);
    own.release();
    expect(activeMaintenance(file)).toBeNull();
  });

  it("K3: bakım kilidi başka canlı süreçteyken alınamaz (zaman aşımı), başkasının kilidi silinmez", async () => {
    await build0002();
    const lockFile = maintenancePathFor(file);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.ppid, startedAt: Date.now(), purpose: "baska" }),
    );
    await expect(acquireMaintenance(file, "test", 250)).rejects.toBeInstanceOf(MaintenanceError);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("K4: büyük veritabanı tahmininde başka yazıcı varsa geçiş BAŞLAMAZ; yazıcı yokken çalışır", async () => {
    const h = await build0002();
    await seed0002(h.client);
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    const other = createClient({ url: toLibsqlUrl(file) });
    clients.push(other);
    const tx = await other.transaction("write");
    await tx.execute("UPDATE mailboxes SET label = label");
    const sBefore = await schema(h.client);
    const opts = {
      heavyThresholdMs: 0,
      microsPerRow: 1_000_000,
      probeAttempts: 2,
      probeIntervalMs: 20,
    };
    await expect(runMigrations(h.db, h.client, opts)).rejects.toBeInstanceOf(MigrationBlockedError);
    expect(await schema(h.client)).toEqual(sBefore); // hiçbir değişiklik yok
    expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(3);
    expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    await tx.commit();
    const ok = await runMigrations(h.db, h.client, opts);
    expect(ok.pending).toBe(1);
    expect(await num(h.client, "PRAGMA busy_timeout")).toBe(8000);
  });

  it("küçük veritabanında yoklama yapılmaz: başka yazıcı beklenir, geçiş yine de çalışır", async () => {
    const h = await build0002();
    process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
    expect((await runMigrations(h.db, h.client)).pending).toBe(1);
  });
});

describe("dosya kilidi (süreçler arası)", () => {
  it("sahibi canlı kilit eski olsa bile devralınmaz; sahibi ölü kilit hemen devralınır", async () => {
    const lockPath = path.join(tmpBase, `um-lock-${Date.now()}`);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "pid"), String(process.ppid)); // canlı başka süreç
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(lockPath, old, old);
    await expect(withFileLock(lockPath, async () => 1, 400)).rejects.toThrow(/zaman aşımı/);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.writeFileSync(path.join(lockPath, "pid"), "2147483000"); // ölü süreç
    expect(await withFileLock(lockPath, async () => 7, 400)).toBe(7);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

/** Alt süreci çalıştırır ve JSON çıktısını döndürür. */
function runChild(args: string[], migrations = MIGRATIONS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "tests", "helpers", "migrate-child.ts"), ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          UM_MIGRATIONS_DIR: migrations,
          UM_DATA_DIR: dir,
          UM_STATIC_DATA_DIR: path.join(REPO, "data"),
        },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out) as Record<string, unknown>);
      } catch {
        reject(new Error(`alt süreç çıktısı okunamadı (kod ${code}): ${out} ${err}`));
      }
    });
  });
}

describe.skipIf(unsafeTmp)(
  "K2: iki GERÇEK işletim sistemi süreci aynı anda migrasyon başlatır",
  () => {
    for (const mode of ["bare", "init"] as const) {
      it(`${mode}: biri uygular, diğeri hatasız bekleyip 'zaten tamam' görür; veri kaybı, çift geçiş veya kilit kalıntısı yok`, async () => {
        for (let round = 0; round < 3; round++) {
          const f = path.join(dir, `race-${mode}-${round}.db`);
          const h = await handle(f);
          process.env.UM_DB_PATH = f;
          process.env.UM_MIGRATIONS_DIR = partialMigrations(3);
          await runMigrations(h.db, h.client);
          await seed0002(h.client);
          // Pencereyi genişletmek için çok sayıda ek ileti (geçiş yüzlerce ms sürsün)
          const cte = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<60000)";
          await h.client.execute(
            `${cte} INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,classification,error_code,created_at) SELECT 'in','inbound',1,'<bulk'||i||'@t>','h','d.test','matched',CASE WHEN i%100=0 THEN 'other' END,CASE WHEN i%100=0 THEN 'arf_complaint' END,${T} FROM n`,
          );
          const total = await num(h.client, "SELECT COUNT(*) FROM messages");
          const before = await dump(h.client);
          await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
          h.client.close();

          const startAt = String(Date.now() + 2500);
          // `init` gerçek açılış yoludur: seed'ler GÜNCEL şemayı bekler, bu yüzden tüm geçişler (0004 dahil) uygulanır.
          const folder = mode === "init" ? SOURCE_MIGRATIONS : MIGRATIONS;
          const migTotal = (
            JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
              entries: unknown[];
            }
          ).entries.length;
          const [a, b] = await Promise.all([
            runChild([f, startAt, "A", mode], folder),
            runChild([f, startAt, "B", mode], folder),
          ]);
          expect(a.error, JSON.stringify(a)).toBeUndefined();
          expect(b.error, JSON.stringify(b)).toBeUndefined();
          expect([a.pending, b.pending].sort()).toEqual([0, migTotal - 3]);

          const v = await handle(f);
          expect(await num(v.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(migTotal);
          expect(await num(v.client, "SELECT COUNT(*) FROM messages")).toBe(total);
          expect(
            await num(v.client, "SELECT COUNT(*) FROM messages WHERE classification='complaint'"),
          ).toBe(602);
          expect(await rows(v.client, "PRAGMA foreign_key_check")).toEqual([]);
          expect(
            await num(v.client, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '__new_%'"),
          ).toBe(0);
          const after = await dump(v.client);
          expect(after.suppressions).toEqual(before.suppressions);
          // 0004 yalnızca boş `archived_at` sütunu ekler (init kipi); eski sütunlar bire bir aynı kalır.
          expect(after.leads.map(({ archived_at: _a, ...rest }) => rest)).toEqual(before.leads);
          expect(after.messages).toHaveLength(before.messages.length);
          expect(fs.existsSync(maintenancePathFor(f))).toBe(false);
          expect(fs.existsSync(path.join(dir, "migrate.lock"))).toBe(false);
          v.client.close();
        }
      }, 120_000);
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(unsafeTmp)(
  "rollback aracı: iki aşamalı güvenlik (plan → plana bağlı kod → uygulama)",
  () => {
    async function upgraded() {
      const h = await build0002();
      await seed0002(h.client);
      process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
      await runMigrations(h.db, h.client);
      await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      return h;
    }
    const live = (over: object = {}) => ({ migrationsFolder: MIGRATIONS, ...over });

    it("plan hiçbir şeyi değiştirmez (veri, şema, kayıtlar, dosyalar) ve hedefe bağlı kod üretir", async () => {
      const h = await upgraded();
      const before = { d: await dump(h.client), s: await schema(h.client) };
      const filesBefore = fs.readdirSync(dir).sort();
      const p1 = await planRollback(file, live());
      const p2 = await planRollback(file, live());
      expect(p1.blockers).toEqual([]);
      expect(p1.code).toMatch(/^RB3-[0-9A-F]{16}$/);
      expect(p2.code).toBe(p1.code); // aynı durum → aynı kod
      expect(p1.counts).toMatchObject({ complaintMessages: 2, complaintSequences: 2 });
      expect(p1.live).toBe(false); // geçici dizin
      expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
      expect(rollbackBackups()).toEqual([]); // yedek bile alınmaz
      expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
      expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
      // başka bir hedef farklı kod üretir (kod hedefe bağlı)
      fs.copyFileSync(file, path.join(dir, "other.db"));
      expect((await planRollback(path.join(dir, "other.db"), live())).code).not.toBe(p1.code);
    });

    it("var olmayan hedef oluşturulmaz; migrasyonsuz/0003 son değilse plan engel bildirir", async () => {
      await expect(planRollback(path.join(dir, "yok.db"), live())).rejects.toBeInstanceOf(
        RollbackError,
      );
      expect(fs.existsSync(path.join(dir, "yok.db"))).toBe(false);
      await expect(
        executeRollback(path.join(dir, "yok.db"), { confirmCode: "RB3-X", ...live() }),
      ).rejects.toBeInstanceOf(RollbackError);
      expect(fs.existsSync(path.join(dir, "yok.db"))).toBe(false);
      const h = await build0002();
      const p = await planRollback(file, live());
      expect(p.blockers.join(" ")).toMatch(/SON uygulanan/);
      expect(p.code).toBe("");
      await expect(executeRollback(file, { confirmCode: "", ...live() })).rejects.toBeInstanceOf(
        RollbackError,
      );
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(3);
      // SQLite olmayan dosya
      fs.writeFileSync(
        path.join(dir, "metin.db"),
        "bu bir veritabani degil, sadece metin ".repeat(40),
      );
      const junk = await planRollback(path.join(dir, "metin.db"), live());
      expect(junk.blockers.join(" ")).toMatch(/Universal Mail veritabanı değil/);
      expect(junk.code).toBe("");
    });

    it("yanlış/boş kodla uygulama reddedilir ve hiçbir şey değişmez", async () => {
      const h = await upgraded();
      const before = { d: await dump(h.client), s: await schema(h.client) };
      for (const code of ["", "RB3-0000000000000000", "yanlis"])
        await expect(executeRollback(file, { confirmCode: code, ...live() })).rejects.toThrow(
          /Doğrulama kodu/,
        );
      expect({ d: await dump(h.client), s: await schema(h.client) }).toEqual(before);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
      // çekirdek de kodsuz çağrılamaz
      await expect(
        rollbackFaz3ArfComplaint(h.client, {
          dbFile: file,
          expectedCode: "",
          migrationsFolder: MIGRATIONS,
        }),
      ).rejects.toThrow(/Doğrulama kodu gerekli/);
      expect(rollbackBackups()).toEqual([]);
    });

    it("plan ile uygulama arasında veritabanı değişirse reddedilir (ekleme, silme, güncelleme)", async () => {
      const h = await upgraded();
      const changes = [
        `INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,created_at) VALUES('in','inbound',1,'<yeni@t>','h','d.test','received',1)`,
        `INSERT INTO audit_log(at, action) VALUES (1, 'baska.islem')`,
        `UPDATE campaign_leads SET updated_at = updated_at + 1 WHERE id = 2`,
        `DELETE FROM suppressions WHERE id = 3`,
        `UPDATE campaign_leads SET stop_reason = 'complaint' WHERE id = 3`,
      ];
      for (const change of changes) {
        const plan = await planRollback(file, live());
        await h.client.execute(change);
        const sBefore = await schema(h.client);
        await expect(executeRollback(file, { confirmCode: plan.code, ...live() })).rejects.toThrow(
          /Doğrulama kodu uyuşmuyor/,
        );
        expect(await schema(h.client)).toEqual(sBefore);
        expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
        expect(
          await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action = '${AUDIT_ACTION}'`),
        ).toBe(0);
      }
      expect(rollbackBackups()).toEqual([]); // reddedilince yedek de alınmadı
      // yeni planla uygulanır
      const fresh = await planRollback(file, live());
      await expect(
        executeRollback(file, { confirmCode: fresh.code, ...live() }),
      ).resolves.toBeDefined();
    });

    it("kod başka bir hedefe uygulanamaz", async () => {
      const h = await upgraded();
      fs.copyFileSync(file, path.join(dir, "kopya.db"));
      const planKopya = await planRollback(path.join(dir, "kopya.db"), live());
      await expect(
        executeRollback(file, { confirmCode: planKopya.code, ...live() }),
      ).rejects.toThrow(/Doğrulama kodu uyuşmuyor/);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    });

    it("gerçek veri (geçici dizin dışı): açık izin ve dosya adı yazılmadan hiçbir şey olmaz", async () => {
      const h = await upgraded();
      const other = path.join(dir, "baska-kok");
      fs.mkdirSync(other);
      const tempRoots = [other]; // dosya bu köklerin DIŞINDA → gerçek veri sayılır
      expect(isLiveTarget(file, tempRoots)).toBe(true);
      expect(isLiveTarget(file, [dir])).toBe(false);
      const plan = await planRollback(file, live({ tempRoots }));
      expect(plan.live).toBe(true);
      expect(plan.requirements.join(" ")).toMatch(/--allow-live-data/);
      expect(plan.requirements.join(" ")).toContain("--type-db-name test.db");
      const base = { confirmCode: plan.code, ...live({ tempRoots }) };
      const sBefore = await schema(h.client);
      await expect(executeRollback(file, base)).rejects.toThrow(/--allow-live-data/);
      await expect(executeRollback(file, { ...base, allowLiveData: true })).rejects.toThrow(
        /dosya adı doğrulanamadı/,
      );
      await expect(
        executeRollback(file, { ...base, allowLiveData: true, typedDbName: "yanlis.db" }),
      ).rejects.toThrow(/dosya adı/);
      await expect(executeRollback(file, { ...base, typedDbName: "test.db" })).rejects.toThrow(
        /--allow-live-data/,
      );
      expect(await schema(h.client)).toEqual(sBefore);
      expect(rollbackBackups()).toEqual([]);
      const r = await executeRollback(file, {
        ...base,
        allowLiveData: true,
        typedDbName: "test.db",
      });
      expect(fs.existsSync(r.backupPath)).toBe(true);
      const audit = await rows(
        h.client,
        `SELECT detail FROM audit_log WHERE action = '${AUDIT_ACTION}'`,
      );
      expect(JSON.parse(String(audit[0]!.detail))).toMatchObject({ live: true });
    });

    it("yedek alınamaz veya doğrulanamazsa geri alma BAŞLAMAZ", async () => {
      const h = await upgraded();
      const plan = await planRollback(file, live());
      // Yedek klasörü bir dosya olduğundan yedek alınamaz
      const notDir = path.join(dir, "yedek-dizini-degil");
      fs.writeFileSync(notDir, "dosya");
      const sBefore = await schema(h.client);
      await expect(
        executeRollback(file, { confirmCode: plan.code, backupDir: notDir, ...live() }),
      ).rejects.toBeDefined();
      expect(await schema(h.client)).toEqual(sBefore);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
      expect(
        await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action = '${AUDIT_ACTION}'`),
      ).toBe(0);
      // Bozuk yedek: kopya içeriği bozuk yazılır, doğrulama başarısız olmalı
      const bdir = path.join(dir, "bk");
      fs.mkdirSync(bdir);
      const spy = vi.spyOn(fs, "copyFileSync").mockImplementation((_src, dest) => {
        fs.writeFileSync(String(dest), "BOZUK YEDEK ".repeat(500));
      });
      try {
        const p2 = await planRollback(file, live());
        await expect(
          executeRollback(file, { confirmCode: p2.code, backupDir: bdir, ...live() }),
        ).rejects.toThrow(/Yedek/);
      } finally {
        spy.mockRestore();
      }
      expect(await schema(h.client)).toEqual(sBefore);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
      expect(fs.existsSync(maintenancePathFor(file))).toBe(false);
    });

    it("denetim kaydı geri almayla birlikte kalıcıdır, doğru içeriklidir ve yeniden yükseltmede korunur", async () => {
      const h = await upgraded();
      await h.client.execute(
        `INSERT INTO audit_log(at, action, entity) VALUES (5, 'onceki.kayit', 'x')`,
      );
      const auditBefore = await rows(h.client, "SELECT * FROM audit_log ORDER BY id");
      const messagesBefore = await num(h.client, "SELECT COUNT(*) FROM messages");
      const plan = await planRollback(file, live());
      const r = await executeRollback(file, { confirmCode: plan.code, ...live() });
      const all = await rows(h.client, "SELECT * FROM audit_log ORDER BY id");
      expect(all).toHaveLength(auditBefore.length + 1);
      expect(all.slice(0, auditBefore.length)).toEqual(auditBefore); // mevcut kayıtlar değişmedi
      const row = all.at(-1)!;
      expect(row.action).toBe(AUDIT_ACTION);
      expect(row.entity).toBe("database");
      expect(JSON.parse(String(row.detail))).toEqual({
        backup: path.basename(r.backupPath),
        planCode: plan.code,
        messages: messagesBefore,
        complaintMessagesDowngraded: 2,
        complaintSequencesMarked: 2,
        live: false,
      });
      expect(JSON.stringify(row)).not.toContain(dir); // dosya yolu / kullanıcı adı sızmaz
      // yeniden yükseltme kaydı silmez
      expect((await runMigrations(h.db, h.client)).pending).toBe(1);
      expect(
        await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action = '${AUDIT_ACTION}'`),
      ).toBe(1);
      // başarısız geri alma denetim kaydı bırakmaz (aynı işlem): FK ihlali bekçisi
      await h.client.execute("PRAGMA foreign_keys=OFF");
      await h.client.execute(
        "INSERT INTO messages(direction,purpose,mailbox_id,rfc_message_id,peer_hash,peer_domain,status,created_at) VALUES('in','inbound',777,'<bad@t>','h','d.test','received',1)",
      );
      await h.client.execute("PRAGMA foreign_keys=ON");
      const p2 = await planRollback(file, live());
      await expect(
        executeRollback(file, { confirmCode: p2.code, ...live() }),
      ).rejects.toBeDefined();
      expect(
        await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action = '${AUDIT_ACTION}'`),
      ).toBe(1); // yalnızca ilk
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    });
  },
);

// ---------------------------------------------------------------------------------------------------------------
function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(e.name)) out.push(f);
  }
  return out;
}

describe("rollback aracı uygulamanın normal çalışma yolundan çağrılamaz", () => {
  it("src/, electron/ ve başlatıcılarda hiçbir yerde içe aktarılmaz veya adı geçmez", () => {
    const roots = ["src", "electron", "e2e", "scripts"]
      .map((r) => path.join(REPO, r))
      .filter((r) => fs.existsSync(r));
    const offenders: string[] = [];
    for (const f of roots.flatMap((r) => walk(r))) {
      const rel = path.relative(REPO, f).replace(/\\/g, "/");
      // Geri alma araçlarının kendileri (0003 ve onu yeniden kullanan 0004) hariç.
      if (/^(src\/lib\/db|scripts)\/rollback-000[34]\.ts$/.test(rel)) continue;
      const text = fs.readFileSync(f, "utf8");
      if (
        /rollback-000[34]|rollbackFaz3ArfComplaint|rollbackFaz4|executeRollback|planRollback/.test(
          text,
        )
      )
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("package.json betikleri ve Next yapılandırması geri almayı çalıştırmaz", () => {
    expect(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).not.toMatch(/rollback/i);
    for (const f of ["next.config.ts", "next.config.mjs", "next.config.js"]) {
      const p = path.join(REPO, f);
      if (fs.existsSync(p)) expect(fs.readFileSync(p, "utf8")).not.toMatch(/rollback/i);
    }
  });

  it.skipIf(unsafeTmp)(
    "açılış yolu (runMigrations) geri almayı tetiklemez: yükseltilmiş veritabanı yükseltilmiş kalır",
    async () => {
      const h = await build0002();
      process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
      await runMigrations(h.db, h.client);
      await runMigrations(h.db, h.client);
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
/** Betiği gerçek bir süreç olarak çalıştırır (repo kökünden). */
function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "rollback-0003.ts"), ...args],
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

describe.skipIf(unsafeTmp)(
  "rollback betiği (gerçek süreç): --db zorunlu, ortamdan hedef seçilmez, varsayılan yalnızca plan",
  () => {
    it("--db olmadan reddedilir; UM_DB_PATH/UM_DATA_DIR hedef olarak kullanılmaz ve oluşturulmaz", async () => {
      const h = await build0002();
      process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
      await runMigrations(h.db, h.client);
      const dataDir = path.join(dir, "olmayan-veri-klasoru");
      const r = await runCli([], { UM_DB_PATH: file, UM_DATA_DIR: dataDir });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--db .* zorunlu/);
      const r2 = await runCli(["--yes"], { UM_DB_PATH: file, UM_DATA_DIR: dataDir });
      expect(r2.code).toBe(2); // eski kullanım artık geçersiz
      expect(fs.existsSync(dataDir)).toBe(false); // varsayılan/ortam veri klasörü hiç oluşturulmaz
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
    });

    it("plan çıktısı hedefi ve kodu yazar, hiçbir şeyi değiştirmez; kodla uygulanır; ikinci uygulama reddedilir", async () => {
      const h = await build0002();
      await seed0002(h.client);
      process.env.UM_MIGRATIONS_DIR = MIGRATIONS;
      await runMigrations(h.db, h.client);
      const decoy = path.join(dir, "decoy.db"); // ortam değişkeninin gösterdiği ALAKASIZ veritabanı
      await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(file, decoy);
      const dBefore = JSON.stringify(await dump(h.client));
      const dataDir = path.join(dir, "olmayan-veri-klasoru");
      const env = { UM_DB_PATH: decoy, UM_DATA_DIR: dataDir };

      const plan = await runCli(["--db", file], env);
      expect(plan.code, plan.err).toBe(0);
      expect(plan.out).toContain("hiçbir şey değiştirilmedi");
      expect(plan.out).toContain(path.resolve(file));
      expect(plan.out).toContain("yok sayıldı");
      const code = /RB3-[0-9A-F]{16}/.exec(plan.out)?.[0];
      expect(code).toBeDefined();
      expect(JSON.stringify(await dump(h.client))).toBe(dBefore);

      const bad = await runCli(["--db", file, "--confirm", "RB3-0000000000000000"], env);
      expect(bad.code).toBe(1);
      expect(bad.err).toMatch(/Doğrulama kodu/);
      expect(JSON.stringify(await dump(h.client))).toBe(dBefore);

      const ok = await runCli(["--db", file, "--confirm", code!], env);
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out).toContain("geri alındı");
      expect(await num(h.client, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(3);
      expect(
        await num(h.client, `SELECT COUNT(*) FROM audit_log WHERE action = '${AUDIT_ACTION}'`),
      ).toBe(1);
      expect(fs.existsSync(dataDir)).toBe(false);
      // alakasız (decoy) veritabanı hiç değişmedi
      const d = createClient({ url: toLibsqlUrl(decoy) });
      clients.push(d);
      expect(await num(d, "SELECT COUNT(*) FROM __drizzle_migrations")).toBe(4);
      expect(await num(d, "SELECT COUNT(*) FROM audit_log")).toBe(0);

      const again = await runCli(["--db", file, "--confirm", code!], env);
      expect(again.code).toBe(1);
    });
  },
);
