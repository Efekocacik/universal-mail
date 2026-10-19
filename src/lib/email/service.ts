import { inArray } from "drizzle-orm";
import { placeCache } from "@/lib/db/cache-schema";
import type { Db } from "@/lib/db/client";
import { leads, type EmailSourceType } from "@/lib/db/schema";
import { emitEvent } from "@/lib/events";
import { chunk } from "@/lib/util";
import { domainMatchesSite, isConsumerDomain, normalizeHost, parseEmail } from "./address";
import { languageForCountry } from "./candidates";
import { crawlSite, type SiteResult } from "./crawler";
import { ExternalProviderError, type ExternalEmailProvider } from "./external";
import type { FetchFn } from "./safe-fetch";
import {
  getEnrichmentMap,
  refreshLeadSummary,
  saveContacts,
  saveEmails,
  upsertEnrichment,
  type NewEmail,
} from "./store";
import { verifyEmail, type Resolver, type VerifyResult } from "./verify";

export interface EmailDeps {
  db: Db;
  fetch: FetchFn;
  resolver: Resolver;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** İstekler arası bekleme (ms). Gerçek sitelerde 1000'den az olmamalıdır (SRS 4.5). */
  delayMs: number;
  maxRequests: number;
  timeoutMs: number;
  /** Aynı anda taranan site sayısı (1-4; FR-ENR-05). */
  concurrency: number;
  userAgent: string;
  agentToken: string;
  /** Harici servis; yalnızca etkin ve anahtar tanımlıysa verilir. */
  external?: ExternalEmailProvider | null;
  allowPrivate?: boolean;
  shouldStop?: () => boolean;
  log?: (message: string) => void;
}

export interface FindOptions {
  /** Daha önce taranmış (veya engellenmiş) lead'leri de yeniden tara. */
  force?: boolean;
  /** Geçici hatada 24 saat sonra tekrar denenecek lead'ler için iş ekleme işlevi. */
  scheduleRetry?: (leadIds: number[], runAt: number) => Promise<void>;
}

export interface FindResult {
  processed: number;
  /** En az bir geçersiz olmayan adres bulunan lead sayısı. */
  found: number;
  notFound: number;
  noWebsite: number;
  needsGoogle: number;
  blocked: number;
  failed: number;
  retryScheduled: number;
  skippedOptOut: number;
  skippedDone: number;
  externalUsed: number;
  stopped: boolean;
}

export const RETRY_DELAY_MS = 24 * 3_600_000;
const MAX_EXTERNAL_PER_DOMAIN = 5;
const MIN_EXTERNAL_CONFIDENCE = 30;

export interface LeadInfo {
  id: number;
  placeId: string | null;
  status: string;
  countryCode: string | null;
}

/** Bir işletmenin web sitesi bilgisi (yalnızca oturum önbelleğinden; kalıcı kayıtta tutulmaz). */
export type WebsiteState =
  { kind: "site"; url: string } | { kind: "no_website" } | { kind: "needs_google" };

export async function websiteStates(db: Db, infos: LeadInfo[]): Promise<Map<number, WebsiteState>> {
  const placeIds = infos.map((l) => l.placeId).filter((p): p is string => !!p);
  const cache = new Map<string, { website: string | null; enrichedAt: number | null }>();
  for (const part of chunk(placeIds, 500)) {
    const rows = await db
      .select({
        id: placeCache.placeId,
        website: placeCache.website,
        enrichedAt: placeCache.enrichedAt,
      })
      .from(placeCache)
      .where(inArray(placeCache.placeId, part));
    for (const r of rows) cache.set(r.id, r);
  }
  const out = new Map<number, WebsiteState>();
  for (const l of infos) {
    const c = l.placeId ? cache.get(l.placeId) : undefined;
    if (!c || c.enrichedAt === null) out.set(l.id, { kind: "needs_google" });
    else if (!c.website?.trim()) out.set(l.id, { kind: "no_website" });
    else out.set(l.id, { kind: "site", url: c.website.trim() });
  }
  return out;
}

function siteKey(url: string): { host: string; key: string } | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return {
      host: normalizeHost(u.hostname),
      key: `${normalizeHost(u.hostname)}${u.pathname}${u.search}`,
    };
  } catch {
    return null;
  }
}

