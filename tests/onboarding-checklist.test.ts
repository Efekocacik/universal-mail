import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as listRoute from "@/app/api/onboarding/route";
import * as dismissRoute from "@/app/api/onboarding/dismiss/route";
import * as restoreRoute from "@/app/api/onboarding/restore/route";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog } from "@/lib/db/schema";
import {
  dismissOnboarding,
  getOnboardingChecklist,
  ONBOARDING_HREFS,
  ONBOARDING_ITEM_IDS,
  restoreOnboarding,
  type OnboardingItemId,
} from "@/lib/onboarding/checklist";
import { BACKUP_PASSPHRASE_SECRET, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 6 (sözleşme K.4): "Kurulumu tamamlayın" listesi. Her adım geçici bir veritabanında önce "yapılmadı", gerçek
 * durumu oluşturulunca "yapıldı" olur; demo ile tamamlanan adımlar `demo` işaretlenir; gizle/göster idempotent ve
 * yalnızca durum değişince denetim kaydı yazar; uçlar katı gövde ister ve kişisel veri döndürmez.
 */

const ORIGIN = "http://127.0.0.1:3000";
let t: TestDb;
let db: Db;
const savedEnv: Record<string, string | undefined> = {};
const ENV = ["UM_MASTER_KEY", "UM_REQUIRE_MASTER_KEY", "GOOGLE_PLACES_API_KEY"] as const;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

beforeEach(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  delete process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.UM_REQUIRE_MASTER_KEY;
  process.env.UM_MASTER_KEY = "5a".repeat(32);
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const state = async () => {
  const c = await getOnboardingChecklist(db);
  return Object.fromEntries(c.items.map((i) => [i.id, i.demo ? "demo" : i.done])) as Record<
    OnboardingItemId,
    boolean | "demo"
  >;
};
const exec = (q: string) => db.run(sql.raw(q));

async function completeSetup(provider: "google" | "mock") {
  await setSetting(db, "consent", { version: "1", acceptedAt: 1, name: "Ayşe Demir" });
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "Organize Sanayi 1. Cad. No:5",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "targets.countries", ["GB"]);
  await setSetting(db, "places.provider", provider);
  await setSetting(db, "setup.completed", true);
}

const scan = (id: number, provider: string, status: string) =>
  exec(
    `INSERT INTO regions (id, name, kind, geometry, created_at) VALUES (${id}, 'R${id}', 'city', '{}', 1) ON CONFLICT DO NOTHING;`,
  ).then(() =>
    exec(
      `INSERT INTO scans (id, region_id, scan_key, category_set_ids, queries, strategy, field_profile, provider, status, created_at) VALUES (${id}, ${id}, 'k${id}', '[]', '[]', 'text', 'discovery', '${provider}', '${status}', 1)`,
    ),
  );

describe("kurulum listesi adımları", () => {
  it("temiz kurulumda hiçbir adım tamam değil; sıra ve bağlantılar sabit", async () => {
    const c = await getOnboardingChecklist(db);
    expect(c.items.map((i) => i.id)).toEqual([...ONBOARDING_ITEM_IDS]);
    expect(c.items.map((i) => i.href)).toEqual(
      ONBOARDING_ITEM_IDS.map((id) => ONBOARDING_HREFS[id]),
    );
    // Test e-postası Ayarlar'da değil, Gönderim günlüğü → Gönderim sağlığı sekmesinde ("Kendime test gönder").
    expect(ONBOARDING_HREFS.testEmail).toBe("/mail-log?tab=health");
    expect(c.items.every((i) => !i.done && i.demo === undefined)).toBe(true);
    expect(c).toMatchObject({ done: 0, total: 7, allDone: false, dismissedAt: null });
    // Demo posta kutusu (açılış seed'i) "posta kutusu bağlı" sayılmaz.
    expect((await state()).mailbox).toBe(false);
  });

  it("kurulum + demo veri kaynağı: 2/7, veri kaynağı demo", async () => {
    await completeSetup("mock");
    expect(await state()).toMatchObject({ setup: true, dataSource: "demo" });
    expect((await getOnboardingChecklist(db)).done).toBe(2);
  });

  it("Google sağlayıcıda veri kaynağı yalnızca Places anahtarı kayıtlıyken tamam (demo değil)", async () => {
    await completeSetup("google");
    // Anahtar yokken sihirbaz da tamam sayılmaz (eksik adım var).
    expect(await state()).toMatchObject({ setup: false, dataSource: false });
    await setSecret("google.placesKey", "AIzaFixture-000000000000000000000");
    expect(await state()).toMatchObject({ setup: true, dataSource: true });
  });

  it("ilk tarama: yalnızca tamamlanmış tarama sayılır; yalnızca demo taramalar varsa demo", async () => {
    await scan(1, "mock", "running");
    await scan(2, "google", "failed");
    expect((await state()).firstScan).toBe(false);
    await scan(3, "mock", "completed");
    expect((await state()).firstScan).toBe("demo");
    await scan(4, "google", "completed");
    expect((await state()).firstScan).toBe(true);
  });

  it("posta kutusu: bağlı Gmail kutusu VE gönderim izni gerekir", async () => {
    await exec(
      "INSERT INTO mailboxes (id, provider, label, address, credentials_ref, status, created_at, updated_at) VALUES (20, 'gmail', 'Ofis', 'ofis@firma.example', 'gmail.refreshToken.20', 'connected', 1, 1)",
    );
    expect((await state()).mailbox).toBe(false);
    await setSetting(db, "mail.gmailGrants", { "20": { send: false, read: true, at: 1 } });
    expect((await state()).mailbox).toBe(false);
    await setSetting(db, "mail.gmailGrants", { "20": { send: true, read: true, at: 1 } });
    expect((await state()).mailbox).toBe(true);
    await exec("UPDATE mailboxes SET status = 'error' WHERE id = 20");
    expect((await state()).mailbox).toBe(false);
  });

  it("test e-postası: yalnızca gönderilmiş kendine test sayılır; demo kutudan gönderildiyse demo", async () => {
    const demo = Number(
      (await db.run(sql.raw("SELECT id FROM mailboxes WHERE provider = 'demo' LIMIT 1")))
        .rows[0]?.[0],
    );
    expect(demo).toBeGreaterThan(0);
    const msg = (id: number, mailbox: number, status: string) =>
      exec(
        `INSERT INTO messages (id, direction, purpose, mailbox_id, to_address, peer_hash, peer_domain, status, created_at) VALUES (${id}, 'out', 'test', ${mailbox}, 'ofis@firma.example', 'h', 'firma.example', '${status}', 1)`,
      );
    await msg(1, demo, "failed");
    await msg(2, demo, "unknown");
    expect((await state()).testEmail).toBe(false);
    await msg(3, demo, "sent");
    expect((await state()).testEmail).toBe("demo");
    await exec(
      "INSERT INTO mailboxes (id, provider, label, address, credentials_ref, status, created_at, updated_at) VALUES (21, 'gmail', 'Ofis', 'ofis@firma.example', 'gmail.refreshToken.21', 'connected', 1, 1)",
    );
    await msg(4, 21, "sent");
    expect((await state()).testEmail).toBe(true);
  });

  it("test e-postası sorgusu ileti tablosunu taramaz (kampanya indeksini kullanır)", async () => {
    const plan = await db.run(
      sql.raw(
        "EXPLAIN QUERY PLAN SELECT DISTINCT mb.provider FROM messages m INNER JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.campaign_id IS NULL AND m.status = 'sent' AND m.purpose = 'test'",
      ),
    );
    const text = plan.rows.map((r) => String(r[3] ?? r.detail)).join(" | ");
    expect(text).toMatch(/messages_campaign_idx/);
  });

  it("çıkış bağlantısı yalnızca uçtan uca doğrulanınca tamam", async () => {
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      baseUrl: "https://cikis.firma.example",
    });
    expect((await state()).unsubscribe).toBe(false);
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      baseUrl: "https://cikis.firma.example",
      verified: {
        baseUrl: "https://cikis.firma.example",
        kid: "0123456789abcdef",
        jti: "j",
        verifiedAt: 1,
      },
    });
    expect((await state()).unsubscribe).toBe(true);
  });

  it("yedek: parola VE başarılı bir yedek gerekir (başarısız/süren yedek sayılmaz)", async () => {
    const backup = (id: number, status: string, extra = "NULL, NULL, NULL") =>
      exec(
        `INSERT INTO backups (id, kind, status, file_name, folder, size_bytes, sha256, finished_at, app_version, schema_migrations, error_code, created_at) VALUES (${id}, 'manual', '${status}', 'yedek-${id}-2026.umbk', '/yedekler', ${extra}, '0.1.0', 7, ${status === "failed" ? "'BACKUP_FAILED'" : "NULL"}, 1)`,
      );
    await backup(1, "ok", `10, '${"a".repeat(64)}', 2`);
    expect((await state()).backup).toBe(false); // parola yok
    await setSecret(BACKUP_PASSPHRASE_SECRET, "uzun ve gizli bir parola");
    expect((await state()).backup).toBe(true);
    await exec("DELETE FROM backups");
    await backup(2, "failed");
    await backup(3, "running");
    expect((await state()).backup).toBe(false);
  });

  it("hepsi tamamsa allDone; demo adımlar da 'tamam' sayılır", async () => {
    await completeSetup("mock");
    await scan(1, "mock", "completed");
    await exec(
      "INSERT INTO mailboxes (id, provider, label, address, credentials_ref, status, created_at, updated_at) VALUES (30, 'gmail', 'Ofis', 'ofis@firma.example', 'gmail.refreshToken.30', 'connected', 1, 1)",
    );
    await setSetting(db, "mail.gmailGrants", { "30": { send: true, read: false, at: 1 } });
    await exec(
      "INSERT INTO messages (id, direction, purpose, mailbox_id, to_address, peer_hash, peer_domain, status, created_at) VALUES (1, 'out', 'test', 30, 'ofis@firma.example', 'h', 'firma.example', 'sent', 1)",
    );
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      verified: {
        baseUrl: "https://c.firma.example",
        kid: "0123456789abcdef",
        jti: "j",
        verifiedAt: 1,
      },
    });
    await setSecret(BACKUP_PASSPHRASE_SECRET, "uzun ve gizli bir parola");
    await exec(
      `INSERT INTO backups (kind, status, file_name, folder, size_bytes, sha256, finished_at, app_version, schema_migrations, created_at) VALUES ('weekly', 'ok', 'yedek-haftalik.umbk', '/y', 1, '${"b".repeat(64)}', 5, '0.1.0', 7, 1)`,
    );
    const c = await getOnboardingChecklist(db);
    expect(c).toMatchObject({ done: 7, total: 7, allDone: true });
    expect(c.items.filter((i) => i.demo).map((i) => i.id)).toEqual(["dataSource", "firstScan"]);
  });
});

