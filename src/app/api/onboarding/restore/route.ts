import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { restoreOnboarding } from "@/lib/onboarding/checklist";

export const dynamic = "force-dynamic";

const schema = z.object({}).strict();

/**
 * Faz 6 (K.4): gizlenen kurulum listesi kartını yeniden gösterir. Gövde `{}`; yanıt `{dismissedAt: null}`.
 * İdempotent: zaten görünürse hiçbir şey yazılmaz (değişince `onboarding.restore` denetim kaydı).
 */
export const POST = route(async (req: Request) => {
  await body(req, schema);
  const db = await database();
  const r = await restoreOnboarding(db);
  return json({ dismissedAt: r.dismissedAt });
});
