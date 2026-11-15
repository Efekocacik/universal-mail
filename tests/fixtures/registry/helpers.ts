import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs, leads, places } from "@/lib/db/schema";
import { completeJob } from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/registry";
import { upsertCache } from "@/lib/places/cache";
import { handleRegistryFetch, handleRegistryMatch } from "@/lib/registry/jobs";
import { setSetting } from "@/lib/settings";

/** Sicil testleri için ortak yardımcılar (YAPAY veriler; gerçek şirket/alan adı yok). */

export const ORIGIN = "http://127.0.0.1:3000";

export function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

export async function completeSetup(db: Db, provider: "mock" | "google" = "mock"): Promise<void> {
  await setSetting(db, "places.provider", provider);
  await setSetting(db, "targets.countries", ["GB", "FR"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

let seq = 0;

/** Haritadan bulunmuş gibi bir yer + lead + oturum önbelleği satırı ekler. */
export async function seedPlace(
  db: Db,
  o: { name: string; city: string; country?: "GB" | "FR"; address?: string; placeId?: string },
  now: number = Date.now(),
): Promise<{ placeId: string; leadId: number }> {
  const placeId = o.placeId ?? `reg-test-place-${++seq}`;
  await db.insert(places).values({
    placeId,
    source: "demo",
    coordsFetchedAt: now,
    firstSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const [l] = await db
    .insert(leads)
    .values({
      placeId,
      source: "demo",
      countryCode: o.country ?? "GB",
      city: o.city,
      categoryKey: "cafe",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: leads.id });
  await upsertCache(
    db,
    [
      {
        placeId,
        source: "demo",
        name: o.name,
        formattedAddress: o.address ?? `1 Sample Street, ${o.city}`,
        lat: 51.5,
        lng: -0.12,
        types: ["cafe"],
      },
    ],
    now,
  );
  return { placeId, leadId: l!.id };
}

/** Kuyruktaki sicil işlerini (çekme → eşleştirme) sırayla çalıştırır; çalıştırılan iş türlerini döndürür. */
export async function drainRegistryJobs(db: Db, max = 10): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < max; i++) {
    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.status, "queued"), inArray(jobs.type, ["registry.fetch", "registry.match"])),
      )
      .orderBy(jobs.id)
      .limit(1);
    if (!job) break;
    await db
      .update(jobs)
      .set({ status: "running", attempts: job.attempts + 1 })
      .where(eq(jobs.id, job.id));
    const ctx: JobContext = {
      job: { ...job, attempts: job.attempts + 1 },
      payload: job.payload,
      db,
      shouldStop: () => false,
      log: () => undefined,
    };
    try {
      await (job.type === "registry.fetch" ? handleRegistryFetch(ctx) : handleRegistryMatch(ctx));
      await completeJob(db, job.id);
    } catch (e) {
      await db
        .update(jobs)
        .set({ status: "failed", lastError: String(e) })
        .where(eq(jobs.id, job.id));
    }
    ran.push(job.type);
  }
  return ran;
}
