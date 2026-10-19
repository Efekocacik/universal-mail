import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { leadEmails } from "@/lib/db/schema";
import { createEmailDeps } from "@/lib/email/deps";
import { getLeadEmails, refreshLeadSummary } from "@/lib/email/store";
import { verifyEmail } from "@/lib/email/verify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; emailId: string }> };

const patchSchema = z
  .object({
    /** Bu adresi birincil yap (sabitlenir; otomatik seçim onu değiştirmez). */
    primary: z.literal(true).optional(),
    /** DNS/MX doğrulamasını yeniden çalıştır. */
    reverify: z.literal(true).optional(),
    /** Elle doğrulama sonucu (örn. adresin çalıştığını biliyorsunuz). */
    verifyStatus: z.enum(["verified", "invalid"]).optional(),
  })
  .refine((v) => v.primary || v.reverify || v.verifyStatus, "Değişiklik belirtilmedi.");

async function load(ctx: Ctx) {
  const db = await database();
  const p = await ctx.params;
  const leadId = intParam(p.id);
  const emailId = intParam(p.emailId, "emailId");
  const row = (
    await db
      .select()
      .from(leadEmails)
      .where(and(eq(leadEmails.id, emailId), eq(leadEmails.leadId, leadId)))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, "E-posta kaydı bulunamadı.");
  return { db, leadId, row };
}

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { db, leadId, row } = await load(ctx);
  const patch = await body(req, patchSchema);
  const now = Date.now();
  if (patch.reverify) {
    const deps = await createEmailDeps(db);
    const v = await verifyEmail(row.email, deps.resolver);
    await db
      .update(leadEmails)
      .set({ verifyStatus: v.status, verifyReason: v.reason, verifiedAt: now, updatedAt: now })
      .where(eq(leadEmails.id, row.id));
  }
  if (patch.verifyStatus) {
    await db
      .update(leadEmails)
      .set({
        verifyStatus: patch.verifyStatus,
        verifyReason: "manual",
        verifiedAt: now,
        updatedAt: now,
      })
      .where(eq(leadEmails.id, row.id));
  }
  if (patch.primary) {
    if (row.verifyStatus === "invalid" && !patch.verifyStatus)
      throw new HttpError(400, "Geçersiz bir adres birincil yapılamaz.");
    await db.update(leadEmails).set({ primaryPinned: false }).where(eq(leadEmails.leadId, leadId));
    await db
      .update(leadEmails)
      .set({ primaryPinned: true, updatedAt: now })
      .where(eq(leadEmails.id, row.id));
  }
  await refreshLeadSummary(db, leadId, now);
  await audit(db, "email.updated", "lead", leadId, { emailId: row.id, ...patch });
  return json({ ok: true, emails: await getLeadEmails(db, leadId) });
});

export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const { db, leadId, row } = await load(ctx);
  await db.delete(leadEmails).where(eq(leadEmails.id, row.id));
  await refreshLeadSummary(db, leadId);
  await audit(db, "email.deleted", "lead", leadId, { emailId: row.id });
  return json({ ok: true, emails: await getLeadEmails(db, leadId) });
});
