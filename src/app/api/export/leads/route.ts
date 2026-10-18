import { database, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import { exportLeadsCsv } from "@/lib/export/csv";

export const dynamic = "force-dynamic";

/**
 * CSV dışa aktarma. Google kaynaklı alanlar (ad, adres, web sitesi vb.) ancak `google=1` ile ve kullanıcı
 * bilinçli onay verdiyse dahil edilir (SRS 8.1).
 */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  const includeGoogleFields = sp.get("google") === "1";
  const filters = parseLeadFilters(sp);
  const gen = exportLeadsCsv(db, filters, { includeGoogleFields });
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
      "Content-Disposition": `attachment; filename="universal-mail-leadler-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