describe("gizle / yeniden göster", () => {
  const audits = async (action: string) =>
    (await db.select().from(auditLog).where(eq(auditLog.action, action))).length;

  it("gizleme idempotent: ilk an korunur, tek denetim kaydı", async () => {
    const a = await dismissOnboarding(db, 1000);
    expect(a).toEqual({ dismissedAt: 1000, changed: true });
    const b = await dismissOnboarding(db, 2000);
    expect(b).toEqual({ dismissedAt: 1000, changed: false });
    expect((await getOnboardingChecklist(db)).dismissedAt).toBe(1000);
    expect(await audits("onboarding.dismiss")).toBe(1);
  });

  it("yeniden gösterme idempotent ve yalnızca değişince denetlenir", async () => {
    expect(await restoreOnboarding(db)).toEqual({ dismissedAt: null, changed: false });
    expect(await audits("onboarding.restore")).toBe(0);
    await dismissOnboarding(db, 1000);
    expect(await restoreOnboarding(db)).toEqual({ dismissedAt: null, changed: true });
    expect((await getOnboardingChecklist(db)).dismissedAt).toBeNull();
    expect(await audits("onboarding.restore")).toBe(1);
    const row = (
      await db.select().from(auditLog).where(eq(auditLog.action, "onboarding.restore"))
    )[0];
    expect(row?.detail).toEqual({ hiddenAt: 1000 });
  });

  it("aynı anda iki gizleme isteği tek denetim kaydı bırakır", async () => {
    await Promise.all([dismissOnboarding(db, 1), dismissOnboarding(db, 2)]);
    expect(await audits("onboarding.dismiss")).toBe(1);
  });
});

