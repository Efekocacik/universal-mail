import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  leadContacts,
  leadEmails,
  leadEnrichment,
  leads,
  type ContactType,
  type EmailKind,
  type EmailSourceType,
  type EnrichmentStatus,
  type VerifyStatus,
} from "@/lib/db/schema";
import { classifyKind, domainMatchesSite, parseEmail } from "./address";
import { computeEmailStatus, pickPrimary } from "./status";

export type LeadEmailRow = typeof leadEmails.$inferSelect;
export type LeadContactRow = typeof leadContacts.$inferSelect;
export type EnrichmentRow = typeof leadEnrichment.$inferSelect;

export interface NewEmail {
  email: string;
  sourceType: EmailSourceType;
  sourceUrl: string | null;
  verifyStatus: VerifyStatus;
  verifyReason: string | null;
  /** Taranan sitenin alan adı (alan adı eşleşmesi için). Elle eklenen adreslerde boştur → eşleşiyor sayılır. */
  siteHost?: string | null;
}

/**
 * Bulunan adresleri kaydeder. Aynı (lead, adres) yeniden bulunursa kayıt GÜNCELLENMEZ ama doğrulama sonucu
 * tazelenir; kullanıcının elle eklediği/sabitlediği kayıtlar korunur.
 */
export async function saveEmails(
  db: Db,
  leadId: number,
  found: NewEmail[],
  now: number,
): Promise<number> {
  let added = 0;
  for (const f of found) {
    const parsed = parseEmail(f.email);
    if (!parsed) continue;
    const kind: EmailKind = classifyKind(parsed);
    const siteMatch = f.siteHost ? domainMatchesSite(parsed.domain, f.siteHost) : true;
    const inserted = await db
      .insert(leadEmails)
      .values({
        leadId,
        email: parsed.email,
        domain: parsed.domain,
        kind,
        sourceUrl: f.sourceUrl,
        sourceType: f.sourceType,
        siteMatch,
        verifyStatus: f.verifyStatus,
        verifyReason: f.verifyReason,
        verifiedAt: now,
        foundAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [leadEmails.leadId, leadEmails.email],
        set: {
          verifyStatus: f.verifyStatus,
          verifyReason: f.verifyReason,
          verifiedAt: now,
          updatedAt: now,
        },
      })
      .returning({ foundAt: leadEmails.foundAt });
    if (inserted[0]?.foundAt === now) added++;
  }
  return added;
}

export async function saveContacts(
  db: Db,
  leadId: number,
  contacts: { type: ContactType; url: string }[],
  now: number,
): Promise<void> {
  for (const c of contacts)
    await db
      .insert(leadContacts)
      .values({ leadId, type: c.type, url: c.url, foundAt: now })
      .onConflictDoNothing();
}

/** Birincil adresi yeniden seçer ve lead'in e-posta durumunu günceller. Geri dönüş: yeni durum. */
export async function refreshLeadSummary(db: Db, leadId: number, now: number = Date.now()) {
  const emails = await db.select().from(leadEmails).where(eq(leadEmails.leadId, leadId));
  const primary = pickPrimary(emails);
  // Önce eski birincili kaldır (kısmi benzersiz dizin: lead başına tek birincil), sonra yenisini ata.
  await db
    .update(leadEmails)
    .set({ isPrimary: false })
    .where(
      and(
        eq(leadEmails.leadId, leadId),
        eq(leadEmails.isPrimary, true),
        primary ? ne(leadEmails.id, primary.id) : sql`1=1`,
      ),
    );
  if (primary && !primary.isPrimary)
    await db.update(leadEmails).set({ isPrimary: true }).where(eq(leadEmails.id, primary.id));

  const enrichment = (
    await db.select().from(leadEnrichment).where(eq(leadEnrichment.leadId, leadId))
  )[0];
  const scanned =
    !!enrichment && ["done", "no_website", "blocked", "failed"].includes(enrichment.status);
  const emailStatus = computeEmailStatus(emails, scanned && enrichment?.status === "done");
  if (enrichment) {
    await db
      .update(leadEnrichment)
      .set({ emailStatus, updatedAt: now })
      .where(eq(leadEnrichment.leadId, leadId));
  }
  return { emailStatus, primaryId: primary?.id ?? null, count: emails.length };
}

export async function upsertEnrichment(
  db: Db,
  leadId: number,
  patch: Partial<Omit<EnrichmentRow, "leadId" | "updatedAt">> & { status: EnrichmentStatus },
  now: number = Date.now(),
): Promise<void> {
  await db
    .insert(leadEnrichment)
    .values({ leadId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: leadEnrichment.leadId, set: { ...patch, updatedAt: now } });
}

export async function getEnrichmentMap(
  db: Db,
  leadIds: number[],
): Promise<Map<number, EnrichmentRow>> {
  const out = new Map<number, EnrichmentRow>();
  for (let i = 0; i < leadIds.length; i += 500) {
    const rows = await db
      .select()
      .from(leadEnrichment)
      .where(inArray(leadEnrichment.leadId, leadIds.slice(i, i + 500)));
    for (const r of rows) out.set(r.leadId, r);
  }
  return out;
}

export async function getLeadEmails(db: Db, leadId: number): Promise<LeadEmailRow[]> {
  return db
    .select()
    .from(leadEmails)
    .where(eq(leadEmails.leadId, leadId))
    .orderBy(asc(leadEmails.id));
}

export async function getLeadContacts(db: Db, leadId: number): Promise<LeadContactRow[]> {
  return db
    .select()
    .from(leadContacts)
    .where(eq(leadContacts.leadId, leadId))
    .orderBy(asc(leadContacts.id));
}

/** Aynı e-postayı (veya aynı işletme alan adını) paylaşan diğer lead'ler: yinelenen kayıt tespiti. */
export async function findDuplicates(db: Db, leadId: number, emails: LeadEmailRow[]) {
  const addresses = emails.filter((e) => e.verifyStatus !== "invalid").map((e) => e.email);
  const domains = [
    ...new Set(emails.filter((e) => e.kind !== "consumer" && e.siteMatch).map((e) => e.domain)),
  ];
  const out = new Map<
    number,
    { leadId: number; reason: "same_email" | "same_domain"; value: string }
  >();
  if (addresses.length > 0) {
    const rows = await db
      .select({ leadId: leadEmails.leadId, email: leadEmails.email })
      .from(leadEmails)
      .where(and(inArray(leadEmails.email, addresses), ne(leadEmails.leadId, leadId)));
    for (const r of rows)
      out.set(r.leadId, { leadId: r.leadId, reason: "same_email", value: r.email });
  }
  if (domains.length > 0) {
    const rows = await db
      .select({ leadId: leadEmails.leadId, domain: leadEmails.domain })
      .from(leadEmails)
      .where(
        and(
          inArray(leadEmails.domain, domains),
          ne(leadEmails.leadId, leadId),
          eq(leadEmails.siteMatch, true),
        ),
      );
    for (const r of rows)
      if (!out.has(r.leadId))
        out.set(r.leadId, { leadId: r.leadId, reason: "same_domain", value: r.domain });
  }
  const ids = [...out.keys()].slice(0, 20);
  if (ids.length === 0) return [];
  const names = await db
    .select({ id: leads.id, displayName: leads.displayName, city: leads.city })
    .from(leads)
    .where(inArray(leads.id, ids));
  const meta = new Map(names.map((n) => [n.id, n]));
  return ids.map((id) => ({
    ...out.get(id)!,
    displayName: meta.get(id)?.displayName ?? null,
    city: meta.get(id)?.city ?? null,
  }));
}
