import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { leadEnrichment, leads } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { chunk } from "@/lib/util";
import { upsertEnrichment } from "./store";

export const EMAIL_JOB = "enrich.email";
/** Bir işte işlenen lead sayısı: ilerleme görünür kalsın ve durdurma hızlı olsun. */
export const EMAIL_JOB_CHUNK = 20;

export interface EmailJobPayload {
  leadIds: number[];
  force?: boolean;
  useExternal?: boolean;
}

/** E-posta bulma işlerini kuyruğa alır ve lead'leri "kuyrukta" olarak işaretler. */
export async function enqueueEmailSearch(
  db: Db,
  leadIds: number[],
  opts: { force?: boolean; useExternal?: boolean; runAt?: number; markQueued?: boolean } = {},
): Promise<number> {
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return 0;
  const now = Date.now();
  for (const part of opts.markQueued === false ? [] : chunk(ids, 500)) {
    const existing = new Set(
      (
        await db
          .select({ id: leadEnrichment.leadId, status: leadEnrichment.status })
          .from(leadEnrichment)
          .where(inArray(leadEnrichment.leadId, part))
      )
        .filter((r) => r.status === "running")
        .map((r) => r.id),
    );
    for (const id of part)
      if (!existing.has(id)) await upsertEnrichment(db, id, { status: "queued" }, now);
  }
  let jobs = 0;
  for (const part of chunk(ids, EMAIL_JOB_CHUNK)) {
    const payload: EmailJobPayload = {
      leadIds: part,
      force: opts.force,
      useExternal: opts.useExternal,
    };
    await enqueueJob(db, EMAIL_JOB, payload, { maxAttempts: 2, runAt: opts.runAt });
    jobs++;
  }
  return jobs;
}

/** Yer kimliklerinden lead kimlikleri (zenginleştirme olayı → e-posta bulma geçişi için). */
export async function leadIdsForPlaces(db: Db, placeIds: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const part of chunk(placeIds, 500)) {
    const rows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.placeId, part));
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

export async function clearEnrichment(db: Db, leadId: number): Promise<void> {
  await db.delete(leadEnrichment).where(eq(leadEnrichment.leadId, leadId));
}
