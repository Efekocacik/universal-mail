import { database, json, route } from "@/lib/api/http";
import { listMailLog } from "@/lib/mail/mail-log";
import { MAIL_LOG_PARAMS, mailLogQuerySchema, paramsObject, strictParams } from "../mail/schema";

export const dynamic = "force-dynamic";

/** Gönderim günlüğü. Adresler maskeli; silinmiş kayıtlar kişisel veri içermez. */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  strictParams(sp, MAIL_LOG_PARAMS);
  const q = mailLogQuerySchema.parse(paramsObject(sp));
  const { beforeId, limit, ...filters } = q;
  return json(await listMailLog(db, filters, { beforeId, limit }));
});
