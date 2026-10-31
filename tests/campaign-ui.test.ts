import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as messagesRoute from "@/app/api/campaigns/[id]/messages/route";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { runPreflight } from "@/lib/campaigns/preflight";
import { createCampaign, setCampaignSteps } from "@/lib/campaigns/service";
import { ApiError } from "@/lib/client/api";
import {
  classifyMutationError,
  MAX_QUERY_RETRIES,
  queryRetryDelay,
  shouldRetryQuery,
} from "@/lib/client/retry";
import type { Db } from "@/lib/db/client";
import { leadEmails, leads, mailboxes, templates } from "@/lib/db/schema";
import {
  allowedActions,
  CAMPAIGN_STATUSES,
  isValidWindow,
  pauseReasonText,
  progressOf,
  reasonLabel,
  REMOVABLE_SEQUENCES,
  SEQUENCE_STATUSES,
  WINDOW_TIMES,
} from "@/features/campaigns/model";
import { PREVIEW_CSP, PREVIEW_SANDBOX, previewDocument } from "@/features/campaigns/preview-doc";
import { tr } from "@/lib/i18n/tr";
import { getProvider } from "@/lib/mail/provider/provider";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { createMailSendHandler, SCHEDULER_FLAG } from "@/lib/mail/scheduler/job";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Aşama 11: kampanya arayüzünün saf mantığı (DOM'suz), istemci yeniden deneme politikası, i18n eksiksizliği,
 * gönderim günlüğü API'si ve E2E'de zamanlayıcı açıkken yalnızca demo sağlayıcının kullanılması.
 */

describe("görünüm mantığı", () => {
  it("izinli eylemler sunucu geçiş tablosuyla tutarlı", () => {
    expect(allowedActions("draft")).toMatchObject({
      edit: true,
      prepare: true,
      start: false,
      cancel: true,
    });
    expect(allowedActions("ready")).toMatchObject({ edit: false, start: true, backToDraft: true });
    expect(allowedActions("running")).toMatchObject({
      pause: true,
      resume: false,
      addLeads: false,
    });
    expect(allowedActions("paused")).toMatchObject({ resume: true, pause: false });
    for (const s of ["completed", "cancelled", "stopped"] as const) {
      const a = allowedActions(s);
      expect(
        Object.values(a).every((v) => v === false),
        s,
      ).toBe(true);
    }
  });

  it("gönderimdeki dizi çıkarılamaz; ilerleme hariç tutulanları paydaya katmaz", () => {
    expect(REMOVABLE_SEQUENCES.has("in_flight")).toBe(false);
    expect(REMOVABLE_SEQUENCES.has("scheduled")).toBe(true);
    expect(progressOf({ scheduled: 3, completed: 1, excluded: 5, in_flight: 1 })).toEqual({
      total: 5,
      active: 4,
      finished: 1,
      excluded: 5,
      inFlight: 1,
      pct: 20,
    });
    expect(progressOf({}).pct).toBe(0);
  });

  it("pencere seçenekleri yalnızca hafta içi 09.00–17.00 içinde", () => {
    expect(WINDOW_TIMES[0]).toBe("09:00");
    expect(WINDOW_TIMES.at(-1)).toBe("17:00");
    expect(isValidWindow({ days: [1, 3], start: "10:00", end: "12:30" })).toBe(true);
    expect(isValidWindow({ days: [6], start: "10:00", end: "12:00" })).toBe(false);
    expect(isValidWindow({ days: [1], start: "08:30", end: "12:00" })).toBe(false);
    expect(isValidWindow({ days: [1], start: "12:00", end: "12:00" })).toBe(false);
    expect(isValidWindow({ days: [], start: "09:00", end: "17:00" })).toBe(false);
  });

  it("duraklatma nedenleri ve kodlar okunur metne çevrilir; bilinmeyen kod olduğu gibi kalır", () => {
    expect(pauseReasonText("user")).toBe(tr["campaign.pause.byUser"]);
    expect(pauseReasonText("auto:consent_missing")).toContain(tr["reason.consent_missing"]);
    expect(pauseReasonText(null)).toBeNull();
    expect(reasonLabel("suppressed")).toBe(tr["reason.suppressed"]);
    expect(reasonLabel("weird_provider_code")).toBe("weird_provider_code");
  });
});

describe("yeniden deneme politikası", () => {
  const busy = new ApiError("meşgul", 503, "DB_BUSY");
  it("GET: yalnızca DB_BUSY için en fazla 3 kez, artan beklemeyle", () => {
    expect(shouldRetryQuery(0, busy)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, busy)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, busy)).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("x", 500))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("x", 409, "CONFLICT"))).toBe(false);
    expect(shouldRetryQuery(0, new TypeError("network"))).toBe(false);
    expect([0, 1, 2, 5].map(queryRetryDelay)).toEqual([500, 1000, 2000, 4000]);
  });

  it("değişiklik: 503 ve ağ hatası belirsizdir; önce durum yenilenir, otomatik tekrar yok", () => {
    expect(classifyMutationError(busy)).toMatchObject({ kind: "uncertain", refresh: true });
    expect(classifyMutationError(new TypeError("Failed to fetch"))).toMatchObject({
      kind: "uncertain",
      refresh: true,
    });
    expect(classifyMutationError(new ApiError("x", 409, "CONFLICT"))).toMatchObject({
      kind: "conflict",
      refresh: true,
    });
    expect(classifyMutationError(new ApiError("x", 409, "PREFLIGHT_STALE")).kind).toBe("stale");
    expect(classifyMutationError(new ApiError("x", 409, "SCHEDULER_DISABLED")).kind).toBe(
      "blocked",
    );
    expect(
      classifyMutationError(
        new ApiError("x", 400, undefined, { issues: [{ path: "name", message: "boş" }] }),
      ),
    ).toMatchObject({ kind: "validation", refresh: false, issues: [{ path: "name" }] });
  });

  it("kampanya mutasyonları kaynak kodda otomatik yeniden denemeyi kapatır", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "features", "campaigns", "use-safe-mutation.ts"),
      "utf8",
    );
    expect(src).toMatch(/retry:\s*false/);
    // Bileşenler değişiklik isteklerini yalnızca bu sarmalayıcıyla yapar.
    const dir = path.resolve(__dirname, "..", "src", "features", "campaigns");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
      const code = fs.readFileSync(path.join(dir, f), "utf8");
      expect(code, f).not.toMatch(/\buseMutation\(/);
    }
  });
});

