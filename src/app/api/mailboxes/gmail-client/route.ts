import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { clearGmailClient, getGmailClientStatus, setGmailClient } from "@/lib/mail/mailbox-service";
import { requireConsent } from "../../campaigns/schema";
import { gmailClientSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/** Yalnızca durum döner: sır (maskeli bile) ve tam istemci kimliği ASLA döndürülmez. */
export const GET = domainRoute(async () => {
  const db = await database();
  return json(await getGmailClientStatus(db));
});

/** İstemci kimliği ve (isteğe bağlı) sırrı kaydeder. Dış çağrı yapmaz; geçerliliği sınanmaz. */
export const PUT = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, gmailClientSchema);
  await requireConsent(db);
  await setGmailClient(db, input);
  return json(await getGmailClientStatus(db));
});

export const DELETE = domainRoute(async () => {
  const db = await database();
  await requireConsent(db);
  await clearGmailClient(db);
  return json(await getGmailClientStatus(db));
});
