import { and, desc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { auditLog, campaignLeads, leadEnrichment, leadIntros, leads } from "@/lib/db/schema";
import { RobotsPolicy } from "@/lib/email/robots";
import type { FetchFn } from "@/lib/email/safe-fetch";
import { categoryLabel } from "@/lib/mail/render-context";
import { wakeDispatchSafely } from "@/lib/mail/scheduler/job";
import { suggestLanguage } from "@/lib/mail/language";
import { registrableDomain } from "@/lib/novelty/rdap";
import { checkCollectionReady } from "@/lib/scan/gates";
import { getSecret } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";
import { createClaudeIntroGenerator } from "./claude";
import { createDemoIntroGenerator, validateIntroText, visibleTextExcerpt } from "./intro";
import { modelChangeNeedsCostAck } from "./pricing";
import {
  AiError,
  type AiBilledUsage,
  type AiErrorCode,
  type IntroContext,
  type IntroGenerator,
  type IntroLanguage,
  type IntroModel,
} from "./types";

/**
 * Kişisel giriş iş akışı (Faz 5 paket A). Üretim YALNIZCA taslak yazar; taslak ancak kullanıcı "Onayla" dediğinde
 * `{{kisisel_giris}}` değeri olur (bkz. render-context.ts). Her (lead, dil) için en çok bir onaylı giriş vardır
 * (kısmi tekil dizin); onay, varsa öncekini aynı işlemde "rejected"e indirir.
 *
 * Kapılar (sırayla): lead var → kurulum/kullanım onayı → `ai.intro.enabled` → (canlıda) maliyet onayı + anahtar →
 * yeterli bağlam → hız sınırları → aynı (lead, dil) için süren üretim yok. Demo (`places.provider = "mock"`) ağa
 * çıkmaz, anahtar ve maliyet onayı istemez, ücretsizdir.
 */

export type IntroErrorCode =
  | AiErrorCode
  | "NOT_FOUND"
  | "SETUP_REQUIRED"
  | "AI_DISABLED"
  | "AI_KEY_MISSING"
  | "AI_COST_ACK_REQUIRED"
  | "AI_NO_CONTEXT"
  | "INTRO_TEXT_INVALID"
  | "RATE_LIMITED"
  | "CONFLICT";

export const INTRO_ERROR_STATUS: Readonly<Record<IntroErrorCode, number>> = {
  NOT_FOUND: 404,
  SETUP_REQUIRED: 403,
  AI_DISABLED: 400,
  AI_KEY_MISSING: 400,
  AI_COST_ACK_REQUIRED: 409,
  AI_NO_CONTEXT: 422,
  INTRO_TEXT_INVALID: 400,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  AI_AUTH: 400,
  AI_RATE_LIMITED: 429,
  AI_UPSTREAM: 502,
  AI_REFUSED: 422,
  AI_TRUNCATED: 502,
  AI_OUTPUT_INVALID: 422,
};

export class IntroError extends Error {
  constructor(
    readonly code: IntroErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntroError";
  }
  get status(): number {
    return INTRO_ERROR_STATUS[this.code];
  }
}

/** Maliyet ve kötüye kullanım sınırları: bir lead için saatte 5, canlı Claude için toplamda saatte 60 üretim. */
export const INTRO_LIMITS = { perLeadPerHour: 5, livePerHour: 60, listLimit: 20 } as const;
const HOUR = 3_600_000;

export interface LeadIntroDto {
  id: number;
  leadId: number;
  language: IntroLanguage;
  text: string;
  status: "draft" | "approved" | "rejected";
  model: IntroModel;
  sourceDomain: string | null;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  createdAt: number;
  approvedAt: number | null;
}

type IntroRow = typeof leadIntros.$inferSelect;

export function toIntroDto(r: IntroRow): LeadIntroDto {
  return {
    id: r.id,
    leadId: r.leadId,
    language: r.language as IntroLanguage,
    text: r.text,
    status: r.status,
    model: r.model,
    sourceDomain: r.sourceDomain,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    estCostUsd: r.estCostUsd,
    createdAt: r.createdAt,
    approvedAt: r.approvedAt,
  };
}

/* ------------------------------- bağlam ------------------------------- */

export interface LeadIntroBase {
  leadId: number;
  countryCode: string | null;
  siteDomain: string | null;
  ctx: Omit<IntroContext, "siteExcerpt" | "sourceDomain">;
}

/**
 * Bağlam YALNIZCA `leads` (kullanıcının görünen adı, GeoNames şehri, kendi kategori anahtarımız) ve kendi taramamızın
 * `lead_enrichment.site_domain` alanından okunur. Google oturum önbelleği bilerek okunmaz.
 */
export async function loadIntroBase(
  db: DbExecutor,
  leadId: number,
  language?: IntroLanguage,
): Promise<LeadIntroBase | null> {
  const [row] = await db
    .select({
      displayName: leads.displayName,
      city: leads.city,
      categoryKey: leads.categoryKey,
      countryCode: leads.countryCode,
      siteDomain: leadEnrichment.siteDomain,
    })
    .from(leads)
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) return null;
  const lang = language ?? suggestLanguage(row.countryCode);
  return {
    leadId,
    countryCode: row.countryCode,
    siteDomain: row.siteDomain,
    ctx: {
      displayName: row.displayName?.trim() || null,
      city: row.city?.trim() || null,
      categoryLabel: categoryLabel(row.categoryKey, lang),
      language: lang,
    },
  };
}