describe("önizleme yalıtımı", () => {
  it("çerçeve boş sandbox ile ve dış kaynakları engelleyen politikayla gösterilir", () => {
    expect(PREVIEW_SANDBOX).toBe("");
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).not.toMatch(/script-src/);
    const doc = previewDocument("<p>Merhaba</p>");
    expect(doc).toContain(PREVIEW_CSP);
    expect(doc).toContain("<p>Merhaba</p>");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "features", "campaigns", "email-preview.tsx"),
      "utf8",
    );
    expect(src).toMatch(/sandbox=\{PREVIEW_SANDBOX\}/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("kampanya arayüzü yeniden gönderim, tam adres veya Google verisi kullanmaz", () => {
    const dir = path.resolve(__dirname, "..", "src", "features", "campaigns");
    for (const f of fs.readdirSync(dir)) {
      const code = fs.readFileSync(path.join(dir, f), "utf8");
      expect(code, f).not.toMatch(
        /\bresend\b|recipientEmail|toAddress|placeCache|googleapis|@\/lib\/places|dangerouslySetInnerHTML/,
      );
    }
  });
});

describe("i18n eksiksizliği", () => {
  const has = (k: string) => k in tr;
  it("durum aileleri tam", () => {
    const missing = [
      ...CAMPAIGN_STATUSES.map((s) => `campaignStatus.${s}`),
      ...SEQUENCE_STATUSES.map((s) => `sequenceStatus.${s}`),
      ...["queued", "sending", "sent", "failed", "unknown"].map((s) => `messageStatus.${s}`),
      ...["basics", "steps", "leads", "review"].map((s) => `wizard.step.${s}`),
      ...[1, 2, 3, 4, 5].map((d) => `weekday.${d}`),
    ].filter((k) => !has(k));
    expect(missing).toEqual([]);
  });

  it("her uygunluk, engel ve gönderilemezlik kodunun Türkçe karşılığı var", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    const union = (src: string, name: string) => {
      const block = src.slice(src.indexOf(`export type ${name} =`));
      return [...block.slice(0, block.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    };
    const ineligible = union(read("src/lib/compliance/eligibility.ts"), "IneligibleCode");
    const notSendable = union(read("src/lib/mail/send-service.ts"), "NotSendableCode");
    const blockers = union(read("src/lib/campaigns/preflight.ts"), "BlockerCode");
    expect(ineligible.length).toBeGreaterThan(35);
    expect(blockers.length).toBeGreaterThan(5);
    const missing = [
      ...ineligible.map((c) => `reason.${c}`),
      ...notSendable.map((c) => `reason.${c}`),
      ...blockers.map((c) => `blocker.${c}`),
    ].filter((k) => !has(k));
    expect(missing).toEqual([]);
  });
});

/* Gönderim günlüğü API'si ve zamanlayıcı açıkken yalnızca demo sağlayıcı -------------------------- */

const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

async function sentCampaign() {
  const [tpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.language, "en"), eq(templates.kind, "initial")));
  const c = await createCampaign(db, { name: "UI", mailboxId: DEMO_MAILBOX }, { now: T0 });
  await setCampaignSteps(
    db,
    c.id,
    [{ stepIndex: 0, language: "en", templateId: tpl!.id, delayDays: 0 }],
    { expectedUpdatedAt: c.updatedAt, now: T0 },
  );
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  await db.insert(leadEmails).values({
    leadId: l!.id,
    email: "info@ui-shop.example",
    domain: "ui-shop.example",
    kind: "generic",
    sourceType: "mailto",
    verifyStatus: "verified",
    isPrimary: true,
    foundAt: T0,
    updatedAt: T0,
  });
  await addLeadsToCampaign(db, c.id, [l!.id], { now: T0 });
  const env = { [SCHEDULER_FLAG]: "1" };
  await transitionCampaign(db, c.id, "ready", { now: T0, env });
  const pf = await runPreflight(db, c.id, { now: T0, env });
  await transitionCampaign(db, c.id, "start", { now: T0, env, confirmToken: pf.confirmToken });
  return c.id;
}

