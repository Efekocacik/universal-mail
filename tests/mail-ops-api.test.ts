import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as auditExport from "@/app/api/audit/export/route";
import * as auditRoute from "@/app/api/audit/route";
import * as autoStopRoute from "@/app/api/compliance/auto-stop/route";
import * as devInbox from "@/app/api/dev/inbox/route";
import * as reviewIdRoute from "@/app/api/inbox/review/[id]/route";
import * as reviewRoute from "@/app/api/inbox/review/route";
import * as mailLogExport from "@/app/api/mail-log/export/route";
import * as mailLogRoute from "@/app/api/mail-log/route";
import * as dnsRoute from "@/app/api/mailboxes/[id]/dns-check/route";
import * as testSendRoute from "@/app/api/mailboxes/[id]/test-send/route";
import * as unsubRoute from "@/app/api/unsubscribe/[token]/route";
import type { Db } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  messages,
  settings,
  suppressions,
  templates,
} from "@/lib/db/schema";
import { resetUnsubscribeRateLimitForTests } from "@/lib/mail/unsubscribe-service";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { seedSent } from "./helpers/inbound-fixture";

/** Gönderim operasyonları API'si (Aşama 13): bayrak kapıları, katı şemalar, gizlilik, gevşetme reddi. */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let campaignId: number;

beforeEach(async () => {
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  resetUnsubscribeRateLimitForTests();
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  delete process.env.UM_MASTER_KEY;
  delete process.env.FAZ3_DEMO_INBOX_ENABLED;
  client.close();
});

type Json = Record<string, unknown>;
const req = (
  method: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body:
      payload === undefined
        ? undefined
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload),
  });
const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json; text: string }> {
  const r = await res;
  const text = await r.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    /* CSV */
  }
  return { status: r.status, body, text };
}

