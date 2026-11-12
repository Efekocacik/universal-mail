import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { dayKey } from "@/lib/scan/schedule";
import { PLACE_ID_REFRESH_JOB } from "@/lib/scan/place-id-refresh";
import { requireCollectionReady } from "../../scans/guard";

export const dynamic = "force-dynamic";

const schema = z.object({ limit: z.number().int().min(1).max(5000).optional() }).strict();

/**
 * "Yer kimliklerini şimdi yenile": 12 aydan eski kimlikleri Google'a (ücretsiz IDs Only isteğiyle) sorar. İş kuyruğa
 * alınır (202); gün başına bir el ile istek (tekrarlı tıklama ikinci iş eklemez, `queued:false`).
 * 403 SETUP_REQUIRED (kullanım onayı yoksa).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const text = await req
    .clone()
    .text()
    .catch(() => "");
  const { limit } = text.trim() ? await body(req, schema) : { limit: undefined };
  const now = Date.now();
  const jobId = await enqueueJob(
    db,
    PLACE_ID_REFRESH_JOB,
    { limit: limit ?? 500, manual: true },
    { dedupeKey: `${PLACE_ID_REFRESH_JOB}:manual:${dayKey(now)}`, priority: 2, maxAttempts: 1 },
  );
  if (jobId !== null)
    await audit(
      db,
      "places.ids_refresh_requested",
      "places",
      undefined,
      { limit: limit ?? 500 },
      now,
    );
  return json({ queued: jobId !== null, jobId }, { status: 202 });
});
