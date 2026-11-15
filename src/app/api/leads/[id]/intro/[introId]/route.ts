import { z } from "zod";
import { body, database, intParam, json, route } from "@/lib/api/http";
import { updateLeadIntro } from "@/lib/ai/service";
import { introHttpError } from "../http";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    action: z.enum(["approve", "reject", "save"]),
    text: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/** İnceleme: onayla (isteğe bağlı düzenlenmiş metinle), reddet veya metni kaydet (taslağa döner). */
export const PATCH = route(
  async (req: Request, ctx: { params: Promise<{ id: string; introId: string }> }) => {
    const db = await database();
    const p = await ctx.params;
    const leadId = intParam(p.id);
    const introId = intParam(p.introId, "introId");
    const input = await body(req, schema);
    try {
      return json({ intro: await updateLeadIntro(db, leadId, introId, input) });
    } catch (e) {
      throw introHttpError(e);
    }
  },
);
