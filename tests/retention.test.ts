import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleError } from "@/lib/backup/errors";
import {
  auditLog,
  jobs,
  leadEmails,
  leads,
  messages,
  notifications,
  registryCompanies,
} from "@/lib/db/schema";
import { getJobHandler, clearJobHandlers } from "@/lib/jobs/registry";
import { registerLifecycleJobs, RETENTION_JOB } from "@/lib/lifecycle/jobs";
import {
  countRetentionCandidates,
  previewRetention,
  RETENTION_BATCH,
  retentionCutoff,
  runRetention,
  updateRetentionSettings,
} from "@/lib/lifecycle/retention";
import { getSetting } from "@/lib/settings";
import { runHousekeeping } from "@/worker/housekeeping";
import { addSequence, createCampaign, seedBase } from "./helpers/campaign-fixture";
import { backupEnv, insertLead, type BackupEnv } from "./helpers/backup-env";

/**
 * Paket Y.5 (FR-CMPL-04): saklama süresi. Önizleme sayısı = silinen sayı; temas edilmiş, kampanyalı (RESTRICT),
 * iletili ve "iletişim kurma" lead'ler korunur; bağlı kayıtlar CASCADE ile gider, sicil bağı NULL olur; 500'lük
 * gruplar; bayat önizleme 409; takvim ayı hesabı; bildirim, son çalıştırma ve günlük iş.
 */

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime(); // yerel saat
let env: BackupEnv;

beforeEach(async () => {
  env = await backupEnv();
});
afterEach(async () => {
  clearJobHandlers();
  await env.done();
});

describe("kesim tarihi (yerel takvim ayı)", () => {
  it("ay sonu kırpılır; 12 ay = bir yıl önce", () => {
    expect(new Date(retentionCutoff(new Date(2026, 2, 31, 10).getTime(), 1)).getDate()).toBe(28);
    expect(new Date(retentionCutoff(new Date(2028, 2, 31, 10).getTime(), 1)).getDate()).toBe(29);
    const c = new Date(retentionCutoff(NOW, 12));
    expect([c.getFullYear(), c.getMonth(), c.getDate(), c.getHours()]).toEqual([2025, 10, 16, 12]);
    const j = new Date(retentionCutoff(new Date(2026, 0, 15).getTime(), 3));
    expect([j.getFullYear(), j.getMonth()]).toEqual([2025, 9]);
  });
});

