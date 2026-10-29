import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_POLICY_PRESET,
  LIVE_SENDING_ENABLED,
  resolveCountryPolicy,
  seedCountryPolicies,
} from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import { countryPolicies, mailboxes, templates } from "@/lib/db/schema";
import { COUNTRY_CODES } from "@/lib/geo/countries";
import { BUILTIN_TEMPLATES, textToHtml } from "@/lib/mail/builtin-templates";
import { DEMO_MAILBOX_ADDRESS, seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { TEMPLATE_VARIABLES, templateVariablesIn } from "@/lib/mail/variables";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Faz 3 seed'leri. Veritabanı BELLEKTE açılır: gerçek `.data` veritabanına dokunulmaz ve Windows'taki libsql
 * dosya kilidi sorunu devreye girmez. `initDatabase` bilerek çağrılmaz (gerçek veri yolunu kullanır); seed
 * fonksiyonları doğrudan test edilir.
 */

let client: Client;
let db: Db;
const NOW = 1_790_000_000_000;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
});

afterEach(() => {
  client.close();
});

async function policy(scope: "live" | "demo", code: string) {
  const [row] = await db
    .select()
    .from(countryPolicies)
    .where(and(eq(countryPolicies.scope, scope), eq(countryPolicies.countryCode, code)));
  return row;
}

describe("ülke politikaları", () => {
  it("tüm ülkeler için live satırları blocked ve kilitli; demo ön ayarı uygulanır", async () => {
    expect(await seedCountryPolicies(db, NOW)).toBe(COUNTRY_CODES.length * 2);

    const live = await db.select().from(countryPolicies).where(eq(countryPolicies.scope, "live"));
    expect(live).toHaveLength(COUNTRY_CODES.length);
    expect(live.every((r) => r.mode === "blocked" && r.locked && r.approvalRef === null)).toBe(
      true,
    );

    const demo = await db.select().from(countryPolicies).where(eq(countryPolicies.scope, "demo"));
    expect(demo).toHaveLength(COUNTRY_CODES.length);
    for (const r of demo) {
      expect(r.locked).toBe(false);
      expect(r.mode, r.countryCode).toBe(DEMO_POLICY_PRESET[r.countryCode] ?? "blocked");
    }
    expect((await policy("demo", "DE"))?.mode).toBe("blocked");
    expect((await policy("demo", "TR"))?.mode).toBe("blocked");
  });

  it("tekrar çalıştırılınca kullanıcı ayarlarını değiştirmez, yalnızca eksik ülkeyi ekler", async () => {
    await seedCountryPolicies(db, NOW);
    await db
      .update(countryPolicies)
      .set({ mode: "blocked", updatedAt: NOW + 1 })
      .where(and(eq(countryPolicies.scope, "demo"), eq(countryPolicies.countryCode, "GB")));
    await db
      .update(countryPolicies)
      .set({ mode: "allowed", updatedAt: NOW + 1 })
      .where(and(eq(countryPolicies.scope, "demo"), eq(countryPolicies.countryCode, "PL")));
    await db
      .delete(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "SE")));

    expect(await seedCountryPolicies(db, NOW + 2)).toBe(1);
    expect((await policy("demo", "GB"))?.mode).toBe("blocked");
    expect((await policy("demo", "PL"))?.mode).toBe("allowed");
    expect(await policy("live", "SE")).toMatchObject({ mode: "blocked", locked: true });
    expect(await seedCountryPolicies(db, NOW + 3)).toBe(0);
  });

  it("live kapsamı her zaman blocked döner (onaylı ve kilidi açık satır olsa bile)", async () => {
    expect(LIVE_SENDING_ENABLED).toBe(false);
    await seedCountryPolicies(db, NOW);
    expect(await resolveCountryPolicy(db, "live", "GB")).toEqual({
      mode: "blocked",
      reason: "live_disabled",
    });
    // Veritabanının izin verdiği tek gevşetme yolu (onay kaydıyla) bile bu sürümde gönderimi açmaz.
    await db
      .update(countryPolicies)
      .set({
        locked: false,
        mode: "allowed",
        approvalRef: "test",
        approvedBy: "test",
        approvedAt: NOW,
      })
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "GB")));
    expect((await resolveCountryPolicy(db, "live", "GB")).mode).toBe("blocked");
  });

  it("eksik, bilinmeyen veya boş ülke her zaman blocked sayılır", async () => {
    // Tablo boşken bile.
    expect(await resolveCountryPolicy(db, "demo", "GB")).toEqual({
      mode: "blocked",
      reason: "no_policy",
    });
    await seedCountryPolicies(db, NOW);
    expect(await resolveCountryPolicy(db, "demo", "gb")).toEqual({ mode: "allowed", reason: null });
    expect((await resolveCountryPolicy(db, "demo", "ES")).mode).toBe("generic_only");
    expect((await resolveCountryPolicy(db, "demo", "DE")).mode).toBe("blocked");
    expect(await resolveCountryPolicy(db, "demo", "US")).toEqual({
      mode: "blocked",
      reason: "no_policy",
    });
    for (const bad of [null, undefined, "", "G", "GBR", "1A"]) {
      expect(await resolveCountryPolicy(db, "demo", bad)).toEqual({
        mode: "blocked",
        reason: "unknown_country",
      });
    }
  });
});