describe("gönderim günlüğü ve demo sağlayıcı", () => {
  beforeEach(async () => {
    ({ client, db } = await openMemoryDb());
    await seedBase(db);
    (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HANDLE];
    client.close();
  });

  it("zamanlayıcı açıkken worker işleyicisi yalnızca demo sağlayıcıyla gönderir; günlük maskelidir", async () => {
    const id = await sentCampaign();
    // Sağlayıcı verilmez: işleyici, worker'daki gibi posta kutusuna göre seçer (yalnızca demo).
    const demo = getProvider({ provider: "demo" }) as FakeMailProvider;
    const before = demo.outbox.length;
    const logs: string[] = [];
    const handler = createMailSendHandler({
      enabled: true,
      dispatcher: new MailDispatcher(db),
      now: () => T0,
    });
    await handler({
      job: { id: 1 } as never,
      payload: {},
      db,
      shouldStop: () => false,
      log: (m) => logs.push(m),
    });
    expect(logs.join(" | ")).toContain(": sent");
    expect(demo).toBeInstanceOf(FakeMailProvider);
    expect(demo.outbox.length).toBe(before + 1);
    expect(demo.outbox.at(-1)!.from).toMatch(/\.invalid$/);
    for (const provider of ["gmail", "smtp", "DEMO", "live"]) {
      expect(() => getProvider({ provider }), provider).toThrow();
    }

    const r = await messagesRoute.GET(
      new Request(`http://127.0.0.1:3000/api/campaigns/${id}/messages`),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      status: "sent",
      stepIndex: 0,
      peerDomain: "ui-shop.example",
    });
    expect(body.items[0]!.recipientMasked).toBe("i***@ui-shop.example");
    expect(JSON.stringify(body)).not.toMatch(/info@ui-shop|bodyHtml|raw|MIME|toAddress/);
  });

  it("gerçek posta kutulu kampanya zamanlayıcı açıkken de hiç gönderilmez", async () => {
    const [mb] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    // Doğrudan veritabanına "çalışan" canlı kampanya (API buna izin vermez; savunma derinliği denetimi).
    await client.execute(
      `INSERT INTO campaigns (name, status, mailbox_id, selection, send_window, start_confirmed_at, created_at, updated_at)
       VALUES ('Canlı', 'running', ${mb!.id}, '{}', '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}', ${T0}, ${T0}, ${T0})`,
    );
    const demo = getProvider({ provider: "demo" }) as FakeMailProvider;
    const before = demo.outbox.length;
    const handler = createMailSendHandler({
      enabled: true,
      dispatcher: new MailDispatcher(db),
      now: () => T0,
    });
    await handler({
      job: { id: 2 } as never,
      payload: {},
      db,
      shouldStop: () => false,
      log: () => {},
    });
    expect(demo.outbox.length).toBe(before);
    const nf = await messagesRoute.GET(
      new Request("http://127.0.0.1:3000/api/campaigns/99/messages"),
      {
        params: Promise.resolve({ id: "99" }),
      },
    );
    expect(nf.status).toBe(404);
  });
});
