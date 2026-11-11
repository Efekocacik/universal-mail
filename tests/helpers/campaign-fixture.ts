import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { seedCountryPolicies } from "@/lib/compliance/policies";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leadEmails,
  leads,
  templates,
  type SendWindow,
} from "@/lib/db/schema";
import { seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { setSetting } from "@/lib/settings";
import { eq } from "drizzle-orm";

/**
 * Zamanlayıcı testleri için ortak kampanya fikstürü. Gerçek `.data` veritabanına dokunmaz: bellek içi veya testin
 * verdiği geçici dosya kullanılır. Alıcılar `.example` alan adlarıdır; gerçek gönderim yoktur.
 */

export const MIGRATIONS = path.resolve(__dirname, "..", "..", "drizzle");
/** Pazartesi 2 Kasım 2026, 10:00 UTC (Londra 10:00). */
export const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
export const DEMO_MAILBOX = 1;
export const WEEKDAYS: SendWindow = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

export function wrap(client: Client): Db {
  return drizzle(client, { schema: { ...schema, ...cacheSchema } });
}

export async function openMemoryDb(): Promise<{ client: Client; db: Db }> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = wrap(client);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

/** Politika, şablon, demo posta kutusu, kullanım onayı ve gönderen profili (testlere özgü örnek veriler). */
export async function seedBase(db: Db, now = T0): Promise<void> {
  await seedCountryPolicies(db, now);
  await seedBuiltinTemplates(db, now);
  await seedDemoMailbox(db, now);
  await setSetting(db, "consent", { version: "t", acceptedAt: now, name: "Test Yetkilisi" });
  await setSetting(db, "company.profile", {
    legalName: "Örnek Dış Ticaret A.Ş.",
    address: "Örnek Mah. 1, İstanbul",
    taxId: "1234567890",
    phone: "+90 212 000 00 00",
    contactName: "Ayşe Yılmaz",
  });
}

export async function createCampaign(
  db: Db,
  o: {
    steps?: number;
    mailboxId?: number;
    dailyCap?: number;
    sendWindow?: SendWindow;
    status?: "running" | "paused";
  } = {},
): Promise<number> {
  const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
  const [c] = await db
    .insert(campaigns)
    .values({
      name: "Zamanlayıcı testi",
      status: o.status ?? "running",
      mailboxId: o.mailboxId ?? DEMO_MAILBOX,
      selection: {},
      sendWindow: o.sendWindow ?? WEEKDAYS,
      dailyCap: o.dailyCap ?? 20,
      startConfirmedAt: T0,
      startedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id });
  for (let i = 0; i < (o.steps ?? 3); i++) {
    await db.insert(campaignSteps).values({
      campaignId: c!.id,
      stepIndex: i,
      language: "en",
      templateId: tpl!.id,
      delayDays: i === 0 ? 0 : 5,
    });
  }
  return c!.id;
}

let seq = 0;

export async function addSequence(
  db: Db,
  campaignId: number,
  o: { country?: string; email?: string; nextSendAt?: number | null } = {},
): Promise<{ cl: number; leadId: number; email: string }> {
  const email = o.email ?? `info@lead${++seq}-${campaignId}.example`;
  const domain = email.split("@")[1]!;
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: o.country ?? "GB",
      city: "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  const [e] = await db
    .insert(leadEmails)
    .values({
      leadId: l!.id,
      email,
      domain,
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leadEmails.id });
  const [cl] = await db
    .insert(campaignLeads)
    .values({
      campaignId,
      leadId: l!.id,
      emailId: e!.id,
      recipientEmail: email,
      recipientHash: hashEmail(email),
      recipientDomain: domain,
      countryCode: o.country ?? "GB",
      language: "en",
      status: "scheduled",
      nextSendAt: o.nextSendAt ?? null,
      addedAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaignLeads.id });
  return { cl: cl!.id, leadId: l!.id, email };
}
