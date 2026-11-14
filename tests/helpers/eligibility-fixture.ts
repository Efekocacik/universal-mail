import { eq } from "drizzle-orm";
import { hashEmail, suppressDomain, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, leadEmails, leads, messages } from "@/lib/db/schema";
import { createCampaign, DEMO_MAILBOX, T0 } from "./campaign-fixture";

/**
 * Uygunluk kurallarının toplu (batch) ve tek tek değerlendirmesini karşılaştırmak için zengin fikstür: ~50 lead,
 * ortak alan adları ve alt alan adları, başka kampanyada süren diziler, adres ve işletme geçmişi, engeller, ülke
 * politikaları ve hedef kampanyada `pending`/`excluded`/kapanmış diziler. Bütün adresler `.example` alan adındadır.
 */

const DAY = 86_400_000;
const LOCALS = ["info", "sales", "contact", "hello", "office", "support", "team", "enquiries"];

export interface EligibilityFixture {
  /** Hedef kampanya (taslak). */
  campaignId: number;
  /** Başka (çalışan) kampanya. */
  otherId: number;
  leadIds: number[];
  /** Hedef kampanyadaki `pending` dizilerin kimlikleri (kimlik sırasıyla). */
  pendingIds: number[];
  /** Hedef kampanyada henüz bulunmayan lead'ler (eklemede kullanılır). */
  notEnrolled: number[];
}

let msgSeq = 0;

