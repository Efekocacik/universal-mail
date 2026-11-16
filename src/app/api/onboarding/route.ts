import { database, json, route } from "@/lib/api/http";
import { getOnboardingChecklist } from "@/lib/onboarding/checklist";

export const dynamic = "force-dynamic";

/**
 * Faz 6 (K.4): gösterge panelindeki "Kurulumu tamamlayın" listesi. Yalnızca okur; kişisel veri döndürmez.
 * Yanıt: `{items:[{id, done, href, demo?}], dismissedAt, allDone, done, total}`.
 */
export const GET = route(async () => {
  const db = await database();
  return json(await getOnboardingChecklist(db));
});
