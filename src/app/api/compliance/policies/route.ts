import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import { listCountryPolicies, tightenDemoPolicy } from "@/lib/compliance/policy-service";
import { requireConsent } from "../../campaigns/schema";
import { policyChangeSchema } from "../schema";

export const dynamic = "force-dynamic";

/**
 * Ülke politikaları. `demo`: kullanıcı yalnızca sıkılaştırabilir. `live`: gerçek gönderim kapalı olduğundan hepsi
 * engelli ve kilitlidir; salt okunur gösterilir. Bu modlar hukuki uygunluğun kanıtı değildir.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return json({
    liveSendingEnabled: LIVE_SENDING_ENABLED,
    demo: await listCountryPolicies(db, "demo"),
    live: await listCountryPolicies(db, "live"),
  });
});

/** Bir demo politikasını SIKILAŞTIRIR (allowed → generic_only → blocked). Gevşetme ve live değişikliği yoktur. */
export const PATCH = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, policyChangeSchema);
  await requireConsent(db);
  return json(await tightenDemoPolicy(db, { scope: "demo", ...input }));
});
