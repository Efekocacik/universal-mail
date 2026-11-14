import { buildIntroUserPrompt, INTRO_SYSTEM_PROMPT, validateIntroText } from "./intro";
import { estimateCostUsd } from "./pricing";
import {
  AiError,
  type IntroContext,
  type IntroGenerator,
  type IntroModel,
  type IntroResult,
} from "./types";

/**
 * Claude Messages API istemcisi (ham `fetch`; yeni bağımlılık eklenmez, bu yüzden SDK yok). Başvuru: claude-api
 * becerisi (2026-11):
 *  - `anthropic-version: 2026-10-21` — bu sürümde `temperature`/`top_p`/`top_k` 400 döner; gönderilmez.
 *  - Opus 5.5'te düşünme kapatılamaz (`thinking` parametresi gönderilmez); maliyeti `output_config.effort: "low"`
 *    düşürür. Önceden doldurulmuş asistan yanıtı (prefill) gönderilmez.
 *  - Opus 5.5'te reddetme (`stop_reason: "refusal"`) için sunucu tarafı yedek açık: beta başlığı
 *    `server-side-fallback-2026-07-01` + `fallbacks: "default"`. Haiku 5.5'in sunucu tarafı yedeği yoktur; orada ikisi
 *    de gönderilmez.
 *  - Yanıtta önce `stop_reason` denetlenir; yalnızca `text` blokları birleştirilir (`thinking`/`fallback` yok sayılır).
 *
 * Anahtar yalnızca `x-api-key` başlığında gider; hiçbir hata iletisine, günlüğe veya yanıta yazılmaz.
 */

export const ANTHROPIC_API = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const CLAUDE_TIMEOUT_MS = 30_000;
export const INTRO_MAX_TOKENS = 2048;

/** Sunucu tarafı yedeği destekleyen modeller (claude-api: Opus 5.5 evet, Haiku 5.5 hayır). */
const FALLBACK_MODELS: ReadonlySet<IntroModel> = new Set(["claude-opus-5-5"]);

export type ClaudeFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ClaudeClientOptions {
  apiKey: string;
  model: Exclude<IntroModel, "demo">;
  fetchImpl?: ClaudeFetch;
  timeoutMs?: number;
  /** Tanılama günlüğü (yalnızca hata türü yazılır; anahtar veya metin asla). */
  log?: (msg: string) => void;
}

export function claudeHeaders(apiKey: string, model: IntroModel): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (FALLBACK_MODELS.has(model)) h["anthropic-beta"] = FALLBACK_BETA;
  return h;
}

export function buildMessagesBody(model: IntroModel, ctx: IntroContext): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: INTRO_MAX_TOKENS,
    output_config: { effort: "low" },
    system: INTRO_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildIntroUserPrompt(ctx) }],
  };
  if (FALLBACK_MODELS.has(model)) body.fallbacks = "default";
  return body;
}

/** HTTP durumu → hata kodu (claude-api: 401/403 kimlik, 429 hız, 400/404/413/5xx/529 üst servis). */
export function errorForStatus(status: number): AiError {
  if (status === 401 || status === 403)
    return new AiError("AI_AUTH", "Claude API anahtarı reddedildi.");
  if (status === 429) return new AiError("AI_RATE_LIMITED", "Claude hız sınırına ulaşıldı.");
  return new AiError("AI_UPSTREAM", `Claude yanıt vermedi (HTTP ${status}).`);
}

async function call(
  o: ClaudeClientOptions,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const fetchImpl = o.fetchImpl ?? (fetch as unknown as ClaudeFetch);
  const timeout = AbortSignal.timeout(o.timeoutMs ?? CLAUDE_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${ANTHROPIC_API}${path}`, {
      method,
      headers: claudeHeaders(o.apiKey, o.model),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    const name = (e as Error)?.name;
    o.log?.(`claude ağ hatası: ${name === "TimeoutError" ? "zaman aşımı" : "bağlantı"}`);
    throw new AiError("AI_UPSTREAM", "Claude'a ulaşılamadı.");
  }
  let data: Record<string, unknown> = {};
  try {
    const raw = await res.json();
    if (raw && typeof raw === "object") data = raw as Record<string, unknown>;
  } catch {
    if (res.status >= 200 && res.status < 300)
      throw new AiError("AI_UPSTREAM", "Claude yanıtı okunamadı.");
  }
  if (res.status < 200 || res.status >= 300) {
    const type = (data.error as { type?: unknown } | undefined)?.type;
    o.log?.(`claude HTTP ${res.status}${typeof type === "string" ? ` (${type})` : ""}`);
    throw errorForStatus(res.status);
  }
  return { status: res.status, data };
}

interface MessagesResponse {
  model?: unknown;
  stop_reason?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Yanıtı çözer: önce `stop_reason`, sonra metin blokları, sonra doğrulayıcı. Saf; testler doğrudan çağırır. */
export function parseMessagesResponse(
  requested: IntroModel,
  raw: unknown,
): Omit<IntroResult, "sourceDomain"> {
  const r = (raw ?? {}) as MessagesResponse;
  if (r.stop_reason === "refusal")
    throw new AiError("AI_REFUSED", "Claude bu işletme için giriş yazmadı.");
  if (r.stop_reason === "max_tokens")
    throw new AiError("AI_TRUNCATED", "Claude yanıtı yarıda kesildi.");
  const text = (Array.isArray(r.content) ? r.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(" ");
  const v = validateIntroText(text);
  if (!v.ok) throw new AiError("AI_OUTPUT_INVALID", `Üretilen metin kurala uymadı (${v.issue}).`);
  const inputTokens = num(r.usage?.input_tokens);
  const outputTokens = num(r.usage?.output_tokens);
  // Yedek model yanıt verdiyse onun fiyatı (bilinmiyorsa tutucu fiyat) kullanılır; kayıttaki model istenen modeldir.
  const served = typeof r.model === "string" && r.model ? r.model : requested;
  return {
    text: v.text,
    model: requested,
    inputTokens,
    outputTokens,
    estCostUsd: estimateCostUsd(served, inputTokens, outputTokens),
  };
}

/** Canlı üretici: Messages API'ye tek istek; hata kodları `AiError`. */
export function createClaudeIntroGenerator(o: ClaudeClientOptions): IntroGenerator {
  return {
    model: o.model,
    isDemo: false,
    async generate(ctx, opts) {
      const { data } = await call(
        o,
        "POST",
        "/messages",
        buildMessagesBody(o.model, ctx),
        opts?.signal,
      );
      return { ...parseMessagesResponse(o.model, data), sourceDomain: ctx.sourceDomain };
    },
  };
}

/** Anahtar ve model erişimi denemesi: `GET /v1/models/{model}` (belirteç harcamaz). */
export async function testClaudeKey(o: ClaudeClientOptions): Promise<{ model: string }> {
  const { data } = await call(o, "GET", `/models/${encodeURIComponent(o.model)}`, undefined);
  return { model: typeof data.id === "string" ? data.id : o.model };
}
