import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toLibsqlUrl } from "@/lib/config/paths";
import {
  applyLiveCountryApproval,
  AUDIT_ACTION,
  LiveCountryApprovalError,
  parseApprovalInput,
  planLiveCountryApproval,
  violatedChecks,
  type ApprovalInput,
} from "@/lib/compliance/live-country-approval";
import { resolveCountryPolicy, seedCountryPolicies } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import { auditLog, countryPolicies } from "@/lib/db/schema";
import { MIGRATIONS, openMemoryDb, T0 } from "./helpers/campaign-fixture";

// Onay nesnesi: bu dosyadaki süreç içi testlerde her testten önce HEPSİ false yapılır (onaysız sürümün reddini
// korumak için); "uygulama" testlerinde `liveCountryPolicies` test içinde true yapılır. Gerçek sabitler (bu sürümde
// sahip kararıyla hepsi true) DEĞİŞMEZ; gerçek süreçle çalışan betik testleri gerçek sabitleri kullanır.
const legal = vi.hoisted(() => ({ a: {} as Record<string, boolean> }));
vi.mock("@/lib/compliance/legal-status", async (orig) => {
  const m = await orig<typeof import("@/lib/compliance/legal-status")>();
  legal.a = { ...m.LEGAL_APPROVALS };
  return { ...m, LEGAL_APPROVALS: legal.a };
});

/**
 * Canlı ülke politikası onay betiği (go-live C10-a). Varsayılan plan hiçbir şeyi değiştirmez; uygulama hukuki onay
 * sabiti olmadan, CHECK kısıtına uymayan değerlerle veya kilitli/engelli olmayan satırda reddedilir; geçerliyse bütün
 * ülkeler ve denetim kayıtları tek işlemde yazılır. Betik uygulamanın hiçbir yerinden içe aktarılmaz.
 */

const REPO = path.resolve(__dirname, "..");
let client: Client;
let db: Db;

const INPUT: ApprovalInput = {
  countries: ["GB", "FR"],
  mode: "allowed",
  approvalRef: "HUK-2026-014",
  approvedBy: "Av. Örnek Kişi",
};

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedCountryPolicies(db, T0);
  for (const k of Object.keys(legal.a)) legal.a[k] = false;
});
afterEach(() => {
  for (const k of Object.keys(legal.a)) legal.a[k] = false;
  client.close();
});

const liveRows = () =>
  db
    .select()
    .from(countryPolicies)
    .where(eq(countryPolicies.scope, "live"))
    .orderBy(countryPolicies.countryCode);
const audits = () => db.select().from(auditLog).where(eq(auditLog.action, AUDIT_ACTION));

describe("girdi doğrulaması", () => {
  const ok = {
    countries: "gb, FR,gb",
    mode: "generic_only",
    approvalRef: "  HUK-1  ",
    approvedBy: "Av. A",
  };
  it("ülke kodları normalleştirilir ve tekilleştirilir; metinler kırpılır", () => {
    expect(parseApprovalInput(ok)).toEqual({
      countries: ["GB", "FR"],
      mode: "generic_only",
      approvalRef: "HUK-1",
      approvedBy: "Av. A",
    });
  });
  it.each([
    [{ ...ok, countries: undefined }, /--countries/],
    [{ ...ok, approvalRef: "--apply" }, /--approval-ref/],
    [{ ...ok, mode: "blocked" }, /Geçersiz mod/],
    [{ ...ok, mode: "open" }, /Geçersiz mod/],
    [{ ...ok, countries: "XX" }, /Desteklenmeyen ülke/],
    [{ ...ok, countries: "GBR" }, /Desteklenmeyen ülke/],
    [{ ...ok, countries: " , " }, /1–60 ülke/],
    [{ ...ok, approvalRef: "ab" }, /Onay referansı/],
    [{ ...ok, approvedBy: "Av.\u0007A" }, /kontrol karakteri/],
  ])("geçersiz girdi reddedilir (%#)", (raw, msg) => {
    expect(() => parseApprovalInput(raw)).toThrow(LiveCountryApprovalError);
    expect(() => parseApprovalInput(raw)).toThrow(msg);
  });
});