describe("otomatik durdurma eşikleri API", () => {
  const get = () => call(autoStopRoute.GET(req("GET", "/api/compliance/auto-stop"), undefined));
  const patch = (p: unknown) =>
    call(autoStopRoute.PATCH(req("PATCH", "/api/compliance/auto-stop", p), undefined));

  it("varsayılanlar, alt sınırlar ve sıkılaştırma", async () => {
    const g = await get();
    expect(g.body).toMatchObject({
      config: { minRecipients: 20, minBounces: 2, minRateBp: 500 },
      floors: { minRecipients: 10, minBounces: 2, minRateBp: 100 },
    });
    const ok = await patch({ minRecipients: 15, minRateBp: 300 });
    expect(ok.status).toBe(200);
    expect(ok.body.config).toEqual({ minRecipients: 15, minBounces: 2, minRateBp: 300 });
  });

  it("gevşetme 409, alt sınır altı 400; kapsam alanı ve bilinmeyen alan reddedilir", async () => {
    expect((await patch({ minRecipients: 30 })).body).toMatchObject({
      code: "LOOSENING_FORBIDDEN",
    });
    expect((await patch({ minRecipients: 30 })).status).toBe(409);
    expect((await patch({ minBounces: 1 })).status).toBe(400);
    expect((await patch({ minRateBp: 50 })).status).toBe(400);
    expect((await patch({ scope: "live", minRecipients: 12 })).status).toBe(400); // .strict(): kapsam istemciden gelmez
    expect((await patch({ bogus: 1 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await get()).body.config).toMatchObject({ minRecipients: 20, minRateBp: 500 });
  });

  it("kullanım onayı yoksa yazılamaz", async () => {
    await db.delete(settings).where(eq(settings.key, "consent"));
    expect((await patch({ minRecipients: 15 })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("demo gelen kutusu simülatörü: bayrak kapısı", () => {
  const sim = (p: unknown) => call(devInbox.POST(req("POST", "/api/dev/inbox", p), undefined));

  it("bayrak kapalıyken (varsayılan) 404 döner ve hiçbir şey yazmaz", async () => {
    const s = await seedSent(db, campaignId);
    const before = (await db.select().from(messages)).length;
    const r = await sim({ campaignLeadId: s.cl, scenario: "hard_bounce" });
    expect(r.status).toBe(404);
    expect((await db.select().from(messages)).length).toBe(before);
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("bayrak açıkken: tasdikli bounce etki üretir, tasdiksiz üretmez; sunucu kapsamı yalnızca demo", async () => {
    process.env.FAZ3_DEMO_INBOX_ENABLED = "1";
    const a = await seedSent(db, campaignId);
    const b = await seedSent(db, campaignId);
    const bad = await sim({ campaignLeadId: b.cl, scenario: "hard_bounce_unattested" });
    expect(bad.body).toMatchObject({
      outcome: "processed",
      status: "received",
      reviewReason: "no_attestation",
    });
    expect(await db.select().from(suppressions)).toHaveLength(0);
    const good = await sim({ campaignLeadId: a.cl, scenario: "hard_bounce" });
    expect(good.body).toMatchObject({
      outcome: "processed",
      status: "matched",
      effects: { suppressed: true },
    });
    expect(await db.select().from(suppressions)).toHaveLength(1);
    // Katı şema: bilinmeyen senaryo / alan reddedilir.
    expect((await sim({ campaignLeadId: a.cl, scenario: "rm_rf" })).status).toBe(400);
    expect(
      (await sim({ campaignLeadId: a.cl, scenario: "reply", attestation: "pass" })).status,
    ).toBe(400);
  });

  it("gönderilmiş iletisi olmayan alıcı için 409", async () => {
    process.env.FAZ3_DEMO_INBOX_ENABLED = "1";
    const s = await seedSent(db, campaignId, { status: "queued" });
    expect((await sim({ campaignLeadId: s.cl, scenario: "reply" })).status).toBe(409);
  });
});

describe("inceleme kuyruğu API", () => {
  it("liste adres/gövde içermez; 'ignore' ve 'apply' kararları çalışır", async () => {
    process.env.FAZ3_DEMO_INBOX_ENABLED = "1";
    const s = await seedSent(db, campaignId);
    const sim = await call(
      devInbox.POST(
        req("POST", "/api/dev/inbox", { campaignLeadId: s.cl, scenario: "negative" }),
        undefined,
      ),
    );
    const id = sim.body.inboundId as number;
    const list = await call(reviewRoute.GET(req("GET", "/api/inbox/review"), undefined));
    expect(list.text).not.toContain(s.email);
    expect(list.body.items).toHaveLength(1);
    expect((list.body.items as Json[])[0]).toMatchObject({
      classification: "negative",
      applicable: true,
      reason: "negative_needs_review",
    });
    expect(
      (
        await call(
          reviewIdRoute.POST(req("POST", `/api/inbox/review/${id}`, { decision: "x" }), idCtx(id)),
        )
      ).status,
    ).toBe(400);
    const done = await call(
      reviewIdRoute.POST(req("POST", `/api/inbox/review/${id}`, { decision: "apply" }), idCtx(id)),
    );
    expect(done.body).toEqual({ status: "matched", suppressed: true });
    expect(
      (
        await call(
          reviewIdRoute.POST(
            req("POST", `/api/inbox/review/${id}`, { decision: "ignore" }),
            idCtx(id),
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          reviewIdRoute.POST(
            req("POST", "/api/inbox/review/9999", { decision: "ignore" }),
            idCtx(9999),
          ),
        )
      ).status,
    ).toBe(404);
  });
});

describe("günlük ve işlem günlüğü uçları", () => {
  it("bilinmeyen sorgu parametresi (ör. tam adres isteği) reddedilir; CSV maskeli", async () => {
    const s = await seedSent(db, campaignId);
    for (const q of ["?full=1", "?fullAddress=true", "?includeAddresses=1", "?bogus=1"]) {
      expect(
        (await call(mailLogExport.GET(req("GET", `/api/mail-log/export${q}`), undefined))).status,
      ).toBe(400);
      expect(
        (await call(mailLogRoute.GET(req("GET", `/api/mail-log${q}`), undefined))).status,
      ).toBe(400);
    }
    const csv = await call(mailLogExport.GET(req("GET", "/api/mail-log/export"), undefined));
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain(s.email);
    expect(csv.text).toContain("i***@");
    const list = await call(
      mailLogRoute.GET(req("GET", "/api/mail-log?direction=out&limit=5"), undefined),
    );
    expect(list.text).not.toContain(s.email);
    expect(
      (await call(mailLogRoute.GET(req("GET", "/api/mail-log?limit=9999"), undefined))).status,
    ).toBe(400);
    expect(
      (await call(mailLogRoute.GET(req("GET", "/api/mail-log?direction=sideways"), undefined)))
        .status,
    ).toBe(400);
  });

  it("dışa aktarma işlem günlüğüne yazılır ve işlem günlüğü uçları ham ayrıntı sızdırmaz", async () => {
    await call(mailLogExport.GET(req("GET", "/api/mail-log/export"), undefined));
    const a = await call(auditRoute.GET(req("GET", "/api/audit?prefix=export."), undefined));
    expect((a.body.items as Json[]).map((i) => i.action)).toContain("export.mail_log");
    const csv = await call(auditExport.GET(req("GET", "/api/audit/export"), undefined));
    expect(csv.status).toBe(200);
    expect(csv.text.split("\r\n")[0]).toContain("islem");
    expect((await call(auditRoute.GET(req("GET", "/api/audit?x=1"), undefined))).status).toBe(400);
    expect(
      (await call(auditExport.GET(req("GET", "/api/audit/export?limit=5"), undefined))).status,
    ).toBe(400);
  });
});

describe("kendime test gönder ve DNS uçları", () => {
  it("test gönderimi: yabancı alan reddedilir; sahte sağlayıcı olmadan demo sağlayıcı kullanılır", async () => {
    const s = await seedSent(db, campaignId);
    const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
    const url = `/api/mailboxes/${DEMO_MAILBOX}/test-send`;
    expect(
      (
        await call(
          testSendRoute.POST(
            req("POST", url, { templateId: tpl!.id, leadId: s.leadId, to: "x@y.example" }),
            idCtx(DEMO_MAILBOX),
          ),
        )
      ).status,
    ).toBe(400); // alıcı girilemez
    const ok = await call(
      testSendRoute.POST(
        req("POST", url, { templateId: tpl!.id, leadId: s.leadId }),
        idCtx(DEMO_MAILBOX),
      ),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("sent");
    expect(
      (
        await call(
          testSendRoute.POST(
            req("POST", "/api/mailboxes/999/test-send", { templateId: tpl!.id, leadId: s.leadId }),
            idCtx(999),
          ),
        )
      ).status,
    ).toBe(404);
  });

  it("DNS: demo kutusunda 'Kontrol et' dense bile hiçbir DNS/ağ isteği çıkmaz", async () => {
    const spy = vi.spyOn(dnsPromises.Resolver.prototype, "resolveTxt");
    const legacy = vi.spyOn(dns, "resolveTxt");
    try {
      const url = `/api/mailboxes/${DEMO_MAILBOX}/dns-check`;
      for (const payload of [{}, { selector: "google" }]) {
        const r = await call(dnsRoute.POST(req("POST", url, payload), idCtx(DEMO_MAILBOX)));
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          mode: "demo",
          domain: null,
          spf: null,
          dkim: null,
          dmarc: null,
        });
      }
      // Alan adı istemciden alınmaz: gerçek bir alan adı göndermek de ağ isteği üretmez, doğrudan reddedilir.
      const withDomain = await call(
        dnsRoute.POST(req("POST", url, { domain: "gercek-firma.com" }), idCtx(DEMO_MAILBOX)),
      );
      expect(withDomain.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      legacy.mockRestore();
    }
  });

  it("DNS: geçersiz seçici ve bilinmeyen alan 400; olmayan kutu 404", async () => {
    const spy = vi.spyOn(dnsPromises.Resolver.prototype, "resolveTxt");
    try {
      const url = `/api/mailboxes/${DEMO_MAILBOX}/dns-check`;
      expect(
        (await call(dnsRoute.POST(req("POST", url, { selector: "../x" }), idCtx(DEMO_MAILBOX))))
          .status,
      ).toBe(400);
      expect(
        (await call(dnsRoute.POST(req("POST", url, { extra: 1 }), idCtx(DEMO_MAILBOX)))).status,
      ).toBe(400);
      expect(
        (await call(dnsRoute.POST(req("POST", "/api/mailboxes/999/dns-check", {}), idCtx(999))))
          .status,
      ).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("demo çıkış uç noktası", () => {
  const tokenCtx = (t: string) => ({ params: Promise.resolve({ token: t }) });
  async function token(clId: number): Promise<string> {
    process.env.FAZ3_DEMO_INBOX_ENABLED = "1";
    const r = await call(
      devInbox.POST(
        req("POST", "/api/dev/inbox", { campaignLeadId: clId, scenario: "unsubscribe_link" }),
        undefined,
      ),
    );
    return r.body.token as string;
  }

  it("GET yoktur (yalnızca POST işlem yapar); onaysız istek reddedilir", async () => {
    expect((unsubRoute as Record<string, unknown>).GET).toBeUndefined();
    const s = await seedSent(db, campaignId);
    const t = await token(s.cl);
    expect(
      (await call(unsubRoute.POST(req("POST", `/api/unsubscribe/${t}`, {}), tokenCtx(t)))).status,
    ).toBe(400);
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("onaylı POST (JSON) ve RFC 8058 biçimli form POST'u çıkışı işler; yineleme 'already'", async () => {
    const s = await seedSent(db, campaignId);
    const t = await token(s.cl);
    const r1 = await call(
      unsubRoute.POST(req("POST", `/api/unsubscribe/${t}`, { confirm: true }), tokenCtx(t)),
    );
    expect(r1.body).toEqual({ outcome: "unsubscribed" });
    const form = new Request(`${ORIGIN}/api/unsubscribe/${t}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: "List-Unsubscribe=One-Click",
    });
    expect((await call(unsubRoute.POST(form, tokenCtx(t)))).body).toEqual({ outcome: "already" });
    const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    expect(cl!.status).toBe("unsubscribed");
    expect(await db.select().from(suppressions)).toHaveLength(1);
  });

  it("sahte belirteç 404; hız sınırı 429", async () => {
    expect(
      (
        await call(
          unsubRoute.POST(
            req("POST", "/api/unsubscribe/v1.1.AAAAAAAAAAAAAAAAAAAAAA", { confirm: true }),
            tokenCtx("v1.1.AAAAAAAAAAAAAAAAAAAAAA"),
          ),
        )
      ).status,
    ).toBe(404);
    let last = 0;
    for (let i = 0; i < 62; i++)
      last = (
        await call(
          unsubRoute.POST(req("POST", "/api/unsubscribe/x", { confirm: true }), tokenCtx("x")),
        )
      ).status;
    expect(last).toBe(429);
  });

  it("kampanya iptal edilmiş olsa da kapsam demo olduğundan işlem tamamlanır; kampanya satırı değişmez", async () => {
    const s = await seedSent(db, campaignId);
    const t = await token(s.cl);
    await call(
      unsubRoute.POST(req("POST", `/api/unsubscribe/${t}`, { confirm: true }), tokenCtx(t)),
    );
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.status).toBe("running");
  });
});
