import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as limitsRoute from "@/app/api/compliance/mailbox-limits/route";
import * as healthRoute from "@/app/api/mailboxes/[id]/health/route";
import * as reenableRoute from "@/app/api/mailboxes/[id]/health/reenable/route";
import type { Db } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { processInbound } from "@/lib/mail/inbound/process";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW, rawDsn, seedSent, SIMULATED_DSN_PASS } from "./helpers/inbound-fixture";

/** Posta kutusu sağlığı API'si (Aşama 14): salt okunur görünüm, sıkılaştırma, yeniden etkinleştirme korumaları. */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let campaignId: number;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

type Json = Record<string, unknown>;
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}
const health = () =>
  call(healthRoute.GET(req("GET", `/api/mailboxes/${DEMO_MAILBOX}/health`), ctx(DEMO_MAILBOX)));
const limits = (p: unknown) =>
  call(limitsRoute.PATCH(req("PATCH", "/api/compliance/mailbox-limits", p), undefined));
const reenable = (p: unknown) =>
  call(
    reenableRoute.POST(
      req("POST", `/api/mailboxes/${DEMO_MAILBOX}/health/reenable`, p),
      ctx(DEMO_MAILBOX),
    ),
  );

describe("görünüm", () => {
  it("varsayılan eşikler, yetersiz veri ve ölçülemeyen şikâyet", async () => {
    const r = await health();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      limits: { bounceBp: 300, minRecipients: 50, guardBounces: 3 },
      windowDays: 30,
      stats: { recipients: 0, bounced: 0 },
      evaluation: { state: "insufficient" },
      halted: null,
      complaint: { status: "not_measurable", thresholdBp: 10, manualRecords: 0 },
    });
    expect(
      (await call(healthRoute.GET(req("GET", "/api/mailboxes/999/health"), ctx(999)))).status,
    ).toBe(404);
  });
});

describe("eşik sıkılaştırma", () => {
  it("sıkılaştırma 200; gevşetme 409; alt sınır 400; kapsam alanı ve bilinmeyen alan 400", async () => {
    expect((await limits({ bounceBp: 200 })).body).toMatchObject({ limits: { bounceBp: 200 } });
    const loose = await limits({ bounceBp: 300 });
    expect(loose.status).toBe(409);
    expect(loose.body.code).toBe("LOOSENING_FORBIDDEN");
    expect((await limits({ minRecipients: 10 })).status).toBe(400);
    expect((await limits({ scope: "live", bounceBp: 150 })).status).toBe(400);
    expect((await limits({ bogus: 1 })).status).toBe(400);
    expect((await limits({})).status).toBe(400);
    const g = await call(limitsRoute.GET(req("GET", "/api/compliance/mailbox-limits"), undefined));
    expect(g.body).toMatchObject({
      limits: { bounceBp: 200, minRecipients: 50 },
      floors: { bounceBp: 100, minRecipients: 20, guardBounces: 2 },
    });
  });
  it("kullanım onayı yoksa yazılamaz", async () => {
    await db.delete(settings).where(eq(settings.key, "consent"));
    expect((await limits({ bounceBp: 200 })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("yeniden etkinleştirme", () => {
  async function halt() {
    const all = [];
    for (let i = 0; i < 10; i++) all.push(await seedSent(db, campaignId));
    for (const [i, s] of all.slice(0, 3).entries()) {
      await processInbound(
        db,
        {
          mailboxId: DEMO_MAILBOX,
          raw: rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: `h${i}` }),
          receivedAt: NOW,
          attestation: SIMULATED_DSN_PASS,
        },
        { now: NOW },
      );
    }
  }

  it("durdurulmamış kutu 409; onaysız 400; kısa gerekçe 400; oran hâlâ üstteyse 409 ve durdurma sürer", async () => {
    expect(
      (await reenable({ confirm: true, justification: "yeterince uzun gerekçe" })).body.code,
    ).toBe("NOT_HALTED");
    await halt();
    const h = await health();
    expect(h.body).toMatchObject({
      evaluation: { state: "exceeded", reason: "small_sample_guard" },
    });
    expect(h.body.halted).not.toBeNull();
    expect(
      (await reenable({ confirm: false, justification: "yeterince uzun gerekçe" })).status,
    ).toBe(400);
    expect((await reenable({ confirm: true, justification: "kısa" })).status).toBe(400);
    expect((await reenable({ confirm: true })).status).toBe(400);
    const still = await reenable({ confirm: true, justification: "yeterince uzun gerekçe" });
    expect(still.status).toBe(409);
    expect(still.body.code).toBe("STILL_EXCEEDED");
    expect((await health()).body.halted).not.toBeNull();
  });
});
