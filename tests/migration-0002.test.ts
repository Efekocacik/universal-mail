import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

/**
 * 0002_faz3 migrasyonu: Faz 1–2 verisine dokunmadan yalnızca EKLEME yaptığını ve yeni tabloların kısıtlarının
 * (gerçek gönderim kilidi, tekrar gönderimi önleme, alan adı/gün kuralı, silme kısıtları) veritabanı düzeyinde
 * çalıştığını doğrular.
 *
 * Veritabanı BELLEKTE açılır (dosya yok): gerçek `.data` veritabanına dokunulmaz, Windows'taki libsql dosya kilidi
 * ve geçici klasör silme sorunu da devreye girmez. `runMigrations` sarmalayıcısı bilerek kullanılmaz; o, gerçek
 * veritabanı yolundan yedek alır.
 */

const REPO = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(REPO, "drizzle");
const NEW_TABLES = [
  "campaign_leads",
  "campaign_steps",
  "campaigns",
  "country_policies",
  "mailboxes",
  "messages",
  "suppressions",
  "templates",
];

/** Yalnızca ilk `count` migrasyonu içeren geçici bir migrasyon klasörü (journal kırpılmış). */
let partialDir: string;
function partialMigrations(count: number): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-mig-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[]) {
    fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

let client: Client;

async function memoryDb(): Promise<Client> {
  const c = createClient({ url: ":memory:" });
  await c.execute("PRAGMA foreign_keys = ON");
  return c;
}

async function run(sql: string, args: InArgs = []) {
  return client.execute({ sql, args });
}

async function rows(sql: string): Promise<unknown[]> {
  return (await client.execute(sql)).rows.map((r) => ({ ...r }));
}

/** Hata bir veritabanı kısıtından mı geldi? (Mesajda kısıt adı/türü aranır.) */
async function expectConstraint(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "kısıt ihlali bekleniyordu").not.toBeNull();
  expect(String((err as Error).message)).toMatch(pattern);
}

beforeAll(() => {
  partialDir = partialMigrations(2);
});

afterAll(() => {
  // Kilitli dosya yok (veritabanı bellekte); yalnızca kopyalanan SQL/JSON dosyaları silinir.
  fs.rmSync(partialDir, { recursive: true, force: true });
});

afterEach(() => {
  client?.close();
});

