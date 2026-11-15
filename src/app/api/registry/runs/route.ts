import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { createRun, isMatchActive, listRuns } from "@/lib/registry/service";
import { requireCollectionReady } from "../../scans/guard";
import { registryCall } from "../guard";

export const dynamic = "force-dynamic";

/** Kod biçimi kaynağa göre serviste denetlenir (SIC 5 hane / NAF 00.00X); burada yalnızca güvenli üst sınırlar. */
const createSchema = z
  .object({
    source: z.enum(["companies_house", "insee"]),
    locality: z.string().trim().min(1).max(80).optional(),
    codes: z
      .array(z.string().regex(/^[0-9A-Z.]{5,6}$/))
      .min(1)
      .max(20)
      .optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

/** `GET /api/registry/runs?limit=1..50` → `{ runs, matchActive }`. */
export const GET = route(async (req: Request) => {
  const db = await database();
  const n = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 50) : 20;
  const [runs, matchActive] = await Promise.all([listRuns(db, limit), isMatchActive(db)]);
  return json({ runs, matchActive });
});

/** `POST /api/registry/runs` → 202 `{ run, jobId }`. Kurulum/onay gerekir; canlıda ayar açık + anahtar şart. */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const input = await body(req, createSchema);
  const created = await registryCall(() => createRun(db, input));
  return json(created, { status: 202 });
});
