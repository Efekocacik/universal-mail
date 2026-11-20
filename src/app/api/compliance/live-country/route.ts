import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  activateLiveCountries,
  getLiveCountryState,
  planActivation,
  revokeLiveCountries,
} from "@/lib/compliance/live-country-activation";
import { requestNativeConfirm } from "@/lib/native-confirm";
import { requireConsent } from "../../campaigns/schema";

export const dynamic = "force-dynamic";

/**
 * Canlı ülke aktivasyonu ve geri alma (uygulama içi). Mantık ve güvenceler: src/lib/compliance/live-country-activation.ts.
 *
 *  - GET: durum (ülkeler, ön koşullar, yerel onay kanalı var mı).
 *  - POST `plan`: hiçbir şey yazmaz; doğrulama ve ön koşul sonucu.
 *  - POST `activate`: hukuki yetkilendirme KAYDI + test modu + ön koşullar + Electron YEREL onayı ister; web isteği tek
 *    başına aktivasyon yapamaz (yerel onay kanalı yoksa reddedilir).
 *  - POST `revoke`: ülkeyi yeniden engeller ve kilitler; çalışan canlı kampanyalar önce duraklatılır.
 */

const legalFields = {
  countries: z.array(z.string().max(8)).min(1).max(10),
  mode: z.enum(["generic_only", "allowed"]),
  representativeName: z.string().max(80),
  representativeTitle: z.string().max(80),
  operatorName: z.string().max(80),
  documentRef: z.string().max(200),
  documentDate: z.string().max(10),
  documentSha256: z.string().max(64).nullable().optional(),
  scopeAttested: z.boolean(),
};

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan"), ...legalFields }).strict(),
  z.object({ action: z.literal("activate"), ...legalFields }).strict(),
  z
    .object({
      action: z.literal("revoke"),
      countries: z.array(z.string().max(8)).min(1).max(10),
      ack: z.boolean(),
    })
    .strict(),
]);

export const GET = domainRoute(async () => {
  const db = await database();
  return json(await getLiveCountryState(db));
});

export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, postSchema);
  await requireConsent(db);
  if (input.action === "revoke") {
    return json(await revokeLiveCountries(db, { countries: input.countries, ack: input.ack }));
  }
  const { action, ...activation } = input;
  if (action === "plan") return json(await planActivation(db, activation));
  return json(
    await activateLiveCountries(db, activation, {
      confirm: (r) => requestNativeConfirm(r),
    }),
  );
});
