import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { liftSuppression } from "@/lib/compliance/suppression";
import { requireConsent } from "../../../../campaigns/schema";
import { liftSchema } from "../../../schema";

export const dynamic = "force-dynamic";

/**
 * Sıradan kaldırma: açık onay ve en az 10 karakterlik gerekçe gerekir. Yalnızca `manual`, `bounce_hard` ve
 * `negative_reply` nedenleri kaldırılabilir; çıkış, şikâyet ve silme talebi kayıtları için kaldırma yolu YOKTUR
 * (korumalı kaldırma işlevi hiçbir uca bağlı değildir).
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, liftSchema);
  await requireConsent(db);
  await liftSuppression(db, { id, ...input });
  return json({ ok: true });
});
