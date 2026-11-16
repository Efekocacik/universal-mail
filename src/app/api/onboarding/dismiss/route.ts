import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { dismissOnboarding } from "@/lib/onboarding/checklist";

export const dynamic = "force-dynamic";

const schema = z.object({}).strict();

/**
 * Faz 6 (K.4): kurulum listesi kartını gizler. Gövde `{}`; yanıt `{dismissedAt}`. İdempotent: zaten gizliyse ilk an
 * döner ve denetim kaydı yazılmaz (ilk gizlemede `onboarding.dismiss`).
 */
export const POST = route(async (req: Request) => {
  await body(req, schema);
  const db = await database();
  const r = await dismissOnboarding(db);
  return json({ dismissedAt: r.dismissedAt });
});
