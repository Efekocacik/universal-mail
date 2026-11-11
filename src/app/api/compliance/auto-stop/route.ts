import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  AUTO_STOP_DEFAULTS,
  AUTO_STOP_FLOORS,
  getAutoStopConfig,
  tightenAutoStop,
} from "@/lib/campaigns/auto-stop";
import { requireConsent } from "../../campaigns/schema";
import { autoStopSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Demo otomatik durdurma eşikleri. Eşikler yalnızca SIKILAŞTIRILABİLİR (durdurmayı daha kolay tetikler); gevşetme,
 * alt sınırın altı ve doğrulanmış bounce sayısının (2) değişmesi reddedilir. Kapsam sunucuda her zaman `demo`dur.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return json({
    config: await getAutoStopConfig(db),
    defaults: { ...AUTO_STOP_DEFAULTS, minBounces: 2 },
    floors: { ...AUTO_STOP_FLOORS, minBounces: 2 },
  });
});

export const PATCH = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, autoStopSchema);
  await requireConsent(db);
  return json({ config: await tightenAutoStop(db, { scope: "demo", ...input }) });
});
