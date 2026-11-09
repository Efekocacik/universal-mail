import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { createTemplate, listTemplates } from "@/lib/mail/template-service";
import { requireConsent } from "../campaigns/schema";
import { templateDraftSchema } from "./schema";

export const dynamic = "force-dynamic";

/**
 * Şablon listesi (gövde yok): kampanya adımları ve şablon ekranı için. `lockedBy` > 0 ise şablon hazır, çalışan veya
 * duraklatılmış kampanyalarda kullanılıyordur ve içeriği değiştirilemez.
 */
export const GET = domainRoute(async (req: Request) => {
  const db = await database();
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return json({ items: await listTemplates(db, { includeArchived }) });
});

/** Yeni şablon (her zaman kullanıcı şablonudur; yerleşik olarak oluşturulamaz). */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const draft = await body(req, templateDraftSchema);
  await requireConsent(db);
  return json(await createTemplate(db, draft), { status: 201 });
});