describe("0002_faz3: mevcut veri korunur", () => {
  it("Faz 1–2 verisi olan veritabanına uygulanınca hiçbir satır değişmez veya silinmez", async () => {
    client = await memoryDb();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: partialDir });

    const now = 1_790_000_000_000;
    await run(
      `INSERT INTO places (place_id, source, lat, lng, coords_fetched_at, first_seen_at, created_at, updated_at)
       VALUES ('p1', 'demo', 51.5, -0.12, ?, ?, ?, ?), ('p2', 'demo', 52.3, 4.9, ?, ?, ?, ?)`,
      [now, now, now, now, now, now, now, now],
    );
    await run(
      `INSERT INTO leads (id, place_id, source, display_name, country_code, city, category_key, novelty_score,
         novelty_label, status, notes, tags, created_at, updated_at)
       VALUES (1, 'p1', 'demo', 'Kafe Bir', 'GB', 'London', 'cafe', 72, 'high', 'enriched', 'not', '["a"]', ?, ?),
              (2, 'p2', 'demo', NULL, 'NL', 'Amsterdam', 'pub', 10, 'low', 'new', NULL, '[]', ?, ?)`,
      [now, now, now, now],
    );
    await run(
      `INSERT INTO lead_emails (lead_id, email, domain, kind, source_url, source_type, verify_status, is_primary,
         found_at, updated_at)
       VALUES (1, 'info@kafe.example', 'kafe.example', 'generic', 'https://kafe.example/contact', 'mailto',
               'verified', 1, ?, ?),
              (1, 'ali@kafe.example', 'kafe.example', 'personal', NULL, 'manual', 'unverified', 0, ?, ?)`,
      [now, now, now, now],
    );
    await run(
      `INSERT INTO lead_contacts (lead_id, type, url, found_at)
       VALUES (1, 'instagram', 'https://instagram.com/kafe', ?), (2, 'contact_form', 'https://pub.example/c', ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO lead_enrichment (lead_id, status, email_status, attempts, pages_fetched, updated_at)
       VALUES (1, 'done', 'found_verified', 1, 3, ?), (2, 'failed', 'not_found', 1, 1, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('budget.monthlyUsd', '30', ?)`,
      [now],
    );
    await run(
      `INSERT INTO audit_log (at, action, entity, entity_id, detail) VALUES (?, 'consent.accepted', 'consent', '1', '{}')`,
      [now],
    );

    const tables = [
      "places",
      "lead_emails",
      "lead_contacts",
      "lead_enrichment",
      "settings",
      "audit_log",
    ];
    const before: Record<string, unknown[]> = {};
    for (const t of tables) before[t] = await rows(`SELECT * FROM ${t} ORDER BY rowid`);
    const leadsBefore = await rows("SELECT * FROM leads ORDER BY id");

    await migrate(db, { migrationsFolder: MIGRATIONS });

    for (const t of tables)
      expect(await rows(`SELECT * FROM ${t} ORDER BY rowid`), t).toEqual(before[t]);
    // leads: tüm eski sütunlar aynı, yeni sütun boş.
    const leadsAfter = (await rows("SELECT * FROM leads ORDER BY id")) as Record<string, unknown>[];
    expect(leadsAfter.map(({ last_contacted_at: _x, ...rest }) => rest)).toEqual(leadsBefore);
    expect(leadsAfter.every((r) => r.last_contacted_at === null)).toBe(true);

    expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect((await rows("SELECT * FROM __drizzle_migrations")).length).toBe(3);
  });

  it("8 yeni tablo ve leads.last_contacted_at oluşur; başka tablo değişmez", async () => {
    client = await memoryDb();
    await migrate(drizzle(client), { migrationsFolder: partialDir });
    const tablesBefore = (await rows(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY name",
    )) as { name: string; sql: string }[];

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    const tablesAfter = (await rows(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY name",
    )) as { name: string; sql: string }[];

    const added = tablesAfter
      .map((t) => t.name)
      .filter((n) => !tablesBefore.some((b) => b.name === n));
    expect(added.sort()).toEqual(NEW_TABLES);
    for (const b of tablesBefore) {
      const a = tablesAfter.find((t) => t.name === b.name)!;
      if (b.name === "leads") expect(a.sql).toContain("`last_contacted_at` integer");
      else expect(a.sql, b.name).toBe(b.sql); // yeniden oluşturulmadı
    }
  });

  it("migrasyon SQL'i yalnızca ekleme yapar (DROP, yeniden kurma, veri taşıma yok)", () => {
    const text = fs.readFileSync(path.join(MIGRATIONS, "0002_faz3.sql"), "utf8");
    expect(text).not.toMatch(/\bDROP\b|__new|\bINSERT\b|\bRENAME\b|\bPRAGMA\b/i);
    const statements = text
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) {
      expect(s).toMatch(
        /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE `leads` ADD `last_contacted_at`)/,
      );
    }
    expect(statements.filter((s) => s.startsWith("CREATE TABLE"))).toHaveLength(8);
  });
});