describe("CHECK kısıtı karşılığı (violatedChecks) veritabanıyla birebir", () => {
  const base = {
    scope: "live",
    countryCode: "GB",
    mode: "allowed",
    locked: false,
    approvalRef: "R",
    approvedBy: "B",
    approvedAt: T0,
  };
  it.each([
    [base, []],
    [{ ...base, locked: true }, ["country_policies_lock_ck"]],
    [{ ...base, approvalRef: null }, ["country_policies_approval_ck"]],
    [{ ...base, approvedAt: null, mode: "generic_only" }, ["country_policies_approval_ck"]],
    [{ ...base, mode: "blocked", locked: true, approvalRef: null }, []],
    [{ ...base, mode: "nope" }, ["country_policies_mode_ck"]],
    [{ ...base, countryCode: "GBR" }, ["country_policies_code_ck"]],
  ])("satır %# → %j", async (row, expected) => {
    expect(violatedChecks(row)).toEqual(expected);
    const ins = client.execute({
      sql: "INSERT INTO country_policies (scope, country_code, mode, locked, approval_ref, approved_by, approved_at, seed_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
      args: [
        row.scope,
        `Z${row.countryCode.slice(1)}`,
        row.mode,
        row.locked ? 1 : 0,
        row.approvalRef,
        row.approvedBy,
        row.approvedAt,
        T0,
      ],
    });
    if (expected.length === 0) await expect(ins).resolves.toBeDefined();
    else await expect(ins).rejects.toThrow(new RegExp(expected[0]!));
  });
});

describe("plan (varsayılan): hiçbir şeyi değiştirmez", () => {
  it("bu sürümün gerçek hukuki onayıyla plan hazır DEĞİL; uygulama reddedilir ve hiçbir şey yazılmaz", async () => {
    const before = await liveRows();
    const p = await planLiveCountryApproval(db, INPUT, T0);
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/liveCountryPolicies/);
    expect(p.countries.map((c) => [c.countryCode, c.from, c.problems])).toEqual([
      ["GB", { mode: "blocked", locked: true }, []],
      ["FR", { mode: "blocked", locked: true }, []],
    ]);
    await expect(applyLiveCountryApproval(db, INPUT, { now: T0 })).rejects.toThrow(
      /liveCountryPolicies/,
    );
    expect(await liveRows()).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });

  it("onay verilmiş olsa bile plan yazmaz", async () => {
    legal.a.liveCountryPolicies = true;
    const before = await liveRows();
    const p = await planLiveCountryApproval(db, INPUT, T0);
    expect(p.ready).toBe(true);
    expect(await liveRows()).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
});

describe("uygulama (--apply)", () => {
  it("tek işlemde: locked=0, mod ve onay alanları + ülke başına denetim kaydı; diğer ülkeler ve demo değişmez", async () => {
    legal.a.liveCountryPolicies = true;
    const demoBefore = await db
      .select()
      .from(countryPolicies)
      .where(eq(countryPolicies.scope, "demo"));
    const r = await applyLiveCountryApproval(db, INPUT, { now: T0 + 5 });
    expect(r).toEqual({ approved: ["GB", "FR"], approvedAt: T0 + 5 });
    const rows = await liveRows();
    for (const code of ["GB", "FR"]) {
      expect(rows.find((x) => x.countryCode === code)).toMatchObject({
        mode: "allowed",
        locked: false,
        approvalRef: "HUK-2026-014",
        approvedBy: "Av. Örnek Kişi",
        approvedAt: T0 + 5,
        updatedAt: T0 + 5,
      });
    }
    expect(rows.filter((x) => !x.locked).map((x) => x.countryCode)).toEqual(["FR", "GB"]);
    expect(
      await db.select().from(countryPolicies).where(eq(countryPolicies.scope, "demo")),
    ).toEqual(demoBefore);
    const a = await audits();
    expect(a.map((x) => x.entityId).sort()).toEqual(["live:FR", "live:GB"]);
    expect(a[0]!.detail).toMatchObject({
      scope: "live",
      from: { mode: "blocked", locked: true },
      to: { mode: "allowed", locked: false },
      approvalRef: "HUK-2026-014",
    });
    // Kod kapısı (LIVE_SENDING_ENABLED) bu sürümde açık: açılan satır çözümleyicide izinli olur; kilitli kalanlar
    // engelli kalır. (Gönderim yine de çalışma anı hazırlığı ister: bkz. live-gates-open.test.ts.)
    expect(await resolveCountryPolicy(db, "live", "GB")).toEqual({ mode: "allowed", reason: null });
    expect(await resolveCountryPolicy(db, "live", "DE")).toEqual({
      mode: "blocked",
      reason: "locked",
    });
  });

  it("bir ülke uygun değilse (zaten açılmış / satır yok) HİÇBİR ülke yazılmaz; ikinci uygulama reddedilir", async () => {
    legal.a.liveCountryPolicies = true;
    await applyLiveCountryApproval(db, { ...INPUT, countries: ["GB"] }, { now: T0 });
    const before = await liveRows();
    await expect(
      applyLiveCountryApproval(db, { ...INPUT, countries: ["FR", "GB"] }, { now: T0 + 1 }),
    ).rejects.toThrow(/GB: satır zaten/);
    await db
      .delete(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "NL")));
    await expect(
      applyLiveCountryApproval(db, { ...INPUT, countries: ["FR", "NL"] }, { now: T0 + 2 }),
    ).rejects.toThrow(/NL: canlı politika satırı yok/);
    const after = await liveRows();
    expect(after).toEqual(before.filter((r) => r.countryCode !== "NL"));
    expect(after.find((r) => r.countryCode === "FR")).toMatchObject({ locked: true });
    expect(await audits()).toHaveLength(1);
  });
});