describe("saklama süresi", () => {
  async function fixture() {
    await seedBase(env.db);
    const raw = env.raw();
    const old = NOW - 400 * DAY;
    const ids = {
      oldNew: await insertLead(raw, { createdAt: old, status: "new" }),
      oldEnriched: await insertLead(raw, { createdAt: old, status: "enriched" }),
      oldNotInterested: await insertLead(raw, { createdAt: old, status: "not_interested" }),
      oldDnc: await insertLead(raw, { createdAt: old, status: "do_not_contact" }),
      oldContacted: await insertLead(raw, {
        createdAt: old,
        status: "sent",
        lastContactedAt: old + DAY,
      }),
      oldCustomer: await insertLead(raw, { createdAt: old, status: "customer" }),
      recent: await insertLead(raw, { createdAt: NOW - 30 * DAY, status: "new" }),
    };
    // Eski, temas edilmemiş ama kampanyada (RESTRICT) ve gelen iletili lead'ler korunur.
    const camp = await createCampaign(env.db, { status: "paused" });
    const seq = await addSequence(env.db, camp);
    await env.db.update(leads).set({ createdAt: old }).where(eq(leads.id, seq.leadId));
    const withMsg = await insertLead(raw, { createdAt: old, status: "new" });
    await env.db.insert(messages).values({
      direction: "in",
      purpose: "inbound",
      leadId: withMsg,
      mailboxId: 1,
      peerHash: "h".repeat(64),
      peerDomain: "firma.com",
      status: "received",
      createdAt: old,
    });
    // Silinecek lead'in bağlı kayıtları: e-posta (CASCADE) ve sicil bağı (SET NULL).
    await env.db.insert(leadEmails).values({
      leadId: ids.oldNew,
      email: "info@firma.com",
      domain: "firma.com",
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: old,
      updatedAt: old,
    });
    await raw.execute({
      sql: `INSERT INTO registry_companies(source,is_demo,external_id,name,name_norm,country_code,activity_scheme,activity_codes,incorporated_on,match_status,lead_id,first_seen_at,last_seen_at,updated_at)
            VALUES ('companies_house',1,'X1','Kafe Sicil','kafe sicil','GB','SIC2007','["56102"]','2026-01-02','matched',?,?,?,?)`,
      args: [ids.oldNew, old, old, old],
    });
    return { ...ids, campaignLead: seq.leadId, withMsg };
  }

  it("önizleme = silinen; korunanlar kalır; bağlı kayıtlar CASCADE/SET NULL; denetim, son çalıştırma ve bildirim", async () => {
    const f = await fixture();
    const p = await previewRetention(env.db, NOW);
    expect(p.settings).toEqual({ enabled: true, months: 12 });
    expect(p.preview.leads).toBe(3);
    const r = await runRetention(env.db, { now: NOW, expectedMax: 3, manual: true });
    expect(r).toEqual({ deleted: 3, cutoff: p.preview.cutoff });
    const left = (await env.db.select({ id: leads.id }).from(leads))
      .map((x) => x.id)
      .sort((a, b) => a - b);
    expect(left).toEqual(
      [f.oldDnc, f.oldContacted, f.oldCustomer, f.recent, f.campaignLead, f.withMsg].sort(
        (a, b) => a - b,
      ),
    );
    expect(await env.db.select().from(leadEmails).where(eq(leadEmails.leadId, f.oldNew))).toEqual(
      [],
    );
    const reg = await env.db.select().from(registryCompanies);
    expect(reg[0]!.leadId).toBeNull(); // sicil satırı kalır, bağı kopar
    expect(await getSetting(env.db, "retention.lastRun")).toEqual({
      at: NOW,
      cutoff: r.cutoff,
      deleted: 3,
    });
    const a = await env.db.select().from(auditLog).where(eq(auditLog.action, "retention.run"));
    expect(a[0]!.detail).toEqual({ cutoff: r.cutoff, deleted: 3, months: 12, manual: true });
    const n = await env.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, "retention.purged"));
    expect(n).toHaveLength(1);
    expect(n[0]!.params).toEqual({ n: 3 });
    expect(await countRetentionCandidates(env.db, r.cutoff)).toBe(0);
    // Hiçbir şey silinmezse bildirim eklenmez.
    expect((await runRetention(env.db, { now: NOW + 1000 })).deleted).toBe(0);
    expect(await env.db.select().from(notifications)).toHaveLength(1);
  });

  it("bayat önizleme: aday sayısı onaylanandan fazlaysa hiçbir şey silinmez (409 kodu)", async () => {
    await fixture();
    try {
      await runRetention(env.db, { now: NOW, expectedMax: 2 });
      expect.unreachable();
    } catch (e) {
      expect((e as LifecycleError).code).toBe("RETENTION_PREVIEW_STALE");
      expect((e as LifecycleError).status).toBe(409);
    }
    expect((await previewRetention(env.db, NOW)).preview.leads).toBe(3);
  });

  it("süre kısaltılınca önizleme büyür; 0 ve 13 ay geçersiz", async () => {
    const raw = env.raw();
    await insertLead(raw, { createdAt: NOW - 100 * DAY });
    expect((await previewRetention(env.db, NOW)).preview.leads).toBe(0);
    const u = await updateRetentionSettings(env.db, { enabled: true, months: 3 }, NOW);
    expect(u.preview.leads).toBe(1);
    await expect(updateRetentionSettings(env.db, { enabled: true, months: 13 })).rejects.toThrow();
    await expect(updateRetentionSettings(env.db, { enabled: true, months: 0 })).rejects.toThrow();
  });

  it("gruplar hâlinde siler (500'den fazla aday)", async () => {
    const raw = env.raw();
    const n = RETENTION_BATCH * 2 + 7;
    const old = NOW - 500 * DAY;
    await raw.execute({
      sql: `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < ?)
            INSERT INTO leads(source, status, created_at, updated_at) SELECT 'demo', 'new', ?, ? FROM s`,
      args: [n, old, old],
    });
    expect((await runRetention(env.db, { now: NOW })).deleted).toBe(n);
    expect(await env.db.select({ n: sql<number>`count(*)` }).from(leads)).toEqual([{ n: 0 }]);
  });

  it("günlük iş: bakım turu kapalıyken eklemez, açıkken günde bir ekler; işleyici siler", async () => {
    await insertLead(env.raw(), { createdAt: NOW - 400 * DAY });
    await updateRetentionSettings(env.db, { enabled: false, months: 12 });
    const off = await runHousekeeping(env.db, { now: NOW });
    expect(off.lifecycle).toEqual([]);
    await updateRetentionSettings(env.db, { enabled: true, months: 12 });
    expect((await runHousekeeping(env.db, { now: NOW })).lifecycle).toEqual([RETENTION_JOB]);
    expect((await runHousekeeping(env.db, { now: NOW + 3_600_000 })).lifecycle).toEqual([]);
    registerLifecycleJobs();
    const [job] = await env.db.select().from(jobs).where(eq(jobs.type, RETENTION_JOB));
    const logs: string[] = [];
    await getJobHandler(RETENTION_JOB)!({
      job: job!,
      payload: {},
      db: env.db,
      shouldStop: () => false,
      log: (m) => logs.push(m),
    });
    expect(await env.db.select().from(leads)).toEqual([]);
    expect(logs[0]).toMatch(/1 eski kayıt/);
    // Kapalıyken işleyici hiçbir şey yapmaz.
    await updateRetentionSettings(env.db, { enabled: false, months: 12 });
    await insertLead(env.raw(), { createdAt: NOW - 400 * DAY });
    await getJobHandler(RETENTION_JOB)!({
      job: job!,
      payload: {},
      db: env.db,
      shouldStop: () => false,
      log: () => undefined,
    });
    expect(await env.db.select().from(leads)).toHaveLength(1);
  });
});
