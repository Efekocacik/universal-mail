import { z } from "zod";
import { database, json, route } from "@/lib/api/http";
import { listCompanies, MATCH_FILTERS } from "@/lib/registry/service";
import { registryCall } from "../guard";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    source: z.enum(["companies_house", "insee"]).optional(),
    country: z.enum(["GB", "FR"]).optional(),
    /** `all` veya virgüllü liste (ör. `unmatched,pending`). */
    match: z
      .string()
      .max(40)
      .optional()
      .transform((v) => (!v || v === "all" ? undefined : v.split(",")))
      .pipe(z.array(z.enum(MATCH_FILTERS)).max(3).optional()),
    runId: z.coerce.number().int().positive().optional(),
    leadId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(64).optional(),
  })
  .strict();

/** `GET /api/registry/companies` → `{ items, nextCursor, stats }` (anahtar kümesi sayfalama). */
export const GET = route(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const q = querySchema.parse(Object.fromEntries(sp.entries()));
  const db = await database();
  return json(await registryCall(() => listCompanies(db, q)));
});
