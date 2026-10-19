import type { Db } from "@/lib/db/client";
import { APP_VERSION } from "@/lib/app/version";
import { getSecret } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";
import { createDemoFetch, createDemoResolver } from "./demo";
import { createHunterProvider, type ExternalEmailProvider } from "./external";
import { safeFetch } from "./safe-fetch";
import type { EmailDeps } from "./service";
import { createSystemResolver } from "./verify";

export const AGENT_TOKEN = "UniversalMail";

/**
 * Kimliği belli User-Agent: robots.txt eşleştirmesi için belirteç + sürüm + (varsa) şirketin web sitesi. Site sahibi
 * bu dizeden taramayı kimin yaptığını ve nasıl ulaşacağını anlayabilir.
 */
export function buildUserAgent(companyWebsite?: string | null): string {
  const site = companyWebsite?.trim();
  const contact =
    site && /^https?:\/\//i.test(site) ? `; +${site}` : site ? `; +https://${site}` : "";
  return `${AGENT_TOKEN}/${APP_VERSION} (B2B business-contact lookup${contact})`;
}

export async function externalProviderFor(
  db: Db,
  requested: boolean,
): Promise<ExternalEmailProvider | null> {
  if (!requested) return null;
  const { "enrichment.external": ext } = await getSettings(db, ["enrichment.external"] as const);
  if (!ext.enabled) return null;
  const key = await getSecret("hunter.apiKey");
  return key ? createHunterProvider(key) : null;
}

/**
 * Üretim bağımlılıkları. Demo sağlayıcıda çevrimdışı sahte web ve DNS kullanılır (gerçek ağa çıkılmaz),
 * Google sağlayıcıda güvenli HTTP istemcisi ve sistem DNS'i. Aralık 1 sn'den az olamaz (gerçek sitelerde).
 */
export async function createEmailDeps(
  db: Db,
  extra: Partial<EmailDeps> & { useExternal?: boolean } = {},
): Promise<EmailDeps> {
  const s = await getSettings(db, [
    "places.provider",
    "company.profile",
    "enrichment.concurrency",
  ] as const);
  const demo = s["places.provider"] === "mock";
  const { useExternal, ...rest } = extra;
  return {
    db,
    fetch: demo ? createDemoFetch() : safeFetch,
    resolver: demo ? createDemoResolver() : createSystemResolver(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    delayMs: demo ? 0 : 1000,
    maxRequests: 6,
    timeoutMs: 10_000,
    concurrency: Math.min(4, Math.max(1, s["enrichment.concurrency"])),
    userAgent: buildUserAgent(s["company.profile"]?.website),
    agentToken: AGENT_TOKEN,
    external: demo ? null : await externalProviderFor(db, !!useExternal),
    ...rest,
  };
}
