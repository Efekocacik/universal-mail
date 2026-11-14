import { sql } from "drizzle-orm";
import { database, json, route } from "@/lib/api/http";
import { leadEnrichment } from "@/lib/db/schema";
import { EMAIL_JOB } from "@/lib/email/enqueue";
import { countJobs } from "@/lib/jobs/queue";
import { externalStatus } from "@/lib/email/deps";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** E-posta bulma durumu: sürmekte olan işler, işlem durumu sayıları ve harici servis ayarı (kota için /external/test). */
export const GET = route(async () => {
  const db = await database();
  const states = await db
    .select({ status: leadEnrichment.status, n: sql<number>`count(*)` })
    .from(leadEnrichment)
    .groupBy(leadEnrichment.status);
  const s = await getSettings(db, ["enrichment.concurrency"] as const);
  return json({
    jobs: {
      // Yalnızca zamanı gelmiş işler "sırada" sayılır; 24 saat sonraya planlanan yeniden denemeler ayrı gösterilir.
      queued: await countJobs(db, "queued", EMAIL_JOB, { dueOnly: true }),
      running: await countJobs(db, "running", EMAIL_JOB),
      scheduled:
        (await countJobs(db, "queued", EMAIL_JOB)) -
        (await countJobs(db, "queued", EMAIL_JOB, { dueOnly: true })),
    },
    states: Object.fromEntries(states.map((r) => [r.status, Number(r.n)])),
    // Faz 5 (paket A): seçili sağlayıcının (Hunter veya Snov) anahtar durumu.
    external: await externalStatus(db),
    concurrency: s["enrichment.concurrency"],
  });
});
