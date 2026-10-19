import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { leadEnrichment, leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseEmail } from "@/lib/email/address";
import { createEmailDeps } from "@/lib/email/deps";
import { getLeadEmails, refreshLeadSummary, saveEmails, upsertEnrichment } from "@/lib/email/store";
import { verifyEmail } from "@/lib/email/verify";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().min(3).max(254) });

/** E-posta adresini elle ekler (kaynak: "manual"). Sözdizimi ve DNS/MX doğrulaması yapılır; geçersizse de kaydedilir. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const leadId = intParam((await ctx.params).id);
  const { email } = await body(req, schema);
  const lead = (
    await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1)
  )[0];
  if (!lead) throw new HttpError(404, "Lead bulunamadı.");
  const parsed = parseEmail(email);
  if (!parsed) throw new HttpError(400, "Geçerli bir e-posta adresi girin.");
  const existing = await getLeadEmails(db, leadId);
  if (existing.some((e) => e.email === parsed.email))
    throw new HttpError(409, "Bu adres zaten kayıtlı.");

  const deps = await createEmailDeps(db);
  const v = await verifyEmail(parsed.email, deps.resolver);
  const now = Date.now();
  await saveEmails(
    db,
    leadId,
    [
      {
        email: parsed.email,
        sourceType: "manual",
        sourceUrl: null,
        verifyStatus: v.status,
        verifyReason: v.reason,
      },
    ],
    now,
  );
  const hasRow = (
    await db
      .select({ id: leadEnrichment.leadId })
      .from(leadEnrichment)
      .where(eq(leadEnrichment.leadId, leadId))
  )[0];
  if (!hasRow) await upsertEnrichment(db, leadId, { status: "done", completedAt: now }, now);
  await refreshLeadSummary(db, leadId, now);
  await audit(db, "email.added", "lead", leadId, { domain: parsed.domain, verify: v.reason });
  return json({ ok: true, emails: await getLeadEmails(db, leadId) }, { status: 201 });
});