export interface SiteFetchDeps {
  fetch: FetchFn;
  userAgent: string;
  agentToken: string;
  timeoutMs?: number;
}

/** Kayıtlı alan adı; son etiket harfle başlar (IP adresi kabul edilmez). */
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$/;

/**
 * İşletmenin KENDİ ana sayfasından görünür metin (en çok 3000 karakter). Güvenli HTTP istemcisi (iç ağ engeli,
 * boyut/zaman sınırı) ve robots.txt kuralları geçerlidir; robots okunamazsa veya ana sayfayı yasaklıyorsa metin
 * alınmaz. Yönlendirme yalnızca aynı kayıtlı alan adı içinde izlenir. Her hata sessizce "metin yok" demektir:
 * giriş yine ad/şehir/kategoriyle üretilir.
 *
 * `site_domain` kayıtlı alan adıdır; birçok küçük işletme sitesi yalnızca `www.` altında yayındadır (çıplak alan
 * adının A kaydı veya sertifikası yok). Çıplak alan adına HİÇ ulaşılamazsa (ağ/DNS/TLS/zaman aşımı) aynı adımlar
 * `www.<alan>` üzerinde (kendi robots.txt'siyle) denenir. Çıplak alan adı yanıt verdiyse (robots yasağı dahil) karar
 * onundur; `www` denenmez.
 */
