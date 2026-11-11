import { database, route } from "@/lib/api/http";
import { exportAuditCsv } from "@/lib/audit-list";
import { audit } from "@/lib/db/audit";
import { auditQuerySchema, paramsObject, strictParams } from "../../mail/schema";

export const dynamic = "force-dynamic";

/** İşlem günlüğü CSV (güvenli özet alanlarıyla). Dışa aktarma işlem günlüğüne yazılır. */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  strictParams(sp, ["prefix"]);
  const q = auditQuerySchema.parse(paramsObject(sp));
  await audit(db, "export.audit", undefined, undefined, { filtered: !!q.prefix });
  const gen = exportAuditCsv(db, { actionPrefix: q.prefix });
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
      "Content-Disposition": `attachment; filename="universal-mail-islem-gunlugu-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
