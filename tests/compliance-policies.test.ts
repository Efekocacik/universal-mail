import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  policyScopeForMailbox,
  policyStrictness,
  resolveCountryPolicy,
  seedCountryPolicies,
} from "@/lib/compliance/policies";
import {
  listCountryPolicies,
  PolicyChangeError,
  tightenDemoPolicy,
  type PolicyChangeErrorKind,
} from "@/lib/compliance/policy-service";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import { auditLog, countryPolicies } from "@/lib/db/schema";
import { COUNTRY_CODES } from "@/lib/geo/countries";

/**
 * Ülke politikası servisi ve çözümleyicisi. Veritabanı BELLEKTE açılır; gerçek `.data` veritabanına dokunulmaz.
 */

let client: Client;
let db: Db;
const NOW = 1_790_000_000_000;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
  await seedCountryPolicies(db, NOW);
});

afterEach(() => {
  client.close();
});

async function stored(scope: "live" | "demo", code: string) {
  const [row] = await db
    .select()
    .from(countryPolicies)
    .where(and(eq(countryPolicies.scope, scope), eq(countryPolicies.countryCode, code)));
  return row;
}

async function policyAudits() {
  return db.select().from(auditLog).where(eq(auditLog.action, "country_policy.tightened"));
}

async function expectRejected(input: unknown, kind: PolicyChangeErrorKind) {
  const err = await tightenDemoPolicy(db, input, NOW + 1).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PolicyChangeError);
  expect((err as PolicyChangeError).kind).toBe(kind);
}

describe("demo politikası sıkılaştırma", () => {
  it("allowed → generic_only → blocked geçişlerine izin verir ve her birini denetim kaydına yazar", async () => {
    expect(
      await tightenDemoPolicy(
        db,
        { scope: "demo", countryCode: "GB", mode: "generic_only", note: "deneme" },
        NOW + 1,
      ),
    ).toEqual({ changed: true, countryCode: "GB", from: "allowed", to: "generic_only" });
    expect(
      await tightenDemoPolicy(db, { scope: "demo", countryCode: "gb", mode: "blocked" }, NOW + 2),
    ).toEqual({ changed: true, countryCode: "GB", from: "generic_only", to: "blocked" });
    expect(
      await tightenDemoPolicy(db, { scope: "demo", countryCode: "FR", mode: "blocked" }),
    ).toMatchObject({
      changed: true,
      from: "allowed",
    });

    expect(await stored("demo", "GB")).toMatchObject({
      mode: "blocked",
      note: "deneme",
      updatedAt: NOW + 2,
    });
    const audits = await policyAudits();
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      entity: "country_policy",
      entityId: "demo:GB",
      detail: {
        scope: "demo",
        countryCode: "GB",
        from: "allowed",
        to: "generic_only",
        note: "deneme",
      },
    });
    expect((await resolveCountryPolicy(db, "demo", "GB")).mode).toBe("blocked");
  });

  it("aynı moda geçiş değişiklik sayılmaz ve denetim kaydı oluşturmaz", async () => {
    expect(
      await tightenDemoPolicy(db, { scope: "demo", countryCode: "ES", mode: "generic_only" }),
    ).toEqual({
      changed: false,
      countryCode: "ES",
      from: "generic_only",
      to: "generic_only",
    });
    expect(await policyAudits()).toHaveLength(0);
  });

  it("gevşetmeyi reddeder: blocked → allowed, blocked → generic_only, generic_only → allowed", async () => {
    await expectRejected(
      { scope: "demo", countryCode: "DE", mode: "allowed" },
      "loosening_forbidden",
    );
    await expectRejected(
      { scope: "demo", countryCode: "DE", mode: "generic_only" },
      "loosening_forbidden",
    );
    await expectRejected(
      { scope: "demo", countryCode: "ES", mode: "allowed" },
      "loosening_forbidden",
    );
    await tightenDemoPolicy(db, { scope: "demo", countryCode: "GB", mode: "blocked" });
    await expectRejected(
      { scope: "demo", countryCode: "GB", mode: "allowed" },
      "loosening_forbidden",
    );

    expect((await stored("demo", "DE"))?.mode).toBe("blocked");
    expect((await stored("demo", "ES"))?.mode).toBe("generic_only");
    expect(await policyAudits()).toHaveLength(1); // yalnızca GB sıkılaştırması
  });

  it("live kapsamı hiçbir şekilde değiştirilemez (sıkılaştırma dahil)", async () => {
    await expectRejected({ scope: "live", countryCode: "GB", mode: "allowed" }, "live_locked");
    await expectRejected({ scope: "live", countryCode: "GB", mode: "blocked" }, "live_locked");
    await expectRejected({ scope: "LIVE", countryCode: "GB", mode: "allowed" }, "live_locked");
    expect(await stored("live", "GB")).toMatchObject({ mode: "blocked", locked: true });
    expect(await policyAudits()).toHaveLength(0);
  });

  it("geçersiz girdileri reddeder ve hiçbir şeyi değiştirmez", async () => {
    await expectRejected(null, "invalid_input");
    await expectRejected("GB", "invalid_input");
    await expectRejected({ scope: "demo", countryCode: "GB" }, "invalid_input");
    await expectRejected(
      { scope: "demo", countryCode: "GB", mode: "blocked", extra: 1 },
      "invalid_input",
    );
    await expectRejected({ scope: "demo", countryCode: 42, mode: "blocked" }, "invalid_input");
    await expectRejected({ scope: "demo", countryCode: "US", mode: "blocked" }, "unknown_country");
    await expectRejected({ scope: "demo", countryCode: "G", mode: "blocked" }, "unknown_country");
    await expectRejected(
      { scope: "demo", countryCode: "GB'--", mode: "blocked" },
      "unknown_country",
    );
    await expectRejected({ scope: "demo", countryCode: "GB", mode: "open" }, "invalid_mode");
    await expectRejected({ scope: "demo", countryCode: "GB", mode: "ALLOWED" }, "invalid_mode");
    await expectRejected(
      { scope: "demo", countryCode: "GB", mode: "blocked", note: "x".repeat(501) },
      "invalid_input",
    );
    expect((await stored("demo", "GB"))?.mode).toBe("allowed");
    expect(await policyAudits()).toHaveLength(0);
  });

  it("kaydı olmayan ülke değiştirilemez ama engelli sayılmaya devam eder", async () => {
    await db
      .delete(countryPolicies)
      .where(and(eq(countryPolicies.scope, "demo"), eq(countryPolicies.countryCode, "PT")));
    await expectRejected({ scope: "demo", countryCode: "PT", mode: "blocked" }, "no_policy");
    expect(await resolveCountryPolicy(db, "demo", "PT")).toEqual({
      mode: "blocked",
      reason: "no_policy",
    });
  });

  it("değişiklik ile denetim kaydı birlikte yazılır: kayıt başarısızsa politika da değişmez", async () => {
    // Denetim tablosuna yazmayı engelleyen geçici bir tetikleyici ile hata anındaki davranış.
    await client.execute(
      "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    const err = await tightenDemoPolicy(db, {
      scope: "demo",
      countryCode: "NL",
      mode: "blocked",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    await client.execute("DROP TRIGGER fail_audit");
    expect((await stored("demo", "NL"))?.mode).toBe("allowed");
  });
});