export async function fetchSiteExcerpt(
  domain: string,
  deps: SiteFetchDeps,
): Promise<{ excerpt: string; domain: string } | null> {
  const d = domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) return null;
  const sameSite = (_from: URL, to: URL) => registrableDomain(to.hostname) === d;
  const opts = {
    userAgent: deps.userAgent,
    timeoutMs: deps.timeoutMs ?? 10_000,
    allowRedirect: sameSite,
  };
  const hosts = d.startsWith("www.") ? [d] : [d, `www.${d}`];
  for (const host of hosts) {
    let robots;
    try {
      robots = await deps.fetch(`https://${host}/robots.txt`, opts);
    } catch {
      continue; // bu ana bilgisayara ulaşılamadı: sıradakini dene
    }
    try {
      let policy = RobotsPolicy.allowAll();
      if (robots.status === 401 || robots.status === 403 || robots.status >= 500) return null;
      if (robots.status === 200 && !robots.skippedBody)
        policy = RobotsPolicy.parse(robots.body, deps.agentToken);
      if (!policy.isAllowed("/")) return null;
      const home = await deps.fetch(`https://${host}/`, opts);
      if (home.status < 200 || home.status >= 300 || home.skippedBody || !home.body) return null;
      const excerpt = visibleTextExcerpt(home.body);
      return excerpt ? { excerpt, domain: d } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/* ------------------------------- üretim ------------------------------- */

export interface GenerateDeps {
  /** Testler: canlı üretici yerine sahte. Verilmezse ayara göre demo veya Claude seçilir. */
  generator?: IntroGenerator;
  /** Canlı kipte site metni; verilmezse site metni kullanılmaz. */
  site?: SiteFetchDeps | null;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Aynı (lead, dil) için eşzamanlı ikinci üretimi (çift tıklama) engeller; süreç içi kilit yeterlidir (tek sunucu). */
const inFlight = new Set<string>();

/** Faturalanmış başarısız üretimlerin denetim eylemi (red, kesik, kural dışı çıktı: belirteç harcandı, satır yok). */
export const BILLED_FAILURE_ACTION = "ai.intro.failed";

/**
 * Faturalanmış başarısız üretimler (`audit_log`, `detail.billed = true`): hız sınırlarına ve aylık kullanıma sayılır;
 * böylece "Yeniden oluştur"a art arda basmak sınırsız ücretli çağrı yapamaz ve maliyet kartında görünür.
 */
async function billedFailures(
  db: DbExecutor,
  from: number,
  to: number,
  leadId?: number,
): Promise<{ n: number; inputTokens: number; outputTokens: number; estUsd: number }> {
  const [r] = await db
    .select({
      n: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(json_extract(${auditLog.detail}, '$.inputTokens')), 0)`,
      outputTokens: sql<number>`coalesce(sum(json_extract(${auditLog.detail}, '$.outputTokens')), 0)`,
      estUsd: sql<number>`coalesce(sum(json_extract(${auditLog.detail}, '$.estCostUsd')), 0)`,
    })
    .from(auditLog)
    .where(
      and(
        gte(auditLog.at, from),
        lt(auditLog.at, to),
        eq(auditLog.action, BILLED_FAILURE_ACTION),
        eq(auditLog.entity, "lead"),
        sql`json_extract(${auditLog.detail}, '$.billed') = 1`,
        ...(leadId === undefined ? [] : [eq(auditLog.entityId, String(leadId))]),
      ),
    );
  return {
    n: Number(r?.n ?? 0),
    inputTokens: Number(r?.inputTokens ?? 0),
    outputTokens: Number(r?.outputTokens ?? 0),
    estUsd: Number(r?.estUsd ?? 0),
  };
}

export async function aiMode(db: DbExecutor): Promise<{
  enabled: boolean;
  demo: boolean;
  model: Exclude<IntroModel, "demo">;
  costAckAt: number | null;
  costAckModel: Exclude<IntroModel, "demo"> | null;
}> {
  const s = await getSettings(db, ["ai.intro", "places.provider"] as const);
  return {
    enabled: s["ai.intro"].enabled,
    demo: s["places.provider"] === "mock",
    model: s["ai.intro"].model,
    costAckAt: s["ai.intro"].costAckAt,
    costAckModel: s["ai.intro"].costAckModel ?? null,
  };
}

type GateCode = "AI_DISABLED" | "AI_COST_ACK_REQUIRED" | "AI_KEY_MISSING";
const GATE_MESSAGE: Record<GateCode, string> = {
  AI_DISABLED: "Yapay zekâ girişi kapalı.",
  AI_COST_ACK_REQUIRED: "Önce maliyet notunu onaylayın.",
  AI_KEY_MISSING: "Claude API anahtarı girilmemiş.",
};

/**
 * Ayar kapıları (saf): kapalı → AI_DISABLED; demo → serbest; canlıda maliyet onayı yoksa AI_COST_ACK_REQUIRED (ayar
 * şeması bunu zaten engeller; bu ikinci savunma hattıdır), anahtar yoksa AI_KEY_MISSING.
 */
export function aiGate(
  mode: {
    enabled: boolean;
    demo: boolean;
    costAckAt: number | null;
    model?: Exclude<IntroModel, "demo">;
    costAckModel?: Exclude<IntroModel, "demo"> | null;
  },
  hasKey: boolean,
): GateCode | null {
  if (!mode.enabled) return "AI_DISABLED";
  if (mode.demo) return null;
  if (mode.costAckAt === null) return "AI_COST_ACK_REQUIRED";
  // Onay modele bağlıdır (sunucu damgalar): onay modeli bilinmiyorsa (Faz 5 öncesi kayıt) veya onay daha ucuz bir model
  // için verildiyse canlı üretim yeni onay ister (istemcideki pencerenin sunucu karşılığı).
  if (!mode.costAckModel) return "AI_COST_ACK_REQUIRED";
  if (mode.model && modelChangeNeedsCostAck(mode.costAckModel, mode.model))
    return "AI_COST_ACK_REQUIRED";
  if (!hasKey) return "AI_KEY_MISSING";
  return null;
}

export async function generateLeadIntro(
  db: Db,
  leadId: number,
  language: IntroLanguage | undefined,
  deps: GenerateDeps = {},
): Promise<LeadIntroDto> {
  const now = deps.now ?? Date.now;
  const base = await loadIntroBase(db, leadId, language);
  if (!base) throw new IntroError("NOT_FOUND", "Lead bulunamadı.");
  const ready = await checkCollectionReady(db);
  if (!ready.ok) throw new IntroError("SETUP_REQUIRED", ready.message);
  const mode = await aiMode(db);
  const apiKey = mode.enabled && !mode.demo ? await getSecret("anthropic.apiKey") : null;
  const gate = aiGate(mode, !!deps.generator || !!apiKey);
  if (gate) throw new IntroError(gate, GATE_MESSAGE[gate]);

  let generator = deps.generator ?? null;
  if (!generator && !mode.demo && apiKey)
    generator = createClaudeIntroGenerator({ apiKey, model: mode.model, log: deps.log });
  generator ??= createDemoIntroGenerator();

  const { ctx } = base;
  if (!ctx.displayName && !ctx.city && !ctx.categoryLabel)
    throw new IntroError("AI_NO_CONTEXT", "Bu işletme için yeterli bilgi yok.");

  const t = now();
  const [perLead] = await db
    .select({ n: sql<number>`count(*)` })
    .from(leadIntros)
    .where(and(eq(leadIntros.leadId, leadId), gte(leadIntros.createdAt, t - HOUR)));
  const leadFailed = await billedFailures(db, t - HOUR, Number.MAX_SAFE_INTEGER, leadId);
  if (Number(perLead?.n ?? 0) + leadFailed.n >= INTRO_LIMITS.perLeadPerHour)
    throw new IntroError("RATE_LIMITED", "Bu işletme için çok sık giriş üretildi.");
  if (!generator.isDemo) {
    const [live] = await db
      .select({ n: sql<number>`count(*)` })
      .from(leadIntros)
      .where(and(gte(leadIntros.createdAt, t - HOUR), ne(leadIntros.model, "demo")));
    const liveFailed = await billedFailures(db, t - HOUR, Number.MAX_SAFE_INTEGER);
    if (Number(live?.n ?? 0) + liveFailed.n >= INTRO_LIMITS.livePerHour)
      throw new IntroError("RATE_LIMITED", "Saatlik yapay zekâ sınırına ulaşıldı.");
  }

  const recordFailure = (code: AiErrorCode, usage: AiBilledUsage | null) =>
    audit(
      db,
      BILLED_FAILURE_ACTION,
      "lead",
      leadId,
      {
        language: ctx.language,
        model: generator.model,
        code,
        billed: usage !== null,
        ...(usage ?? {}),
      },
      now(),
    );

  const lockKey = `${leadId}:${ctx.language}`;
  if (inFlight.has(lockKey)) throw new IntroError("CONFLICT", "Bu giriş zaten hazırlanıyor.");
  inFlight.add(lockKey);
  try {
    const site =
      !generator.isDemo && deps.site && base.siteDomain
        ? await fetchSiteExcerpt(base.siteDomain, deps.site)
        : null;
    let result;
    try {
      result = await generator.generate({
        ...ctx,
        siteExcerpt: site?.excerpt ?? null,
        sourceDomain: site?.domain ?? null,
      });
    } catch (e) {
      if (e instanceof AiError) {
        await recordFailure(e.code, generator.isDemo ? null : e.usage);
        throw new IntroError(e.code, e.message);
      }
      throw e;
    }
    // Üretici ne döndürürse döndürsün, kayda yalnızca doğrulayıcıdan geçen metin girer.
    const v = validateIntroText(result.text);
    if (!v.ok) {
      const spent = result.inputTokens + result.outputTokens > 0 && !generator.isDemo;
      await recordFailure(
        "AI_OUTPUT_INVALID",
        spent
          ? {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              estCostUsd: result.estCostUsd,
            }
          : null,
      );
      throw new IntroError("AI_OUTPUT_INVALID", "Üretilen metin kurala uymadı.");
    }
    const ts = now();
    const [row] = await db
      .insert(leadIntros)
      .values({
        leadId,
        language: ctx.language,
        text: v.text,
        status: "draft",
        model: result.model,
        sourceDomain: result.sourceDomain,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estCostUsd: result.estCostUsd,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await audit(db, "ai.intro.generated", "lead", leadId, {
      introId: row!.id,
      language: ctx.language,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estCostUsd: result.estCostUsd,
      withSiteText: result.sourceDomain !== null,
    });
    return toIntroDto(row!);
  } finally {
    inFlight.delete(lockKey);
  }
}

/* ----------------------------- liste ve inceleme ----------------------------- */

/**
 * Lead'in en yeni `listLimit` girişi ARTI (pencere dışında kalmış olsa da) onaylı girişleri: `{{kisisel_giris}}` onaylıyı
 * kullanır, panel de onu göstermeli (çok sayıda yeniden üretim/red sonrasında bile). Dil başına en çok bir onaylı vardır
 * (`lead_intros_approved_uq`), yani liste en çok `listLimit + dil sayısı` satırdır; yeniden eskiye sıralı.
 */
export async function listLeadIntros(db: DbExecutor, leadId: number): Promise<LeadIntroDto[]> {
  const recent = await db
    .select()
    .from(leadIntros)
    .where(eq(leadIntros.leadId, leadId))
    .orderBy(desc(leadIntros.id))
    .limit(INTRO_LIMITS.listLimit);
  const approved = await db
    .select()
    .from(leadIntros)
    .where(and(eq(leadIntros.leadId, leadId), eq(leadIntros.status, "approved")));
  const byId = new Map(recent.map((r) => [r.id, r]));
  for (const r of approved) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id).map(toIntroDto);
}

export async function leadExists(db: DbExecutor, leadId: number): Promise<boolean> {
  const [r] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1);
  return !!r;
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    const err = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (
      /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(
        `${String(err.code ?? "")} ${String(err.message ?? "")}`,
      )
    )
      return true;
    cur = err.cause;
  }
  return false;
};

export type IntroAction = "approve" | "reject" | "save";

/**
 * İnceleme: `save` metni değiştirir ve taslağa döndürür (onaylıysa onayı kalkar); `approve` (isteğe bağlı yeni metinle)
 * aynı (lead, dil) için önceki onaylıyı "rejected"e indirip bunu onaylar; `reject` reddeder. Metin her zaman üretimle
 * AYNI doğrulayıcıdan geçer. Hepsi tek işlemdedir; yarışan iki onayda tekil dizin ikinciyi CONFLICT ile durdurur.
 */
export async function updateLeadIntro(
  db: Db,
  leadId: number,
  introId: number,
  input: { action: IntroAction; text?: string },
  now: () => number = Date.now,
): Promise<LeadIntroDto> {
  let text: string | undefined;
  if (input.text !== undefined) {
    const v = validateIntroText(input.text);
    if (!v.ok) throw new IntroError("INTRO_TEXT_INVALID", `Giriş metni geçersiz (${v.issue}).`);
    text = v.text;
  } else if (input.action === "save") {
    throw new IntroError("INTRO_TEXT_INVALID", "Kaydedilecek metin yok.");
  }
  const ts = now();
  let wake = false;
  try {
    const dto = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(leadIntros)
        .where(and(eq(leadIntros.id, introId), eq(leadIntros.leadId, leadId)))
        .limit(1);
      if (!row) throw new IntroError("NOT_FOUND", "Giriş bulunamadı.");
      if (input.action === "approve") {
        const finalText = text ?? row.text;
        // Eski (kural değişmeden önce kaydedilmiş) metinler de onaydan önce yeniden denetlenir.
        if (!validateIntroText(finalText).ok)
          throw new IntroError("INTRO_TEXT_INVALID", "Giriş metni geçersiz.");
        await tx
          .update(leadIntros)
          .set({ status: "rejected", approvedAt: null, updatedAt: ts })
          .where(
            and(
              eq(leadIntros.leadId, leadId),
              eq(leadIntros.language, row.language),
              eq(leadIntros.status, "approved"),
              ne(leadIntros.id, introId),
            ),
          );
        const [u] = await tx
          .update(leadIntros)
          .set({
            text: finalText,
            status: "approved",
            approvedAt: row.status === "approved" && text === undefined ? row.approvedAt : ts,
            updatedAt: ts,
          })
          .where(eq(leadIntros.id, introId))
          .returning();
        // Onay bekleyen giriş yüzünden ertelenmiş diziler (dağıtıcı `intro_pending`, +60 dk) hemen sıraya döner;
        // gönderim penceresi, günlük tavan ve aralık kuralları dağıtıcıda yine uygulanır.
        const woken = await tx
          .update(campaignLeads)
          .set({ nextSendAt: ts, updatedAt: ts })
          .where(
            and(
              eq(campaignLeads.leadId, leadId),
              eq(campaignLeads.lastError, "intro_pending"),
              inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
              gt(campaignLeads.nextSendAt, ts),
            ),
          )
          .returning({ id: campaignLeads.id });
        wake = woken.length > 0;
        return u!;
      }
      const [u] = await tx
        .update(leadIntros)
        .set(
          input.action === "reject"
            ? { status: "rejected", approvedAt: null, updatedAt: ts, ...(text ? { text } : {}) }
            : { status: "draft", approvedAt: null, updatedAt: ts, text: text! },
        )
        .where(eq(leadIntros.id, introId))
        .returning();
      return u!;
    });
    await audit(db, `ai.intro.${input.action}`, "lead", leadId, {
      introId,
      language: dto.language,
      edited: text !== undefined,
    });
    // İşlem dışında: uyandırma başarısız olsa da onay geçerlidir (worker bakımı işi en geç birkaç dakikada kurar).
    if (wake) await wakeDispatchSafely(db, { now: ts, source: "ai.intro.approve" });
    return toIntroDto(dto);
  } catch (e) {
    if (isUniqueViolation(e))
      throw new IntroError("CONFLICT", "Bu dil için başka bir giriş aynı anda onaylandı.");
    throw e;
  }
}

/* ------------------------------- kullanım ------------------------------- */

export interface AiUsage {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estUsd: number;
}

/**
 * Bu (UTC) ayın Claude kullanımı: canlı üretimler (demo satırları ücretsizdir ve istek değildir) ARTI faturalanmış ama
 * kullanılamayan yanıtlar (red, kesik, kural dışı çıktı; `audit_log`).
 */
export async function aiUsage(db: DbExecutor, now: number = Date.now()): Promise<AiUsage> {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const [r] = await db
    .select({
      requests: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${leadIntros.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${leadIntros.outputTokens}), 0)`,
      estUsd: sql<number>`coalesce(sum(${leadIntros.estCostUsd}), 0)`,
    })
    .from(leadIntros)
    .where(
      and(
        gte(leadIntros.createdAt, start),
        lt(leadIntros.createdAt, end),
        ne(leadIntros.model, "demo"),
      ),
    );
  const f = await billedFailures(db, start, end);
  return {
    month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    requests: Number(r?.requests ?? 0) + f.n,
    inputTokens: Number(r?.inputTokens ?? 0) + f.inputTokens,
    outputTokens: Number(r?.outputTokens ?? 0) + f.outputTokens,
    estUsd: Math.round((Number(r?.estUsd ?? 0) + f.estUsd) * 1e4) / 1e4,
  };
}