describe("0002_faz3: kısıtlar", () => {
  const now = 1_790_000_000_000;

  async function fresh() {
    client = await memoryDb();
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    await run(
      `INSERT INTO leads (id, source, status, created_at, updated_at) VALUES (1, 'demo', 'new', ?, ?), (2, 'demo', 'new', ?, ?)`,
      [now, now, now, now],
    );
    await run(
      `INSERT INTO mailboxes (id, provider, label, address, status, created_at, updated_at)
       VALUES (1, 'demo', 'Demo', 'demo@universal-mail.invalid', 'connected', ?, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO templates (id, name, language, kind, subject, body_html, body_text, created_at, updated_at)
       VALUES (1, 'İlk', 'en', 'initial', 'Hello', '<p>Hi</p>', 'Hi', ?, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO campaigns (id, name, status, mailbox_id, selection, send_window, start_confirmed_at, created_at, updated_at)
       VALUES (1, 'Test', 'running', 1, '{}', '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}', ?, ?, ?)`,
      [now, now, now],
    );
    await run(
      `INSERT INTO campaign_leads (id, campaign_id, lead_id, recipient_email, recipient_hash, recipient_domain, status, added_at, updated_at)
       VALUES (1, 1, 1, 'info@a.example', 'h1', 'a.example', 'scheduled', ?, ?),
              (2, 1, 2, 'info@b.example', 'h2', 'a.example', 'scheduled', ?, ?)`,
      [now, now, now, now],
    );
  }

  function outbound(o: {
    key?: string | null;
    status: string;
    domain?: string;
    day?: string | null;
    cl?: number;
    purpose?: string;
  }) {
    const purpose = o.purpose ?? "campaign";
    return run(
      `INSERT INTO messages (direction, purpose, campaign_id, campaign_lead_id, lead_id, mailbox_id, step_index,
         idempotency_key, to_address, peer_hash, peer_domain, send_day, status, created_at)
       VALUES ('out', ?, ?, ?, ?, 1, 0, ?, 'info@a.example', 'h1', ?, ?, ?, ?)`,
      [
        purpose,
        purpose === "campaign" ? 1 : null,
        purpose === "campaign" ? (o.cl ?? 1) : null,
        purpose === "campaign" ? (o.cl ?? 1) : null,
        o.key === undefined ? `cl:${o.cl ?? 1}:s:0` : o.key,
        o.domain ?? "a.example",
        o.day === undefined ? "2026-11-02" : o.day,
        o.status,
        now,
      ],
    );
  }

  it("live politika kilitliyken blocked dışına çıkamaz; onaysız açılamaz; demo serbesttir", async () => {
    await fresh();
    await run(
      `INSERT INTO country_policies (scope, country_code, mode, locked, seed_version, updated_at) VALUES ('live', 'GB', 'blocked', 1, 1, ?)`,
      [now],
    );
    await expectConstraint(
      run(
        `UPDATE country_policies SET mode = 'allowed' WHERE scope = 'live' AND country_code = 'GB'`,
      ),
      /country_policies_lock_ck/,
    );
    await expectConstraint(
      run(
        `UPDATE country_policies SET locked = 0, mode = 'allowed' WHERE scope = 'live' AND country_code = 'GB'`,
      ),
      /country_policies_approval_ck/,
    );
    await expectConstraint(
      run(
        `INSERT INTO country_policies (scope, country_code, mode, locked, seed_version, updated_at) VALUES ('live', 'FR', 'generic_only', 1, 1, ?)`,
        [now],
      ),
      /country_policies_lock_ck/,
    );
    await run(
      `INSERT INTO country_policies (scope, country_code, mode, locked, seed_version, updated_at)
       VALUES ('demo', 'GB', 'allowed', 0, 1, ?), ('demo', 'ES', 'generic_only', 0, 1, ?)`,
      [now, now],
    );
    await expectConstraint(
      run(
        `INSERT INTO country_policies (scope, country_code, mode, seed_version, updated_at) VALUES ('test', 'DE', 'blocked', 1, ?)`,
        [now],
      ),
      /country_policies_scope_ck/,
    );
  });

  it("aynı adım iki kez yazılamaz; yalnızca 'failed' deneme yeniden açılabilir, 'unknown' anahtarı tutar", async () => {
    await fresh();
    await outbound({ status: "sending", day: "2026-11-02" });
    await expectConstraint(
      outbound({ status: "queued", day: "2026-11-03" }),
      /UNIQUE|messages_idempotency_uq/,
    );

    // Sağlayıcıya kesinlikle ulaşmadı → başarısız; aynı anahtarla yeni deneme açılabilir.
    await run(`UPDATE messages SET status = 'failed' WHERE idempotency_key = 'cl:1:s:0'`);
    await outbound({ status: "sending", day: "2026-11-03" });

    // Belirsiz sonuç: anahtar dolu kalır, yeniden deneme yazılamaz.
    await run(
      `UPDATE messages SET status = 'unknown' WHERE idempotency_key = 'cl:1:s:0' AND status = 'sending'`,
    );
    await expectConstraint(
      outbound({ status: "sending", day: "2026-11-04" }),
      /UNIQUE|messages_idempotency_uq/,
    );
  });

  it("aynı alan adına aynı gün ikinci kampanya iletisi yazılamaz; bounce günü boşaltmaz; test iletisi sayılmaz", async () => {
    await fresh();
    await outbound({ status: "sent", cl: 1, day: "2026-11-02" });
    await expectConstraint(
      outbound({ status: "sending", cl: 2, day: "2026-11-02" }),
      /UNIQUE|messages_domain_day_uq/,
    );
    await run(`UPDATE messages SET delivery_status = 'bounced_hard' WHERE campaign_lead_id = 1`);
    await expectConstraint(
      outbound({ status: "sending", cl: 2, day: "2026-11-02" }),
      /UNIQUE|messages_domain_day_uq/,
    );
    // Sağlayıcıya ulaşmamış deneme günü doldurmaz; test iletisi kurala girmez.
    await outbound({ status: "failed", cl: 2, day: "2026-11-02" });
    await outbound({ status: "sent", purpose: "test", key: null, day: null });
    await outbound({ status: "sending", cl: 2, day: "2026-11-03" });
  });

  it("kampanya iletisinde gün ve anahtar zorunlu; alıcı yalnızca silme talebinde boş olabilir", async () => {
    await fresh();
    await expectConstraint(outbound({ status: "sending", day: null }), /messages_campaign_ck/);
    await expectConstraint(outbound({ status: "sending", key: null }), /messages_campaign_ck/);
    await outbound({ status: "sent" });
    await expectConstraint(run(`UPDATE messages SET to_address = NULL`), /messages_recipient_ck/);
    await run(`UPDATE messages SET to_address = NULL, redacted_at = ?`, [now]);
    await expectConstraint(
      run(
        `UPDATE messages SET delivery_status = 'bounced_hard', direction = 'in', status = 'received'`,
      ),
      /messages_delivery_ck|messages_status_ck/,
    );
  });

  it("kampanya geçmişi olan lead ve kampanya silinemez; geçmişi olmayan lead silinir", async () => {
    await fresh();
    await outbound({ status: "sent" });
    await run(`UPDATE messages SET template_id = 1, template_version = 1`);
    await expectConstraint(run(`DELETE FROM leads WHERE id = 1`), /FOREIGN KEY/);
    await expectConstraint(run(`DELETE FROM campaigns WHERE id = 1`), /FOREIGN KEY/);
    await expectConstraint(run(`DELETE FROM templates WHERE id = 1`), /FOREIGN KEY/i);

    await run(
      `INSERT INTO leads (id, source, status, created_at, updated_at) VALUES (3, 'demo', 'new', ?, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO lead_emails (lead_id, email, domain, kind, source_type, found_at, updated_at)
       VALUES (3, 'x@c.example', 'c.example', 'generic', 'manual', ?, ?)`,
      [now, now],
    );
    await run(`DELETE FROM leads WHERE id = 3`);
    expect(await rows(`SELECT * FROM lead_emails WHERE lead_id = 3`)).toEqual([]);
  });

  it("iletisi olmayan taslak kampanya silinince adımları ve dizi kayıtları da silinir", async () => {
    await fresh();
    await run(
      `INSERT INTO campaigns (id, name, status, selection, send_window, created_at, updated_at)
       VALUES (2, 'Taslak', 'draft', '{}', '{}', ?, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO campaign_steps (campaign_id, step_index, language, template_id) VALUES (2, 0, 'en', 1)`,
    );
    await run(
      `INSERT INTO campaign_leads (campaign_id, lead_id, status, added_at, updated_at) VALUES (2, 2, 'pending', ?, ?)`,
      [now, now],
    );
    await run(`DELETE FROM campaigns WHERE id = 2`);
    expect(await rows(`SELECT * FROM campaign_steps WHERE campaign_id = 2`)).toEqual([]);
    expect(await rows(`SELECT * FROM campaign_leads WHERE campaign_id = 2`)).toEqual([]);
  });

  it("kampanya ve posta kutusu güvenlik kısıtları", async () => {
    await fresh();
    await expectConstraint(
      run(
        `INSERT INTO campaigns (name, status, mailbox_id, selection, send_window, created_at, updated_at)
         VALUES ('x', 'running', 1, '{}', '{}', ?, ?)`,
        [now, now],
      ),
      /campaigns_start_ck/,
    );
    await expectConstraint(
      run(
        `INSERT INTO campaigns (name, status, selection, send_window, created_at, updated_at) VALUES ('x', 'ready', '{}', '{}', ?, ?)`,
        [now, now],
      ),
      /campaigns_mailbox_ck/,
    );
    await expectConstraint(run(`UPDATE campaigns SET daily_cap = 81`), /campaigns_cap_ck/);
    await expectConstraint(run(`UPDATE campaigns SET min_gap_s = 30`), /campaigns_gap_ck/);
    await expectConstraint(
      run(
        `INSERT INTO campaign_steps (campaign_id, step_index, language, template_id, delay_days) VALUES (1, 1, 'en', 1, 3)`,
      ),
      /campaign_steps_delay_ck/,
    );
    await expectConstraint(
      run(
        `INSERT INTO campaign_steps (campaign_id, step_index, language, template_id, delay_days) VALUES (1, 3, 'en', 1, 5)`,
      ),
      /campaign_steps_index_ck/,
    );
    await expectConstraint(
      run(
        `INSERT INTO mailboxes (provider, label, address, status, created_at, updated_at)
         VALUES ('gmail', 'G', 'a@b.example', 'connected', ?, ?)`,
        [now, now],
      ),
      /mailboxes_connected_ck/,
    );
    await expectConstraint(run(`UPDATE mailboxes SET daily_cap = 200`), /mailboxes_cap_ck/);
  });

  it("suppression: özetsiz e-posta kaydı yok; aynı adres bir kez etkin; kaldırma gerekçe ister", async () => {
    await fresh();
    const ins = (hash: string | null) =>
      run(
        `INSERT INTO suppressions (scope, email_hash, hash_alg, email_masked, domain, reason, source, added_at)
         VALUES ('email', ?, ?, 'i***@a.example', 'a.example', 'unsubscribe', 'manual', ?)`,
        [hash, hash ? "sha256-v1" : null, now],
      );
    await expectConstraint(ins(null), /suppressions_key_ck/);
    await ins("abc");
    await expectConstraint(ins("abc"), /UNIQUE|suppressions_email_uq/);
    await expectConstraint(
      run(`UPDATE suppressions SET lifted_at = ?`, [now]),
      /suppressions_lift_ck/,
    );
    await run(`UPDATE suppressions SET lifted_at = ?, lifted_reason = 'geçerli talep'`, [now]);
    await ins("abc");
    await run(
      `INSERT INTO suppressions (scope, domain, reason, source, added_at) VALUES ('domain', 'b.example', 'manual', 'manual', ?)`,
      [now],
    );
    await expectConstraint(
      run(
        `INSERT INTO suppressions (scope, domain, reason, source, added_at) VALUES ('domain', 'b.example', 'complaint', 'inbox', ?)`,
        [now],
      ),
      /UNIQUE|suppressions_domain_uq/,
    );
  });
});