describe("demo posta kutusu", () => {
  it("kimlik bilgisi olmayan, gerçek adrese çözülmeyen tek bir demo kutusu ekler", async () => {
    expect(await seedDemoMailbox(db, NOW)).toBe(1);
    const rows = await db.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "demo",
      address: DEMO_MAILBOX_ADDRESS,
      credentialsRef: null,
      smtpHost: null,
      status: "connected",
      dailyCap: 20,
    });
    expect(DEMO_MAILBOX_ADDRESS.endsWith(".invalid")).toBe(true);
    expect(await seedDemoMailbox(db, NOW + 1)).toBe(0);
    expect(await db.select().from(mailboxes)).toHaveLength(1);
  });

  it("kullanıcının değişikliklerini korur; silinen kutuyu yeniden eklemez", async () => {
    await seedDemoMailbox(db, NOW);
    await db.update(mailboxes).set({ label: "Benim demom", dailyCap: 5 });
    await seedDemoMailbox(db, NOW + 1);
    expect(await db.select().from(mailboxes)).toMatchObject([
      { label: "Benim demom", dailyCap: 5 },
    ]);

    await db.delete(mailboxes);
    expect(await seedDemoMailbox(db, NOW + 2)).toBe(0);
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("zaten bir demo kutusu varsa ikincisini eklemez", async () => {
    await db.insert(mailboxes).values({
      provider: "demo",
      label: "Önceden var",
      address: "other@demo.invalid",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await seedDemoMailbox(db, NOW)).toBe(0);
    expect(await db.select().from(mailboxes)).toHaveLength(1);
    expect((await getSetting(db, "seed.faz3")).demoMailbox).toBe(1);
  });
});

describe("hazır şablonlar", () => {
  it("Türkçe ve İngilizce ilk e-posta şablonlarını bir kez ekler", async () => {
    expect(await seedBuiltinTemplates(db, NOW)).toBe(2);
    const rows = await db.select().from(templates);
    expect(rows.map((r) => r.language).sort()).toEqual(["en", "tr"]);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "initial", builtIn: true, version: 1, archivedAt: null });
      expect(r.bodyHtml).toBe(textToHtml(r.bodyText));
    }
    expect(await seedBuiltinTemplates(db, NOW + 1)).toBe(0);
    expect(await db.select().from(templates)).toHaveLength(2);
  });

  it("düzenlenen veya silinen şablonu geri getirmez ya da değiştirmez", async () => {
    await seedBuiltinTemplates(db, NOW);
    const [en, tr] = await db.select().from(templates).orderBy(templates.language);
    await db
      .update(templates)
      .set({ subject: "Kendi konum", version: 2 })
      .where(eq(templates.id, en!.id));
    await db.delete(templates).where(eq(templates.id, tr!.id));

    expect(await seedBuiltinTemplates(db, NOW + 1)).toBe(0);
    const rows = await db.select().from(templates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "Kendi konum", version: 2 });
  });

  it("şablonlar yalnızca bilinen değişkenleri kullanır; Google verisine ve alt bilgiye dayanmaz", () => {
    const known = new Map(TEMPLATE_VARIABLES.map((v) => [v.key, v]));
    for (const t of BUILTIN_TEMPLATES) {
      const used = templateVariablesIn(`${t.subject}\n${t.bodyText}`);
      expect(used.length, t.name).toBeGreaterThan(0);
      for (const v of used) {
        expect(known.has(v), `${t.name}: {{${v}}}`).toBe(true);
        expect(known.get(v)!.google, `${t.name}: {{${v}}} Google verisi`).toBeFalsy();
        expect(known.get(v)!.footer, `${t.name}: {{${v}}} alt bilgiye ait`).toBeFalsy();
      }
      expect(t.bodyText).not.toContain("{{kisisel_giris}}");
    }
  });

  it("HTML dönüşümü metni kaçışlar ve değişkenleri korur", () => {
    expect(textToHtml("A <b> & 'x'\nsatır\n\n{{firma}}")).toBe(
      "<p>A &lt;b&gt; &amp; &#39;x&#39;<br>satır</p>\n<p>{{firma}}</p>",
    );
  });
});

describe("seed bayrakları ve diğer ayarlar", () => {
  it("iki seed birbirinin bayrağını ezmez; kullanıcı ayarlarına dokunmaz", async () => {
    await setSetting(db, "budget.monthlyUsd", 55);
    await setSetting(db, "targets.countries", ["GB", "NL"]);
    await seedCountryPolicies(db, NOW);
    await seedBuiltinTemplates(db, NOW);
    await seedDemoMailbox(db, NOW);
    expect(await getSetting(db, "seed.faz3")).toEqual({ templates: 1, demoMailbox: 1 });
    expect(await getSetting(db, "budget.monthlyUsd")).toBe(55);
    expect(await getSetting(db, "targets.countries")).toEqual(["GB", "NL"]);
  });
});
