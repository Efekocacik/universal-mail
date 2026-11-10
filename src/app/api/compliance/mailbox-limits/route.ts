import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  MAILBOX_DEFAULTS,
  MAILBOX_FLOORS,
  getMailboxLimits,
  tightenMailboxLimits,
} from "@/lib/mail/mailbox-health";
import { requireConsent } from "../../campaigns/schema";
import { mailboxLimitsSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/** Posta kutusu eşikleri: yalnızca SIKILAŞTIRILABİLİR. Kapsam sunucuda her zaman `demo`dur. */
export const GET = domainRoute(async () => {
  const db = await database();
  return json({
    limits: await getMailboxLimits(db),
    defaults: MAILBOX_DEFAULTS,
    floors: MAILBOX_FLOORS,
  });
});

export const PATCH = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, mailboxLimitsSchema);
  await requireConsent(db);
  return json({ limits: await tightenMailboxLimits(db, { scope: "demo", ...input }) });
});
