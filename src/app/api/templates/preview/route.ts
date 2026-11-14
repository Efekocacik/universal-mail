import { body, database, HttpError, json } from "@/lib/api/http";
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
  const { draft, leadId, variant = "a" } = await body(req, previewSchema);
  if (variant === "b" && !(draft.kind === "initial" && draft.subjectB?.trim())) {
    throw new HttpError(400, "Bu şablonun B konusu yok.", { code: "TEMPLATE_NO_VARIANT_B" });
  }
  const r = await previewTemplateDraft(db, draft, leadId, variant);
  if (!r.ok) return json({ ok: false, errors: r.errors, warnings: r.warnings });
  const c = r.composed;
  return json({
    ok: true,
    subject: c.subject,
    variant,
    html: c.html,
    text: c.text,
    language: c.language,
    missing: c.missing,
    variables: r.variables,
    errors: c.errors,
    warnings: [...r.warnings, ...c.warnings],
  });
});
