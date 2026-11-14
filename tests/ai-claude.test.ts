import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_VERSION,
  buildMessagesBody,
  createClaudeIntroGenerator,
  FALLBACK_BETA,
  INTRO_MAX_TOKENS,
  parseMessagesResponse,
  testClaudeKey,
  type ClaudeFetch,
} from "@/lib/ai/claude";
import { INTRO_SYSTEM_PROMPT } from "@/lib/ai/intro";
import { estimateCostUsd, typicalIntroCostUsd } from "@/lib/ai/pricing";
import { AiError, type IntroContext } from "@/lib/ai/types";

/**
 * Claude istemcisi (ham fetch) — sahte fetch ile: tam başlıklar ve gövde (claude-api başvurusu: 2026-10-21 sürümü,
 * örnekleme parametresi yok, düşük çaba, Opus 5.5'te sunucu tarafı yedek), her stop_reason ve HTTP durumu → hata kodu,
 * kullanım → maliyet. Gerçek API çağrılmaz; anahtar sahte ve hiçbir günlükte görünmez.
 */

const KEY = "sk-test-not-a-real-key-000000";
const ctx: IntroContext = {
  displayName: "Örnek Kahve Evi",
  city: "Leeds",
  categoryLabel: "café",
  language: "en",
  siteExcerpt: null,
  sourceDomain: null,
};

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

function fakeFetch(
  status: number,
  body: unknown,
  opts: { throws?: Error; badJson?: boolean } = {},
) {
  const calls: Call[] = [];
  const fn: ClaudeFetch = async (url, init) => {
    calls.push({ url, ...init });
    if (opts.throws) throw opts.throws;
    return {
      status,
      json: async () => {
        if (opts.badJson) throw new SyntaxError("Unexpected token");
        return body;
      },
    };
  };
  return { fn, calls };
}

const ok = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text },
  ],
  usage: { input_tokens: 1000, output_tokens: 500 },
  ...extra,
});

const GOOD = "We noticed your café in Leeds and would love to introduce our packaging range.";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AiError) return e.code;
    throw e;
  }
  return "OK";
}

describe("Claude istemcisi: istek biçimi", () => {
  it("Opus 5.5: tam başlıklar, düşük çaba, sunucu tarafı yedek; temperature/top_p/top_k/thinking/prefill yok", async () => {
    const { fn, calls } = fakeFetch(200, ok(GOOD));
    const gen = createClaudeIntroGenerator({
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchImpl: fn,
    });
    const r = await gen.generate(ctx);
    expect(r.text).toBe(GOOD);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.method).toBe("POST");
    expect(c.headers).toEqual({
      "x-api-key": KEY,
      "anthropic-version": "2026-10-21",
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    });
    expect(c.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(c.body!);
    expect(Object.keys(body).sort()).toEqual(
      ["fallbacks", "max_tokens", "messages", "model", "output_config", "system"].sort(),
    );
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: INTRO_MAX_TOKENS,
      output_config: { effort: "low" },
      fallbacks: "default",
      system: INTRO_SYSTEM_PROMPT,
    });
    for (const k of ["temperature", "top_p", "top_k", "thinking"])
      expect(body).not.toHaveProperty(k);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user"); // asistan prefill yok
    expect(ANTHROPIC_VERSION).toBe("2026-10-21");
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
  });

  it("Haiku 5.5: sunucu tarafı yedek desteklenmez → beta başlığı ve fallbacks gönderilmez", async () => {
    const { fn, calls } = fakeFetch(200, ok(GOOD, { model: "claude-haiku-5-5" }));
    await createClaudeIntroGenerator({
      apiKey: KEY,
      model: "claude-haiku-5-5",
      fetchImpl: fn,
    }).generate(ctx);
    expect(calls[0]!.headers).not.toHaveProperty("anthropic-beta");
    const body = JSON.parse(calls[0]!.body!);
    expect(body).not.toHaveProperty("fallbacks");
    expect(body.model).toBe("claude-haiku-5-5");
    expect(buildMessagesBody("claude-haiku-5-5", ctx)).not.toHaveProperty("fallbacks");
  });

  it("anahtar sınaması: GET /v1/models/{model}, gövde yok, belirteç harcanmaz", async () => {
    const { fn, calls } = fakeFetch(200, { id: "claude-opus-5-5", type: "model" });
    expect(await testClaudeKey({ apiKey: KEY, model: "claude-opus-5-5", fetchImpl: fn })).toEqual({
      model: "claude-opus-5-5",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/models/claude-opus-5-5",
      method: "GET",
    });
    expect(calls[0]!.body).toBeUndefined();
    const bad = fakeFetch(401, { type: "error", error: { type: "authentication_error" } });
    expect(
      await codeOf(testClaudeKey({ apiKey: KEY, model: "claude-opus-5-5", fetchImpl: bad.fn })),
    ).toBe("AI_AUTH");
  });
});