describe("politika listesi", () => {
  it("demo listesi tüm ülkeleri verir; yalnızca sıkılaştırılabilecek satırlar düzenlenebilir", async () => {
    const list = await listCountryPolicies(db, "demo");
    expect(list.map((p) => p.countryCode)).toEqual([...COUNTRY_CODES]);
    expect(list.find((p) => p.countryCode === "GB")).toMatchObject({
      mode: "allowed",
      editable: true,
    });
    expect(list.find((p) => p.countryCode === "DE")).toMatchObject({
      mode: "blocked",
      editable: false,
    });
  });

  it("live listesi her zaman blocked, kilitli ve düzenlenemez", async () => {
    const list = await listCountryPolicies(db, "live");
    expect(list).toHaveLength(COUNTRY_CODES.length);
    expect(list.every((p) => p.mode === "blocked" && p.locked && !p.editable)).toBe(true);
  });

  it("eksik kayıt blocked ve düzenlenemez listelenir", async () => {
    await db
      .delete(countryPolicies)
      .where(and(eq(countryPolicies.scope, "demo"), eq(countryPolicies.countryCode, "GB")));
    expect(
      (await listCountryPolicies(db, "demo")).find((p) => p.countryCode === "GB"),
    ).toMatchObject({
      mode: "blocked",
      storedMode: null,
      editable: false,
    });
  });

  it("geçersiz kapsam reddedilir", async () => {
    await expect(listCountryPolicies(db, "test" as never)).rejects.toBeInstanceOf(
      PolicyChangeError,
    );
  });
});

describe("kapsam ayrımı ve güvenli varsayılan", () => {
  it("kapsam yalnızca posta kutusu sağlayıcısından belirlenir; demo dışı her şey live", () => {
    expect(policyScopeForMailbox("demo")).toBe("demo");
    for (const p of ["gmail", "smtp", "DEMO", "", null, undefined, "demo "]) {
      expect(policyScopeForMailbox(p)).toBe("live");
    }
  });

  it("demo'da izinli ülke live kapsamında engelli kalır", async () => {
    expect((await resolveCountryPolicy(db, "demo", "GB")).mode).toBe("allowed");
    expect(await resolveCountryPolicy(db, "live", "GB")).toEqual({
      mode: "blocked",
      reason: "live_disabled",
    });
    expect((await resolveCountryPolicy(db, policyScopeForMailbox("gmail"), "GB")).mode).toBe(
      "blocked",
    );
  });

  it("geçersiz kapsam ve geçersiz kayıtlı mod blocked sayılır", async () => {
    expect(await resolveCountryPolicy(db, "staging" as never, "GB")).toEqual({
      mode: "blocked",
      reason: "unknown_scope",
    });
    // CHECK kısıtını atlayarak bozuk bir değer yazılmış olsa bile gevşek yorumlanmaz.
    await client.execute("PRAGMA ignore_check_constraints = ON");
    await client.execute(
      "UPDATE country_policies SET mode = 'open' WHERE scope = 'demo' AND country_code = 'NL'",
    );
    await client.execute("PRAGMA ignore_check_constraints = OFF");
    expect(await resolveCountryPolicy(db, "demo", "NL")).toEqual({
      mode: "blocked",
      reason: "invalid_policy",
    });
    expect(
      (await listCountryPolicies(db, "demo")).find((p) => p.countryCode === "NL"),
    ).toMatchObject({
      mode: "blocked",
      storedMode: "open",
      editable: false,
    });
    await expectRejected(
      { scope: "demo", countryCode: "NL", mode: "generic_only" },
      "loosening_forbidden",
    );
  });

  it("kısıtlayıcılık sırası", () => {
    expect(policyStrictness("allowed")).toBeLessThan(policyStrictness("generic_only"));
    expect(policyStrictness("generic_only")).toBeLessThan(policyStrictness("blocked"));
  });
});
