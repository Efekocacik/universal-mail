import { database, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { exportMailLogCsv } from "@/lib/mail/mail-log";
import { mailLogQuerySchema, paramsObject, strictParams } from "../../mail/schema";

export const dynamic = "force-dynamic";

const EXPORT_PARAMS = ["direction", "purpose", "campaignId", "status", "from", "to"] as const;

/**
 * Gönderim günlüğü CSV. YALNIZCA maskeli adres: tam adres seçeneği yoktur; bilinmeyen parametre (ör. `full=1`)
 * reddedilir. Her dışa aktarma işlem günlüğüne (içerik olmadan) yazılır.
 */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  strictParams(sp, EXPORT_PARAMS);
  const filters = mailLogQuerySchema.parse(paramsObject(sp));
  await audit(db, "export.mail_log", undefined, undefined, {
    direction: filters.direction ?? "all",
    purpose: filters.purpose ?? "all",
    campaignId: filters.campaignId ?? 0,
    maskedOnly: true,
  });
  const gen = exportMailLogCsv(db, filters);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="universal-mail-gonderim-gunlugu-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
