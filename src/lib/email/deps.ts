import type { Db } from "@/lib/db/client";
import { APP_VERSION } from "@/lib/app/version";
import { getSecret } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";
import { createDemoFetch, createDemoResolver } from "./demo";
import {
  createDemoExternalProvider,
  createHunterProvider,
  createSnovProvider,
  type ExternalEmailProvider,
  type ExternalProviderId,
} from "./external";
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

export interface ExternalStatus {
  enabled: boolean;
  provider: ExternalProviderId;
  /** Seçili sağlayıcının anahtar(lar)ı girilmiş mi (Snov: istemci kimliği VE sırrı). */
  configured: boolean;
  /** Demo kipi (`places.provider = "mock"`): ağsız demo sağlayıcı, anahtar gerekmez. */
  demo: boolean;
  /** Bu aramada kullanılabilir mi: açık ve (demo veya anahtarlı). */
  available: boolean;
}

/** Harici e-posta servisinin durumu: ayarlar ekranı, e-posta bulma ön izlemesi ve sınama ucu aynı kuralı kullanır. */
export async function externalStatus(db: Db): Promise<ExternalStatus> {
  const s = await getSettings(db, ["enrichment.external", "places.provider"] as const);
  const ext = s["enrichment.external"];
  const demo = s["places.provider"] === "mock";
  const configured =
    ext.provider === "snov"
      ? !!(await getSecret("snov.clientId")) && !!(await getSecret("snov.clientSecret"))
      : !!(await getSecret("hunter.apiKey"));
  return {
    enabled: ext.enabled,
    provider: ext.provider,
    configured,
    demo,
    available: ext.enabled && (demo || configured),
  };
}

/**
 * Seçili sağlayıcının istemcisi (anahtarlar yalnızca gizli depodan). Demo kipinde ağsız demo sağlayıcı. Anahtar
 * eksikse null.
 */
export async function createExternalProvider(
  provider: ExternalProviderId,
  demo: boolean,
): Promise<ExternalEmailProvider | null> {
  if (demo) return createDemoExternalProvider(provider);
  if (provider === "snov") {
    const clientId = await getSecret("snov.clientId");
    const clientSecret = await getSecret("snov.clientSecret");
    return clientId && clientSecret ? createSnovProvider({ clientId, clientSecret }) : null;
  }
  const key = await getSecret("hunter.apiKey");
  return key ? createHunterProvider(key) : null;
}

export async function externalProviderFor(
  db: Db,
  requested: boolean,
): Promise<ExternalEmailProvider | null> {
  if (!requested) return null;
  const st = await externalStatus(db);
  if (!st.available) return null;
  return createExternalProvider(st.provider, st.demo);
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
    // Faz 5: demo kipinde de harici servis seçilebilir (ağsız demo sağlayıcı, yalnızca `.example` alan adları).
    external: await externalProviderFor(db, !!useExternal),
    ...rest,
  };
}