describe("uçlar", () => {
  it("GET /api/onboarding: liste, kişisel veri yok, önbelleksiz", async () => {
    await completeSetup("mock");
    const res = await listRoute.GET(req("GET", "/api/onboarding"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["allDone", "dismissedAt", "done", "items", "total"]);
    expect(body.items[0]).toEqual({ id: "setup", done: true, href: "/setup" });
    expect(body.items[1]).toEqual({
      id: "dataSource",
      done: true,
      href: "/settings#google",
      demo: true,
    });
    const text = JSON.stringify(body);
    for (const pii of ["Ayşe", "Örnek", "1234567890", "@"]) expect(text).not.toContain(pii);
  });

  it("POST dismiss/restore: `{}` kabul, ek alan ve bozuk JSON 400", async () => {
    const d = await dismissRoute.POST(req("POST", "/api/onboarding/dismiss", {}), undefined);
    expect(d.status).toBe(200);
    const dismissedAt = (await json(d)).dismissedAt;
    expect(typeof dismissedAt).toBe("number");
    const again = await json(
      await dismissRoute.POST(req("POST", "/api/onboarding/dismiss", {}), undefined),
    );
    expect(again.dismissedAt).toBe(dismissedAt);
    expect(
      (await json(await listRoute.GET(req("GET", "/api/onboarding"), undefined))).dismissedAt,
    ).toBe(dismissedAt);

    const bad = await dismissRoute.POST(
      req("POST", "/api/onboarding/dismiss", { at: 5 }),
      undefined,
    );
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("VALIDATION");
    const broken = await restoreRoute.POST(
      new Request(`${ORIGIN}/api/onboarding/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: "{",
      }),
      undefined,
    );
    expect(broken.status).toBe(400);
    expect((await json(broken)).code).toBe("BAD_JSON");

    const r = await restoreRoute.POST(req("POST", "/api/onboarding/restore", {}), undefined);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ dismissedAt: null });
    expect(
      (await json(await listRoute.GET(req("GET", "/api/onboarding"), undefined))).dismissedAt,
    ).toBeNull();
  });

  it("başka siteden gelen değiştirme isteği genel korumada reddedilir", async () => {
    for (const path of ["/api/onboarding/dismiss", "/api/onboarding/restore"]) {
      const res = middleware(
        new NextRequest(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:3000",
            origin: "https://kotu.example",
            "sec-fetch-site": "cross-site",
          },
        }),
      );
      expect(res.status, path).toBe(403);
    }
  });
});