async function runPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
  stop?: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop?.()) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/**
 * Seçili lead'lerin web sitelerinden e-posta bulur, doğrular ve kaydeder (FR-ENR-01..06).
 *  - Web sitesi adresi yalnızca Google oturum önbelleğinden okunur; önbellekte yoksa lead `needs_google` olur
 *    (Google verisi saklanmadığı için: önce "Google verisini yükle/zenginleştir").
 *  - Aynı siteyi paylaşan lead'ler (zincir işletmeler) tek taramayla işlenir.
 *  - Aynı anda en çok `concurrency` site taranır; aynı sunucuya ardışık gidilir.
 *  - Geçici hata: 24 saat sonra EN FAZLA BİR kez yeniden denenir. Engel (robots, 403): asla otomatik tekrar yok.
 */
export async function findEmailsForLeads(
  deps: EmailDeps,
  leadIds: number[],
  opts: FindOptions = {},
): Promise<FindResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const result: FindResult = {
    processed: 0,
    found: 0,
    notFound: 0,
    noWebsite: 0,
    needsGoogle: 0,
    blocked: 0,
    failed: 0,
    retryScheduled: 0,
    skippedOptOut: 0,
    skippedDone: 0,
    externalUsed: 0,
    stopped: false,
  };
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return result;

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
  const websites = await websiteStates(db, infos);
  const mxCache = new Map<string, VerifyResult>();
  const retryLeads: number[] = [];
  const found = new Set<number>();
  let externalDisabled = false;

  // 1) Sınıflandır: atla / site yok / Google verisi gerek / taranacak
  type Target = { lead: LeadInfo; url: string };
  const targets: Target[] = [];
  for (const lead of infos) {
    if (lead.status === "do_not_contact" || lead.status === "not_interested") {
      result.skippedOptOut++;
      continue;
    }
    const prev = enrichment.get(lead.id);
    const settled = prev && ["done", "no_website", "blocked"].includes(prev.status);
    if (settled && !opts.force) {
      result.skippedDone++;
      continue;
    }
    const w = websites.get(lead.id)!;
    if (w.kind === "needs_google") {
      await upsertEnrichment(
        db,
        lead.id,
        { status: "needs_google", lastError: null, nextRetryAt: null },
        now(),
      );
      result.needsGoogle++;
    } else if (w.kind === "no_website") {
      await upsertEnrichment(
        db,
        lead.id,
        { status: "no_website", lastError: null, nextRetryAt: null, completedAt: now() },
        now(),
      );
      await refreshLeadSummary(db, lead.id, now());
      result.noWebsite++;
    } else targets.push({ lead, url: w.url });
  }

  // 2) Siteye göre grupla: aynı sunucuya giden taramalar ardışık yürür
  const byHost = new Map<string, Map<string, Target[]>>();
  for (const t of targets) {
    const k = siteKey(t.url);
    if (!k) {
      await upsertEnrichment(
        db,
        t.lead.id,
        {
          status: "failed",
          lastError: "bad_url",
          attempts: (enrichment.get(t.lead.id)?.attempts ?? 0) + 1,
          lastAttemptAt: now(),
          nextRetryAt: null,
        },
        now(),
      );
      result.failed++;
      continue;
    }
    const hostMap = byHost.get(k.host) ?? new Map<string, Target[]>();
    hostMap.set(k.key, [...(hostMap.get(k.key) ?? []), t]);
    byHost.set(k.host, hostMap);
    await upsertEnrichment(db, t.lead.id, { status: "running", lastError: null }, now());
  }

  const finishLead = async (t: Target, site: SiteResult): Promise<void> => {
    const prevAttempts = enrichment.get(t.lead.id)?.attempts ?? 0;
    const ts = now();
    result.processed++;
    if (site.outcome === "ok") {
      const rows: NewEmail[] = [];
      for (const e of site.emails) {
        const v = await verifyEmail(e.email, deps.resolver, mxCache);
        rows.push({
          email: e.email,
          sourceType: e.sourceType,
          sourceUrl: e.sourceUrl,
          verifyStatus: v.status,
          verifyReason: v.reason,
          siteHost: site.siteHost,
        });
      }
      let usedExternal = false;
      const usable = () =>
        rows.some(
          (r) => r.verifyStatus !== "invalid" && !isConsumerDomain(parseEmail(r.email)!.domain),
        );
      if (!usable() && deps.external && !externalDisabled) {
        try {
          const hits = (await deps.external.search(site.siteHost))
            .filter((x) => x.confidence === null || x.confidence >= MIN_EXTERNAL_CONFIDENCE)
            .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
            .slice(0, MAX_EXTERNAL_PER_DOMAIN);
          usedExternal = true;
          for (const hit of hits) {
            const p = parseEmail(hit.email);
            if (!p || rows.some((r) => r.email === p.email)) continue;
            const v = await verifyEmail(p.email, deps.resolver, mxCache);
            let src: string | null = null;
            if (hit.sourceUrl) {
              try {
                src = domainMatchesSite(new URL(hit.sourceUrl).hostname, site.siteHost)
                  ? hit.sourceUrl
                  : null;
              } catch {
                src = null;
              }
            }
            rows.push({
              email: p.email,
              sourceType: "external" as EmailSourceType,
              sourceUrl: src,
              verifyStatus: v.status,
              verifyReason: v.reason,
              siteHost: site.siteHost,
            });
          }
        } catch (e) {
          if (e instanceof ExternalProviderError && e.kind !== "bad_response") {
            externalDisabled = e.kind !== "network" ? true : externalDisabled;
            log(`harici servis kullanılamadı (${e.kind}): ${e.message}`);
          } else log(`harici servis hatası: ${(e as Error).message}`);
        }
      }
      await saveEmails(db, t.lead.id, rows, ts);
      await saveContacts(db, t.lead.id, site.contacts, ts);
      await upsertEnrichment(
        db,
        t.lead.id,
        {
          status: "done",
          attempts: prevAttempts + 1,
          lastAttemptAt: ts,
          nextRetryAt: null,
          lastError: site.jsHint && rows.length === 0 ? "js_required" : null,
          pagesFetched: site.pages.length,
          externalUsed: usedExternal,
          completedAt: ts,
        },
        ts,
      );
      if (usedExternal) result.externalUsed++;
      const summary = await refreshLeadSummary(db, t.lead.id, ts);
      if (
        summary.emailStatus &&
        summary.emailStatus !== "not_found" &&
        summary.emailStatus !== "invalid"
      ) {
        result.found++;
        found.add(t.lead.id);
      } else result.notFound++;
      return;
    }
    if (site.outcome === "blocked") {
      result.blocked++;
      await upsertEnrichment(
        db,
        t.lead.id,
        {
          status: "blocked",
          attempts: prevAttempts + 1,
          lastAttemptAt: ts,
          nextRetryAt: null,
          lastError: site.reason,
          pagesFetched: site.pages.length,
        },
        ts,
      );
      await refreshLeadSummary(db, t.lead.id, ts);
      return;
    }
    // failed
    result.failed++;
    const retry = site.retryable && prevAttempts === 0;
    await upsertEnrichment(
      db,
      t.lead.id,
      {
        status: "failed",
        attempts: prevAttempts + 1,
        lastAttemptAt: ts,
        nextRetryAt: retry ? ts + RETRY_DELAY_MS : null,
        lastError: site.reason,
        pagesFetched: site.pages.length,
      },
      ts,
    );
    await refreshLeadSummary(db, t.lead.id, ts);
    if (retry) {
      retryLeads.push(t.lead.id);
      result.retryScheduled++;
    }
  };

  const hostGroups = [...byHost.values()];
  await runPool(
    hostGroups,
    deps.concurrency,
    async (variants) => {
      let first = true;
      for (const group of variants.values()) {
        if (deps.shouldStop?.()) return;
        if (!first) await deps.sleep(deps.delayMs);
        first = false;
        const lang = languageForCountry(group[0]!.lead.countryCode);
        const site = await crawlSite(group[0]!.url, {
          fetch: deps.fetch,
          sleep: deps.sleep,
          userAgent: deps.userAgent,
          agentToken: deps.agentToken,
          delayMs: deps.delayMs,
          maxRequests: deps.maxRequests,
          timeoutMs: deps.timeoutMs,
          language: lang,
          allowPrivate: deps.allowPrivate,
          shouldStop: deps.shouldStop,
        });
        if (site.reason === "stopped") {
          for (const t of group) await upsertEnrichment(db, t.lead.id, { status: "queued" }, now());
          return;
        }
        for (const t of group) await finishLead(t, site);
      }
    },
    deps.shouldStop,
  );
  result.stopped = !!deps.shouldStop?.();
  if (result.stopped) {
    // Durdurulduğunda işlenmeyenler "çalışıyor" görünmesin.
    for (const t of targets) {
      const row = (await getEnrichmentMap(db, [t.lead.id])).get(t.lead.id);
      if (row?.status === "running")
        await upsertEnrichment(db, t.lead.id, { status: "queued" }, now());
    }
  }

  if (retryLeads.length > 0 && opts.scheduleRetry)
    await opts.scheduleRetry(retryLeads, now() + RETRY_DELAY_MS);
  if (found.size > 0) await emitEvent("lead.emailsFound", { leadIds: [...found] });
  return result;
}
