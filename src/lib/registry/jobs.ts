import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { jobs } from "@/lib/db/schema";
import { NonRetryableJobError, registerJobHandler, type JobContext } from "@/lib/jobs/registry";
import {
  executeFetch,
  PermanentRegistryError,
  RegistryFetchInterrupted,
  runMatch,
} from "./service";
import { REGISTRY_FETCH_JOB, REGISTRY_MATCH_JOB } from "./types";

const fetchPayload = z.object({ runId: z.number().int().positive() });
const matchPayload = z.object({ runId: z.number().int().positive().nullable() });

/**
 * İşçi kapanışında kesilen iş deneme hakkı harcamaz: kapma sırasında artırılan `attempts` geri alınır (veritabanında ve
 * döngünün `failJob`'a verdiği iş nesnesinde), böylece döngü işi gecikmesiz yeniden kuyruğa alır. Uygulamayı çekme
 * sırasında kaç kez kapatırsanız kapatın çalışma `failed` olmaz.
 */
async function giveBackAttempt(ctx: JobContext): Promise<void> {
  await ctx.db
    .update(jobs)
    .set({ attempts: sql`max(${jobs.attempts} - 1, 0)` })
    .where(eq(jobs.id, ctx.job.id));
  ctx.job.attempts = Math.max(ctx.job.attempts - 1, 0);
}

/** `registry.fetch`: sicil sayfalarını çeker (bkz. `executeFetch`). Kalıcı hata → yeniden denenmez. */
export async function handleRegistryFetch(ctx: JobContext): Promise<void> {
  const parsed = fetchPayload.safeParse(ctx.payload);
  if (!parsed.success) throw new NonRetryableJobError("Geçersiz registry.fetch yükü.");
  try {
    await executeFetch(ctx.db, parsed.data.runId, {
      shouldStop: ctx.shouldStop,
      log: ctx.log,
      finalAttempt: ctx.job.attempts >= ctx.job.maxAttempts,
    });
  } catch (e) {
    if (e instanceof PermanentRegistryError) throw new NonRetryableJobError(e.message);
    if (e instanceof RegistryFetchInterrupted) await giveBackAttempt(ctx);
    throw e;
  }
}

/** `registry.match`: oturum önbelleğindeki adaylarla eşleştirir (bkz. `runMatch`). */
export async function handleRegistryMatch(ctx: JobContext): Promise<void> {
  const parsed = matchPayload.safeParse(ctx.payload);
  if (!parsed.success) throw new NonRetryableJobError("Geçersiz registry.match yükü.");
  const s = await runMatch(ctx.db, parsed.data.runId);
  ctx.log(
    `Sicil eşleştirme: ${s.considered} kayıt, ${s.matched} eşleşti, ${s.unmatched} eşleşmedi, ${s.pending} bekliyor.`,
  );
}

/**
 * Sicil işlerinin kaydı. Çağrı yeri `src/worker/handlers.ts` → `registerFaz5Handlers()` (P0; dondurulmuş dosya).
 * İşleyiciler `ctx.db` kullanır.
 */
export function registerRegistryJobs(): void {
  registerJobHandler(REGISTRY_FETCH_JOB, handleRegistryFetch);
  registerJobHandler(REGISTRY_MATCH_JOB, handleRegistryMatch);
}
