import { z } from "zod";
import { body, database, route } from "@/lib/api/http";
import { parseLeadFilters, selectionSchema } from "@/lib/api/filters";
import { exportLeadsCsv } from "@/lib/export/csv";
import type { LeadFilters } from "@/lib/leads/query";
import type { Db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

function csvResponse(
  db: Db,
  filters: LeadFilters,
  opts: { includeGoogleFields: boolean; selection?: "ids" | "filter" },
): Response {
  const gen = exportLeadsCsv(db, filters, opts);
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
}

/**
 * CSV dışa aktarma. Google kaynaklı alanlar (ad, adres, web sitesi vb.) ancak `google=1` ile ve kullanıcı
 * bilinçli onay verdiyse dahil edilir (SRS 8.1).
 */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  return csvResponse(db, parseLeadFilters(sp), { includeGoogleFields: sp.get("google") === "1" });
});

const postSchema = z
  .object({
    selection: selectionSchema,
    /** Google kaynaklı alanları dahil et (varsayılan kapalı; kullanıcı bilinçli açar). */
    google: z.boolean().default(false),
  })
  .strict();

/**
 * Seçimle dışa aktarma (Faz 4): `{selection:{leadIds}|{filterQuery}, google?}`. 2000 kimlik GET adresine sığmaz (Node
 * 16 KB başlık sınırı), bu yüzden POST gövdesiyle gelir. Kimlikle seçimde arşivdekiler de dahildir (seçilen satırlar
 * neyse o); süzgeçle seçimde liste ne gösteriyorsa o (sınırsız; dışa aktarma ücretli değildir).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  const input = await body(req, postSchema);
  const sel = input.selection;
  const filters: LeadFilters =
    "leadIds" in sel
      ? { ids: [...new Set(sel.leadIds)], archived: "any" }
      : parseLeadFilters(new URLSearchParams(sel.filterQuery));
  return csvResponse(db, filters, {
    includeGoogleFields: input.google,
    selection: "leadIds" in sel ? "ids" : "filter",
  });
});
