import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as controlRoute from "@/app/api/campaigns/[id]/control/route";
import * as leadRoute from "@/app/api/campaigns/[id]/leads/[clId]/route";
import * as leadsRoute from "@/app/api/campaigns/[id]/leads/route";
import * as preflightRoute from "@/app/api/campaigns/[id]/preflight/route";
import * as campaignRoute from "@/app/api/campaigns/[id]/route";
import * as stepsRoute from "@/app/api/campaigns/[id]/steps/route";
import * as reviewRoute from "@/app/api/campaigns/review/route";
import * as campaignsRoute from "@/app/api/campaigns/route";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import * as templatesRoute from "@/app/api/templates/route";
import type { Db } from "@/lib/db/client";
import { campaigns, leadEmails, leads, mailboxes, messages, templates } from "@/lib/db/schema";
import { SCHEDULER_FLAG } from "@/lib/mail/scheduler/job";
import { middleware } from "@/middleware";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Kampanya API'si: giriş doğrulama, hata biçimi, kurulum/onay kapısı, demo/live ayrımı ve güvenlik kurallarının API
 * üzerinden atlatılamaması. Bellek içi veritabanı, `getDb()`'nin kullandığı süreç tutamacına yerleştirilir; gerçek
 * `.data` açılmaz.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let initialTpl: number;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  const [en] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.language, "en"), eq(templates.kind, "initial")));
  initialTpl = en!.id;
  delete process.env[SCHEDULER_FLAG];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  delete process.env[SCHEDULER_FLAG];
  client.close();
});

type Json = Record<string, unknown>;

function req(method: string, url: string, payload?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body:
      payload === undefined
        ? undefined
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload),
  });
}
const ctx = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}

async function create(payload: Json = { name: "API", mailboxId: DEMO_MAILBOX }) {
  return call(campaignsRoute.POST(req("POST", "/api/campaigns", payload), undefined));
}

let seq = 0;
async function lead(country = "GB"): Promise<number> {
  const email = `info@api${++seq}.example`;
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: country,
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  await db.insert(leadEmails).values({
    leadId: l!.id,
    email,
    domain: email.split("@")[1]!,
    kind: "generic",
    sourceType: "mailto",
    verifyStatus: "verified",
    isPrimary: true,
    foundAt: T0,
    updatedAt: T0,
  });
  return l!.id;
}

/** Hazır kampanya: adım + lead + ready. */
async function readyViaApi(leadIds: number[]) {
  const c = await create();
  const id = String(c.body.id);
  const steps = await call(
    stepsRoute.PUT(
      req("PUT", `/api/campaigns/${id}/steps`, {
        expectedUpdatedAt: c.body.updatedAt,
        steps: [{ stepIndex: 0, language: "en", templateId: initialTpl, delayDays: 0 }],
      }),
      ctx({ id }),
    ),
  );
  expect(steps.status).toBe(200);
  const added = await call(
    leadsRoute.POST(req("POST", `/api/campaigns/${id}/leads`, { leadIds }), ctx({ id })),
  );
  expect(added.status).toBe(200);
  const ready = await call(
    controlRoute.POST(
      req("POST", `/api/campaigns/${id}/control`, { action: "ready" }),
      ctx({ id }),
    ),
  );
  expect(ready.status).toBe(200);
  return { id, added: added.body };
}

/** Hata yanıtı: yalnızca güvenli alanlar; yığın izi veya iç ayrıntı yok. */
function expectSafeError(body: Json) {
  expect(typeof body.error).toBe("string");
  expect(JSON.stringify(body)).not.toMatch(/\n\s+at |node_modules|SQLITE|Failed query|stack/i);
}

