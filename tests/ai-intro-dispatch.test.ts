import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, leadIntros, leads, templates } from "@/lib/db/schema";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { INTRO_PENDING_DEFER_MS, MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * `{{kisisel_giris}}` yedeksiz kullanılırken giriş yalnızca onay bekleyen taslak olarak varsa dizi SONLANDIRILMAZ,
 * ertelenir; onaylanınca gönderim sürer. Hiç giriş yoksa (taslak da yok) eski davranış: lead'e özgü eksik değişken,
 * dizi sonlandırılır.
 */

let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  await db.update(templates).set({ bodyHtml: "<p>{{kisisel_giris}}</p><p>Hello {{sehir}}</p>" });
});
afterEach(() => client.close());

const seq = async (id: number) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, id)))[0]!;

async function addIntro(leadId: number, status: "draft" | "approved"): Promise<number> {
  const [r] = await db
    .insert(leadIntros)
    .values({
      leadId,
      language: "en",
      text: "We noticed your café in London and wanted to say hello.",
      status,
      model: "demo",
      createdAt: T0,
      updatedAt: T0,
      approvedAt: status === "approved" ? T0 : null,
    })
    .returning({ id: leadIntros.id });
  return r!.id;
}

describe("kişisel giriş onay bekliyor", () => {
  it("yalnızca taslak varken dizi ertelenir; onaylanınca ileti gönderilir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, leadId } = await addSequence(db, c);
    const introId = await addIntro(leadId, "draft");
    const p = new FakeMailProvider();

    const r1 = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(r1.deferred).toBe(1);
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      lastError: "intro_pending",
      nextSendAt: T0 + INTRO_PENDING_DEFER_MS,
      exclusionReasons: [],
    });
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, c));
    expect(camp!.status).toBe("running");

    await db
      .update(leadIntros)
      .set({ status: "approved", approvedAt: T0 + 1 })
      .where(eq(leadIntros.id, introId));
    const later = T0 + INTRO_PENDING_DEFER_MS + 1;
    await new MailDispatcher(db).dispatchOnce({ now: () => later, provider: p });
    expect(p.calls).toBe(1);
    expect((await seq(cl)).status).not.toBe("removed");
  });

  it("hiç giriş yoksa eksik lead değişkeni: dizi sonlandırılır (erteleme yok)", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    const p = new FakeMailProvider();
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({ status: "removed", nextSendAt: null });
    expect((await seq(cl)).exclusionReasons).toContain("missing_variables");
  });

  it("taslak var ama başka bir lead değişkeni de eksikse dizi yine sonlandırılır", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, leadId } = await addSequence(db, c);
    await addIntro(leadId, "draft");
    await db.update(leads).set({ city: null }).where(eq(leads.id, leadId));
    const p = new FakeMailProvider();
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect((await seq(cl)).status).toBe("removed");
  });
});
