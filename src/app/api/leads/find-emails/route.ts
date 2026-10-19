import { inArray } from "drizzle-orm";
import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import { monthSkuCalls } from "@/lib/budget";
import { audit } from "@/lib/db/audit";
import { leads } from "@/lib/db/schema";
import { enqueueEmailSearch } from "@/lib/email/enqueue";
import { websiteStates, type LeadInfo } from "@/lib/email/service";
import { getEnrichmentMap, upsertEnrichment } from "@/lib/email/store";
import { getSecret } from "@/lib/secrets/store";
import { enqueueJob } from "@/lib/jobs/queue";
import { queryLeadIds } from "@/lib/leads/query";
import { marginalCostUsd } from "@/lib/places/pricing";
import { getSettings } from "@/lib/settings";
import { chunk, round } from "@/lib/util";
import { budgetSummary, requireCollectionReady } from "../../scans/guard";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    /** Seçili lead'ler. */
    leadIds: z.array(z.number().int()).min(1).max(2000).optional(),
    /** Alternatif: listedeki süzgeçlerin sorgu dizesi (en fazla 2000 lead). */
    filtersQuery: z.string().max(2000).optional(),
    /** Web sitesi adresi önbellekte olmayan işletmeler için önce Google verisini (Place Details Enterprise) yükle. */
    loadGoogle: z.boolean().default(false),
    /** Yerel taramada bulunamayanlar için harici servisi (Hunter) kullan; yalnızca ayarlarda etkinse. */
    useExternal: z.boolean().default(false),
    /** Daha önce taranmış/engellenmiş lead'leri de yeniden tara. */
    force: z.boolean().default(false),
    dryRun: z.boolean().optional(),
  })
  .refine((v) => v.leadIds || v.filtersQuery !== undefined, "leadIds veya filtersQuery gerekli.");

/**
 * Seçili lead'ler için web sitesinden e-posta aramayı başlatır (FR-ENR-01). `dryRun` yalnızca ne olacağını ve
 * maliyeti gösterir. Web sitesi adresi Google verisi olduğundan yalnızca oturum önbelleğinden okunur; önbellekte
 * olmayanlar için `loadGoogle` ile önce Google verisi yüklenir (ücretli kotadan düşer, önizlemede görünür).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const input = await body(req, schema);

  const ids = input.leadIds
    ? [...new Set(input.leadIds)]
    : await queryLeadIds(db, parseLeadFilters(new URLSearchParams(input.filtersQuery)), 2000);
  if (ids.length === 0) throw new HttpError(400, "Süzgece uyan işletme yok.");

  const infos: LeadInfo[] = [];
  for (const part of chunk(ids, 500))
    infos.push(
      ...(await db
        .select({
          id: leads.id,
          placeId: leads.placeId,
          status: leads.status,
          countryCode: leads.countryCode,
        })
        .from(leads)
        .where(inArray(leads.id, part))),
    );
  const enrichment = await getEnrichmentMap(db, ids);
  const sites = await websiteStates(db, infos);

  const ready: number[] = [];
  const noWebsite: number[] = [];
  const needsGoogle: LeadInfo[] = [];
  let alreadyDone = 0;
  let optedOut = 0;
  for (const l of infos) {
    if (l.status === "do_not_contact" || l.status === "not_interested") {
      optedOut++;
      continue;
    }
    const prev = enrichment.get(l.id);
    if (prev && ["done", "no_website", "blocked"].includes(prev.status) && !input.force) {
      alreadyDone++;
      continue;
    }
    const w = sites.get(l.id)!;
    if (w.kind === "site") ready.push(l.id);
    else if (w.kind === "no_website") noWebsite.push(l.id);
    else needsGoogle.push(l);
  }
  const googleTargets = needsGoogle.filter((l) => l.placeId);

  const settings = await getSettings(db, ["places.provider", "enrichment.external"] as const);
  const configured = !!(await getSecret("hunter.apiKey"));
  const external = {
    enabled: settings["enrichment.external"].enabled,
    configured,
    available:
      settings["enrichment.external"].enabled &&
      configured &&
      settings["places.provider"] !== "mock",
  };
  const provider = settings["places.provider"];
  const before = await monthSkuCalls(db, provider, "place_details_enterprise");
  const budget = await budgetSummary(db);
  const preview = {
    leads: infos.length,
    ready: ready.length,
    noWebsite: noWebsite.length,
    needsGoogle: googleTargets.length,
    alreadyDone,
    optedOut,
    willSearch: ready.length + (input.loadGoogle ? googleTargets.length : 0),
    google: {
      load: input.loadGoogle,
      places: googleTargets.length,
      // Seçenek kapalıyken de gösterilir: kullanıcı açmadan önce maliyeti bilsin.
      estimatedCostUsd: round(
        marginalCostUsd("place_details_enterprise", before, googleTargets.length),
        2,
      ),
      remainingBudgetUsd: budget.remainingUsd,
    },
    external,
  };
  if (input.dryRun) return json({ preview, queued: false });

  const useExternal = input.useExternal && external.available;
  if (input.loadGoogle && googleTargets.length > 0 && budget.level === "blocked")
    throw new HttpError(409, "Aylık bütçe sınırına ulaşıldı.", { code: "BUDGET_BLOCKED" });

  let jobs = 0;
  const direct = [...ready, ...noWebsite];
  if (direct.length > 0)
    jobs += await enqueueEmailSearch(db, direct, { force: input.force, useExternal });

  if (input.loadGoogle && googleTargets.length > 0) {
    const placeIds = googleTargets.map((l) => l.placeId!);
    for (const l of googleTargets) await upsertEnrichment(db, l.id, { status: "queued" });
    for (const part of chunk(placeIds, 100)) {
      await enqueueJob(
        db,
        "place.enrich",
        { placeIds: part, mode: "enrich", findEmails: true, useExternal },
        { maxAttempts: 2 },
      );
      jobs++;
    }
  }
  await audit(db, "email.search.queued", "leads", undefined, {
    leads: infos.length,
    ready: ready.length,
    noWebsite: noWebsite.length,
    loadGoogle: input.loadGoogle ? googleTargets.length : 0,
    useExternal,
  });
  return json({ preview, queued: jobs > 0, jobs }, { status: jobs > 0 ? 202 : 200 });
});
