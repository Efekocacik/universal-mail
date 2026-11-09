import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { previewTemplateDraft } from "@/lib/mail/template-service";
import { previewSchema } from "../schema";

export const dynamic = "force-dynamic";

/**
 * Kaydedilmemiş taslağın canlı ön izlemesi (FR-TPL-04): gerçek bir lead üzerinden, YALNIZCA demo kipinde.
 * Hiçbir şey yazılmaz ve ileti gönderilmez. Eksik değişkenler işaretli gösterilir; uyarı ve hata kodları döner.
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { draft, leadId } = await body(req, previewSchema);
  const r = await previewTemplateDraft(db, draft, leadId);
  if (!r.ok) return json({ ok: false, errors: r.errors, warnings: r.warnings });
  const c = r.composed;
  return json({
    ok: true,
    subject: c.subject,
    html: c.html,
    text: c.text,
    language: c.language,
    missing: c.missing,
    variables: r.variables,
    errors: c.errors,
    warnings: [...r.warnings, ...c.warnings],
  });
});