describe("Claude istemcisi: yanıt ve hata eşlemesi", () => {
  const run = (status: number, body: unknown, opts?: { throws?: Error; badJson?: boolean }) => {
    const logs: string[] = [];
    const { fn } = fakeFetch(status, body, opts);
    const gen = createClaudeIntroGenerator({
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchImpl: fn,
      log: (m) => logs.push(m),
    });
    return { p: codeOf(gen.generate(ctx)), logs };
  };

  it.each<[string, number, unknown, string]>([
    [
      "refusal",
      200,
      ok(GOOD, { stop_reason: "refusal", stop_details: { type: "refusal" } }),
      "AI_REFUSED",
    ],
    ["max_tokens", 200, ok("We noticed", { stop_reason: "max_tokens" }), "AI_TRUNCATED"],
    ["401", 401, { error: { type: "authentication_error" } }, "AI_AUTH"],
    ["403", 403, { error: { type: "permission_error" } }, "AI_AUTH"],
    ["429", 429, { error: { type: "rate_limit_error" } }, "AI_RATE_LIMITED"],
    [
      "400",
      400,
      { error: { type: "invalid_request_error", message: "secret detail" } },
      "AI_UPSTREAM",
    ],
    ["404", 404, { error: { type: "not_found_error" } }, "AI_UPSTREAM"],
    ["500", 500, {}, "AI_UPSTREAM"],
    ["529", 529, { error: { type: "overloaded_error" } }, "AI_UPSTREAM"],
    [
      "kurala uymayan çıktı",
      200,
      ok("Visit https://cafe.example for 20% off since 1999."),
      "AI_OUTPUT_INVALID",
    ],
    ["boş metin", 200, ok(""), "AI_OUTPUT_INVALID"],
  ])("%s → %s", async (_n, status, body, code) => {
    const { p, logs } = run(status, body);
    expect(await p).toBe(code);
    expect(logs.join(" ")).not.toContain(KEY);
    expect(logs.join(" ")).not.toContain("secret detail"); // 400'de yalnızca hata türü günlüğe yazılır
  });

  it("ağ hatası, zaman aşımı ve okunamayan 200 yanıtı → AI_UPSTREAM", async () => {
    expect(await run(0, null, { throws: new TypeError("fetch failed") }).p).toBe("AI_UPSTREAM");
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const t = run(0, null, { throws: timeout });
    expect(await t.p).toBe("AI_UPSTREAM");
    expect(t.logs[0]).toContain("zaman aşımı");
    expect(await run(200, null, { badJson: true }).p).toBe("AI_UPSTREAM");
  });

  it("yalnızca text blokları birleşir; thinking/fallback blokları yok sayılır; tırnaklar ve boşluk sadeleşir", () => {
    const r = parseMessagesResponse("claude-opus-5-5", {
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "IGNORED" },
        { type: "fallback", from: { model: "a" }, to: { model: "b" } },
        { type: "text", text: '  "We noticed your café in Leeds' },
        { type: "text", text: 'and wanted to say hello."\n' },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    expect(r.text).toBe("We noticed your café in Leeds and wanted to say hello.");
    expect(r.text).not.toContain("IGNORED");
    expect(r).toMatchObject({ model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500 });
    expect(r.estCostUsd).toBeCloseTo(0.014, 6); // 1000×4/1M + 500×20/1M
  });

  it("yedek model yanıt verirse tutucu fiyat; kayıttaki model istenen modeldir; eksik kullanım 0 sayılır", () => {
    const r = parseMessagesResponse("claude-opus-5-5", ok(GOOD, { model: "claude-opus-4-8" }));
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.estCostUsd).toBeCloseTo(0.0175, 6); // 1000×5/1M + 500×25/1M
    const z = parseMessagesResponse("claude-haiku-5-5", {
      stop_reason: "end_turn",
      content: [{ type: "text", text: GOOD }],
    });
    expect(z).toMatchObject({ inputTokens: 0, outputTokens: 0, estCostUsd: 0 });
  });
});

describe("fiyat", () => {
  it("Opus 5.5 $4/$20, Haiku 5.5 $0,10/$0,50, demo ücretsiz; geçersiz belirteç 0", () => {
    expect(estimateCostUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBe(24);
    expect(estimateCostUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBe(0.6);
    expect(estimateCostUsd("demo", 5000, 5000)).toBe(0);
    expect(estimateCostUsd("claude-opus-5-5", -5, Number.NaN)).toBe(0);
    expect(typicalIntroCostUsd("claude-opus-5-5")).toBeCloseTo(0.0132, 6);
    expect(typicalIntroCostUsd("claude-haiku-5-5")).toBeLessThan(0.001);
  });
});