async function lead(
  db: Db,
  o: {
    email: string | null;
    country?: string | null;
    status?: "new" | "enriched" | "do_not_contact";
    source?: "demo" | "google";
    verify?: "verified" | "unverified";
    kind?: "generic" | "personal";
  },
): Promise<number> {
  const [l] = await db
    .insert(leads)
    .values({
      source: o.source ?? "demo",
      status: o.status ?? "enriched",
      countryCode: o.country === undefined ? "GB" : o.country,
      city: "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  if (o.email) {
    await db.insert(leadEmails).values({
      leadId: l!.id,
      email: o.email,
      domain: o.email.split("@")[1]!,
      kind: o.kind ?? "generic",
      sourceType: "mailto",
      verifyStatus: o.verify ?? "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    });
  }
  return l!.id;
}

async function sequence(
  db: Db,
  campaignId: number,
  leadId: number,
  email: string | null,
  status: "pending" | "scheduled" | "completed" | "excluded" | "cancelled" | "waiting_next",
): Promise<number> {
  const [e] = email
    ? await db.select().from(leadEmails).where(eq(leadEmails.leadId, leadId)).limit(1)
    : [];
  const [r] = await db
    .insert(campaignLeads)
    .values({
      campaignId,
      leadId,
      emailId: e?.email === email ? e.id : null,
      recipientEmail: email,
      recipientHash: email ? hashEmail(email) : null,
      recipientDomain: email ? email.split("@")[1]! : null,
      countryCode: "GB",
      language: "en",
      status,
      exclusionReasons: status === "excluded" ? ["domain_already_in_campaign"] : [],
      addedAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaignLeads.id });
  return r!.id;
}

async function sent(
  db: Db,
  campaignId: number,
  cl: number,
  leadId: number,
  email: string,
  at: number,
  status: "sent" | "unknown" = "sent",
) {
  const day = new Date(at + ++msgSeq * DAY).toISOString().slice(0, 10); // alan adı/gün tekilliği
  await db.insert(messages).values({
    direction: "out",
    purpose: "campaign",
    campaignId,
    campaignLeadId: cl,
    leadId,
    mailboxId: DEMO_MAILBOX,
    stepIndex: 0,
    idempotencyKey: `cl:${cl}:s:0:${msgSeq}`,
    rfcMessageId: `<fx${msgSeq}@universal-mail.invalid>`,
    fromAddress: "demo@universal-mail.invalid",
    toAddress: email,
    peerHash: hashEmail(email),
    peerDomain: email.split("@")[1]!,
    sendDay: day,
    subjectLogged: "Merhaba",
    bodySha256: "x".repeat(64),
    status,
    createdAt: at,
    sentAt: status === "sent" ? at : null,
  });
}

/** `now` = T0 + 1 gün civarında değerlendirilmek üzere kurulur. */
export async function buildEligibilityFixture(db: Db): Promise<EligibilityFixture> {
  msgSeq = 0;
  const campaignId = await createCampaign(db, { steps: 2 });
  await db.update(campaigns).set({ status: "draft" }).where(eq(campaigns.id, campaignId));
  const otherId = await createCampaign(db, { steps: 2 });

  const leadIds: number[] = [];
  const emails: Array<string | null> = [];
  for (let i = 0; i < 50; i++) {
    const biz = i < 40 ? i % 20 : i; // son 10 lead kendi işletmesinde (eklemede uygun çıkabilsin)
    const domain = i % 5 === 3 ? `shop.biz${biz}.example` : `biz${biz}.example`;
    let email: string | null = `${LOCALS[i % LOCALS.length]}@${domain}`;
    const o: Parameters<typeof lead>[1] = { email };
    if (i === 7) o.email = email = null; // birincil adres yok
    if (i === 11) o.email = email = "someone@gmail.com"; // kişisel sağlayıcı
    if (i === 13) o.verify = "unverified";
    if (i === 17) o.kind = "personal";
    if (i === 19) o.status = "do_not_contact";
    if (i === 23) o.source = "google"; // demo kutusu, demo olmayan lead
    if (i === 29) o.country = "DE"; // demo politikası: engelli
    if (i === 31) o.country = "ES"; // yalnızca genel adres
    if (i === 37) o.country = null;
    if (i === 41) o.email = email = "info@biz0.example"; // aynı adres başka lead'de
    leadIds.push(await lead(db, o));
    emails.push(email);
  }

  // Engeller: tek adres ve bir işletme alan adı (alt alan adları dahil).
  await suppressEmail(db, { email: emails[5]!, reason: "unsubscribe", source: "manual" }, T0);
  await suppressDomain(db, { domain: "biz9.example", reason: "manual", source: "manual" }, T0);

  // Başka kampanyada süren diziler: aynı adres, aynı lead (başka adres) ve aynı işletme alan adı.
  await sequence(db, otherId, leadIds[2]!, emails[2]!, "scheduled");
  await sequence(db, otherId, leadIds[4]!, "owner@baska-ornek.example", "waiting_next");
  await sequence(
    db,
    otherId,
    (await lead(db, { email: "x@biz10.example" }))!,
    "x@biz10.example",
    "scheduled",
  );

  // Geçmiş: adrese ve işletmeye başka kampanyada temas (bitmiş ve belirsiz).
  const histLead = leadIds[6]!;
  const h1 = await sequence(db, otherId, histLead, emails[6]!, "completed");
  await sent(db, otherId, h1, histLead, emails[6]!, T0 - 10 * DAY);
  const bizLead = await lead(db, { email: "accounts@biz8.example" });
  const h2 = await sequence(db, otherId, bizLead, "accounts@biz8.example", "completed");
  await sent(db, otherId, h2, bizLead, "accounts@biz8.example", T0 - 20 * DAY);
  const unkLead = await lead(db, { email: "billing@biz1.example" });
  const h3 = await sequence(db, otherId, unkLead, "billing@biz1.example", "waiting_next");
  await sent(db, otherId, h3, unkLead, "billing@biz1.example", T0 - 2 * DAY, "unknown");

  // Hedef kampanya: ilk 30 lead'in çoğu `pending` (aynı alan adlı kardeşler dahil), bazıları `excluded`; ayrıca
  // bu kampanyada işletmeye ileti gitmiş, sonra iptal edilmiş bir dizi.
  const pendingIds: number[] = [];
  const enrolled = new Set<number>();
  for (let i = 0; i < 30; i++) {
    if (i % 9 === 8) {
      await sequence(db, campaignId, leadIds[i]!, emails[i] ?? null, "excluded");
    } else {
      pendingIds.push(await sequence(db, campaignId, leadIds[i]!, emails[i] ?? null, "pending"));
    }
    enrolled.add(leadIds[i]!);
  }
  // Yeniden denetimde uygun çıkacak (artık engeli kalmamış) hariç tutulmuş dizi.
  const solo = await lead(db, { email: "info@solo-ornek.example" });
  await sequence(db, campaignId, solo, "info@solo-ornek.example", "excluded");
  const closedLead = await lead(db, { email: "press@biz11.example" });
  const closed = await sequence(db, campaignId, closedLead, "press@biz11.example", "cancelled");
  await sent(db, campaignId, closed, closedLead, "press@biz11.example", T0 - 3 * DAY);

  return {
    campaignId,
    otherId,
    leadIds,
    pendingIds,
    notEnrolled: leadIds.filter((id) => !enrolled.has(id)),
  };
}