describe("betik uygulamadan ayrıdır", () => {
  function walk(d: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name)) out.push(f);
    }
    return out;
  }
  it("src/, electron/ ve diğer betiklerde içe aktarılmaz", () => {
    const self = path.join(REPO, "src", "lib", "compliance", "live-country-approval.ts");
    const cli = path.join(REPO, "scripts", "approve-live-country.ts");
    const files = ["src", "electron", "scripts"].flatMap((r) => walk(path.join(REPO, r)));
    const hits = files.filter(
      (f) =>
        f !== self &&
        f !== cli &&
        /live-country-approval|approve-live-country/.test(fs.readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("betik (gerçek süreç, gerçek sabitler): --db zorunlu, varsayılan plan, bu sürümde sahibin --apply'ı uygular", () => {
  let dir: string;
  let file: string;
  let fc: Client;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-approve-"));
    file = path.join(dir, "app.db");
    fc = createClient({ url: toLibsqlUrl(file) });
    const fdb = drizzle(fc, { schema: { ...schema, ...cacheSchema } });
    await migrate(fdb, { migrationsFolder: MIGRATIONS });
    await seedCountryPolicies(fdb as unknown as Db, T0);
  });
  afterEach(() => {
    fc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runCli(args: string[], env: Record<string, string> = {}) {
    return new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(REPO, "scripts", "approve-live-country.ts"), ...args],
        { cwd: REPO, env: { ...process.env, ...env } },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    });
  }
  const snapshot = async () =>
    JSON.stringify(
      (
        await fc.execute(
          "SELECT scope, country_code, mode, locked, approval_ref FROM country_policies ORDER BY 1, 2",
        )
      ).rows,
    ) + JSON.stringify((await fc.execute("SELECT COUNT(*) FROM audit_log")).rows);
  const ARGS = [
    "--countries",
    "GB,FR",
    "--mode",
    "allowed",
    "--approval-ref",
    "HUK-2026-014",
    "--approved-by",
    "Av. Örnek",
  ];

  it("--db olmadan veya olmayan dosyayla reddedilir; ortam değişkeni hedef olmaz, dosya oluşturulmaz", async () => {
    const r = await runCli(ARGS, { UM_DB_PATH: file });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--db .* zorunlu/);
    const missing = path.join(dir, "yok.db");
    const r2 = await runCli(["--db", missing, ...ARGS, "--apply"]);
    expect(r2.code).toBe(2);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("plan hiçbir şeyi değiştirmez ve engel yazmaz; --apply yalnızca istenen ülkeleri açar, ikinci kez reddedilir", async () => {
    const before = await snapshot();
    const plan = await runCli(["--db", file, ...ARGS]);
    expect(plan.out).toContain("hiçbir şey değiştirilmedi");
    expect(plan.out).toContain(path.resolve(file));
    expect(plan.out).toMatch(/GB: blocked \(kilitli\) → allowed/);
    expect(plan.out).toContain("--apply ile");
    expect(plan.err).not.toMatch(/liveCountryPolicies/);
    expect(plan.code).toBe(0);
    const bad = await runCli(["--db", file, ...ARGS.slice(0, 3), "blocked", ...ARGS.slice(4)]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Geçersiz mod/);
    expect(await snapshot()).toBe(before);

    const apply = await runCli(["--db", file, ...ARGS, "--apply"]);
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    expect(apply.out).toMatch(/Canlı politika kilidi açıldı: GB, FR → allowed/);
    const open = await fc.execute(
      "SELECT country_code FROM country_policies WHERE scope = 'live' AND locked = 0 ORDER BY 1",
    );
    expect(open.rows.map((r) => r.country_code)).toEqual(["FR", "GB"]);
    const again = await runCli(["--db", file, ...ARGS, "--apply"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/satır zaten/);
  });
});