describe("kampanya API: oluşturma, doğrulama, hata biçimi", () => {
  it("taslak oluşturur (201); liste ve detay döner", async () => {
    const c = await create();
    expect(c.status).toBe(201);
    const list = await call(campaignsRoute.GET(req("GET", "/api/campaigns"), undefined));
    expect((list.body.items as Json[]).map((x) => x.id)).toEqual([c.body.id]);
    const d = await call(
      campaignRoute.GET(req("GET", `/api/campaigns/${c.body.id}`), ctx({ id: String(c.body.id) })),
    );
    expect(d.body).toMatchObject({ status: "draft", mailboxId: DEMO_MAILBOX });
  });

  it("bilinmeyen alanlar (durum enjeksiyonu dahil) ve geçersiz JSON reddedilir", async () => {
    for (const payload of [
      { name: "X", status: "running" },
      { name: "X", startConfirmedAt: T0 },
      { name: "X", dailyCap: 500 },
      { name: "X", minGapS: 10 },
      { name: "X", sendWindow: { days: [1], start: "9:00", end: "17:00" } },
      { name: "" },
    ]) {
      const r = await create(payload);
      expect(r.status, JSON.stringify(payload)).toBe(400);
      expectSafeError(r.body);
    }
    const bad = await call(
      campaignsRoute.POST(req("POST", "/api/campaigns", "{not json"), undefined),
    );
    expect(bad.status).toBe(400);
    const badStatus = await call(
      campaignsRoute.GET(req("GET", "/api/campaigns?status=hacked"), undefined),
    );
    expect(badStatus.status).toBe(400);
  });

  it("kullanım onayı yoksa değişiklik yapılamaz (403)", async () => {
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    const r = await create();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("SETUP_REQUIRED");
    expect(await db.select().from(campaigns)).toHaveLength(0);
  });

  it("bulunamayan ve geçersiz kimlikler; eski belirteçle düzenleme 409", async () => {
    const nf = await call(campaignRoute.GET(req("GET", "/api/campaigns/99"), ctx({ id: "99" })));
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe("NOT_FOUND");
    const bad = await call(campaignRoute.GET(req("GET", "/api/campaigns/abc"), ctx({ id: "abc" })));
    expect(bad.status).toBe(400);

    const c = await create();
    const id = String(c.body.id);
    const ok = await call(
      campaignRoute.PATCH(
        req("PATCH", `/api/campaigns/${id}`, { expectedUpdatedAt: c.body.updatedAt, name: "Yeni" }),
        ctx({ id }),
      ),
    );
    expect(ok.status).toBe(200);
    const stale = await call(
      campaignRoute.PATCH(
        req("PATCH", `/api/campaigns/${id}`, { expectedUpdatedAt: c.body.updatedAt, name: "Eski" }),
        ctx({ id }),
      ),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("CONFLICT");
    expectSafeError(stale.body);
    const injected = await call(
      campaignRoute.PATCH(
        req("PATCH", `/api/campaigns/${id}`, {
          expectedUpdatedAt: ok.body.updatedAt,
          status: "running",
        }),
        ctx({ id }),
      ),
    );
    expect(injected.status).toBe(400);
  });

  it("gerçek posta kutusu API üzerinden atanamaz", async () => {
    const [live] = await db
      .insert(mailboxes)
      .values({
        provider: "smtp",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.smtpPassword",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    const r = await create({ name: "Canlı", mailboxId: live!.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("LIVE_DISABLED");
  });
});

describe("kampanya API: lead, başlatma ve güvenlik kuralları", () => {
  it("engelli ülke ve tekrar ekleme API'de de atlatılamaz", async () => {
    const gb = await lead("GB");
    const de = await lead("DE");
    const { id, added } = await readyViaApi([gb, de]);
    expect(added).toMatchObject({ added: 1, duplicates: [] });
    expect((added.excluded as Json[])[0]).toMatchObject({ leadId: de });
    const again = await call(
      leadsRoute.POST(req("POST", `/api/campaigns/${id}/leads`, { leadIds: [gb] }), ctx({ id })),
    );
    expect(again.body).toMatchObject({ added: 0, duplicates: [gb] });
    const both = await call(
      leadsRoute.POST(
        req("POST", `/api/campaigns/${id}/leads`, { leadIds: [gb], filterQuery: "" }),
        ctx({ id }),
      ),
    );
    expect(both.status).toBe(400);
    const queue = await call(leadsRoute.GET(req("GET", `/api/campaigns/${id}/leads`), ctx({ id })));
    expect(queue.body.total).toBe(2);
    expect(JSON.stringify(queue.body)).not.toContain("info@api");
  });

  it("başlatma: belirteç zorunlu; bayrak kapalıyken 409; açıkken çalışır ve sonra düzenlenemez", async () => {
    const { id } = await readyViaApi([await lead()]);
    const pf = await call(
      preflightRoute.GET(req("GET", `/api/campaigns/${id}/preflight`), ctx({ id })),
    );
    expect(pf.status).toBe(200);
    expect(pf.body.blockers).toEqual(["scheduler_disabled"]);
    const token = pf.body.confirmToken as string;

    const off = await call(
      controlRoute.POST(
        req("POST", `/api/campaigns/${id}/control`, { action: "start", confirmToken: token }),
        ctx({ id }),
      ),
    );
    expect(off.status).toBe(409);
    expect(off.body.code).toBe("SCHEDULER_DISABLED");

    process.env[SCHEDULER_FLAG] = "1";
    const noToken = await call(
      controlRoute.POST(
        req("POST", `/api/campaigns/${id}/control`, { action: "start" }),
        ctx({ id }),
      ),
    );
    expect(noToken.status).toBe(409);
    expect(noToken.body.code).toBe("PREFLIGHT_STALE");
    const fresh = await call(
      preflightRoute.GET(req("GET", `/api/campaigns/${id}/preflight`), ctx({ id })),
    );
    const started = await call(
      controlRoute.POST(
        req("POST", `/api/campaigns/${id}/control`, {
          action: "start",
          confirmToken: fresh.body.confirmToken,
        }),
        ctx({ id }),
      ),
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ changed: true, status: "running" });

    const d = await call(campaignRoute.GET(req("GET", `/api/campaigns/${id}`), ctx({ id })));
    const edit = await call(
      campaignRoute.PATCH(
        req("PATCH", `/api/campaigns/${id}`, { expectedUpdatedAt: d.body.updatedAt, dailyCap: 80 }),
        ctx({ id }),
      ),
    );
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("NOT_EDITABLE");
    const bogus = await call(
      controlRoute.POST(
        req("POST", `/api/campaigns/${id}/control`, { action: "complete" }),
        ctx({ id }),
      ),
    );
    expect(bogus.status).toBe(400);
    // API hiçbir ileti göndermez; gönderim yalnızca worker'daki demo dağıtıcıdadır.
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("dizi çıkarma ve inceleme listesi", async () => {
    const { id } = await readyViaApi([await lead()]);
    const q = await call(leadsRoute.GET(req("GET", `/api/campaigns/${id}/leads`), ctx({ id })));
    const clId = String((q.body.items as Json[])[0]!.id);
    const del = await call(
      leadRoute.DELETE(req("DELETE", `/api/campaigns/${id}/leads/${clId}`), ctx({ id, clId })),
    );
    expect(del.status).toBe(200);
    const again = await call(
      leadRoute.DELETE(req("DELETE", `/api/campaigns/${id}/leads/${clId}`), ctx({ id, clId })),
    );
    expect(again.status).toBe(409);
    const review = await call(reviewRoute.GET(req("GET", "/api/campaigns/review"), undefined));
    expect(review.body).toEqual({ items: [] });
  });

  it("posta kutusu ve şablon listeleri gizli veya gövde alanı döndürmez", async () => {
    await db.insert(mailboxes).values({
      provider: "gmail",
      label: "Gerçek",
      address: "sales@firma-iletisim.com",
      credentialsRef: "mailbox.2.refreshToken",
      smtpHost: "smtp.example.com",
      status: "connected",
      lastError: "token expired",
      createdAt: T0,
      updatedAt: T0,
    });
    const mb = await call(mailboxesRoute.GET(req("GET", "/api/mailboxes"), undefined));
    const text = JSON.stringify(mb.body);
    expect(text).not.toMatch(/credentials|refreshToken|smtp\.example|token expired/i);
    const items = mb.body.items as Json[];
    expect(items.find((m) => m.provider === "demo")).toMatchObject({
      sendable: true,
      scope: "demo",
    });
    expect(items.find((m) => m.provider === "gmail")).toMatchObject({
      sendable: false,
      scope: "live",
    });
    const tpl = await call(templatesRoute.GET(req("GET", "/api/templates"), undefined));
    expect(JSON.stringify(tpl.body)).not.toMatch(/bodyHtml|bodyText|<p>/);
  });
});

describe("yerel erişim ve CSRF koruması yeni uçlarda da geçerli", () => {
  const mk = (method: string, headers: Record<string, string>) =>
    new NextRequest(`${ORIGIN}/api/campaigns/1/control`, { method, headers });
  it("Origin'siz veya yabancı kaynaklı durum değiştiren istek reddedilir", () => {
    const host = "127.0.0.1:3000";
    expect(middleware(mk("POST", { host })).status).toBe(403);
    expect(middleware(mk("POST", { host, origin: "http://evil.example.com" })).status).toBe(403);
    expect(middleware(mk("POST", { host: "evil.example.com", origin: ORIGIN })).status).toBe(403);
    expect(middleware(mk("POST", { host, origin: ORIGIN })).status).toBe(200);
  });
});
