import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { API_ERROR_CODES, codeForStatus, ERROR_CODE_RE, toErrorCode } from "@/lib/api/error-codes";
import { body, HttpError, intParam, route } from "@/lib/api/http";
import { api, ApiError, errorText, localizeApiError, NetworkError } from "@/lib/client/api";
import { setLocale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";
import { PlacesApiError } from "@/lib/places/errors";
import { PlanError } from "@/lib/scan/planner";

/** Faz 4 10a-3: kararlı hata kodları (sunucu) ve yerelleştirilmiş hata metni (istemci). */
describe("hata kodu kataloğu", () => {
  it("listedeki her kodun iki dilde de metni vardır ve biçimi geçerlidir", () => {
    const missing: string[] = [];
    for (const c of API_ERROR_CODES) {
      expect(c).toMatch(ERROR_CODE_RE);
      if (!(`apiError.${c}` in tr)) missing.push(`tr:${c}`);
      if (!(`apiError.${c}` in en)) missing.push(`en:${c}`);
    }
    expect(missing).toEqual([]);
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it("HTTP durumundan genel kod", () => {
    expect(codeForStatus(404)).toBe("NOT_FOUND");
    expect(codeForStatus(422)).toBe("BAD_REQUEST");
    expect(codeForStatus(418)).toBe("BAD_REQUEST");
    expect(codeForStatus(507)).toBe("INTERNAL");
    expect(codeForStatus(504)).toBe("UPSTREAM");
  });

  it("toErrorCode serbest değeri güvenli koda çevirir", () => {
    expect(toErrorCode("quota", "PLACES_")).toBe("PLACES_QUOTA");
    expect(toErrorCode("bad-kind x")).toBe("BAD_KIND_X");
    expect(toErrorCode("1abc")).toBe("INTERNAL");
    expect(toErrorCode("a".repeat(100))).toHaveLength(60);
  });
});

describe("route(): her hata yanıtı kararlı bir `code` taşır", () => {
  const req = new Request("http://127.0.0.1/api/x", { method: "POST" });
  const call = async (err: unknown) => {
    const res = await route(async () => {
      throw err;
    })(req, undefined);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("HttpError: verilen kod ya da durumdan türetilen kod; Türkçe `error` korunur", async () => {
    expect(await call(new HttpError(409, "Çakışma", { code: "ACTIVE_SCAN", scanId: 4 }))).toEqual({
      status: 409,
      body: { error: "Çakışma", code: "ACTIVE_SCAN", scanId: 4 },
    });
    expect((await call(new HttpError(404, "Yok"))).body.code).toBe("NOT_FOUND");
    expect(new HttpError(429, "x").code).toBe("RATE_LIMITED");
  });

  it("ZodError → VALIDATION; PlanError → PLAN_INVALID; PlacesApiError → PLACES_<TÜR>", async () => {
    const zerr = z.object({ a: z.number() }).safeParse({ a: "x" }).error!;
    const v = await call(zerr);
    expect(v.status).toBe(400);
    expect(v.body.code).toBe("VALIDATION");
    expect(Array.isArray(v.body.issues)).toBe(true);
    expect((await call(new PlanError("büyük"))).body.code).toBe("PLAN_INVALID");
    const p = await call(new PlacesApiError("quota", "kota"));
    expect(p).toMatchObject({ status: 502, body: { code: "PLACES_QUOTA", kind: "quota" } });
  });

  it("veritabanı meşgul/hazır değil ve beklenmeyen hata", async () => {
    expect((await call(new Error("SQLITE_BUSY: database is locked"))).body.code).toBe("DB_BUSY");
    expect((await call(new Error("no such table: leads"))).body.code).toBe("DB_NOT_READY");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await call(new Error("iç ayrıntı: /Users/x/secret"));
      expect(r.status).toBe(500);
      expect(r.body.code).toBe("INTERNAL");
      expect(JSON.stringify(r.body)).not.toContain("secret");
    } finally {
      spy.mockRestore();
    }
  });

  it("body() bozuk JSON → BAD_JSON; intParam geçersiz → INVALID_ID", async () => {
    const bad = new Request("http://x/", { method: "POST", body: "{bozuk" });
    await expect(body(bad, z.object({}))).rejects.toMatchObject({ status: 400, code: "BAD_JSON" });
    expect(() => intParam("0")).toThrow(HttpError);
    try {
      intParam("abc", "kampanya");
    } catch (e) {
      expect((e as HttpError).code).toBe("INVALID_ID");
    }
    expect(intParam("12")).toBe(12);
  });
});

describe("istemci: yerelleştirilmiş hata metni", () => {
  afterEach(() => {
    setLocale("tr");
    vi.unstubAllGlobals();
  });

  it("Türkçe: sunucunun açıklaması; yoksa kodun metni; o da yoksa HTTP metni", () => {
    expect(localizeApiError(400, { error: "Sunucu metni", code: "BUDGET_BLOCKED" }, "tr")).toEqual({
      message: "Sunucu metni",
      code: "BUDGET_BLOCKED",
    });
    expect(localizeApiError(404, {}, "tr").message).toBe(tr["apiError.NOT_FOUND"]);
    expect(localizeApiError(400, { code: "BILINMEYEN_KOD" }, "tr").message).toBe(
      tr["apiError.HTTP"].replace("{status}", "400"),
    );
  });

  it("İngilizce: Türkçe sunucu metni gösterilmez; kod metni ya da genel metin", () => {
    expect(
      localizeApiError(400, { error: "Bütçe doldu", code: "BUDGET_BLOCKED" }, "en").message,
    ).toBe(en["apiError.BUDGET_BLOCKED"]);
    expect(localizeApiError(409, { error: "x", code: "CAMPAIGN_STALE" }, "en")).toEqual({
      message: en["apiError.generic"],
      code: "CAMPAIGN_STALE",
    });
    expect(localizeApiError(503, {}, "en").code).toBe("UNAVAILABLE");
  });

  it("NEEDS_ACK: tutarlar yapılandırılmış alanlardan, etkin dilin para biçimiyle (İngilizce kullanıcı da görür)", () => {
    const body = {
      error: "Yüksek tahmin (12.40 USD) …",
      code: "NEEDS_ACK",
      highUsd: 12.4,
      remainingUsd: 3,
    };
    const enMsg = localizeApiError(409, body, "en").message;
    expect(enMsg).toContain("US$12.40");
    expect(enMsg).toContain("US$3.00");
    expect(enMsg).not.toMatch(/\{\w+\}/);
    // Türkçede sunucunun kendi (tutarlı) metni önceliklidir; sunucu metni yoksa ayrıntılı Türkçe kalıp.
    expect(localizeApiError(409, body, "tr").message).toBe(body.error);
    const trMsg = localizeApiError(
      409,
      { code: "NEEDS_ACK", highUsd: 12.4, remainingUsd: 3 },
      "tr",
    );
    expect(trMsg.message).toContain("12,40");
    expect(trMsg.message).not.toMatch(/\{\w+\}/);
    // Tutarlar yoksa (eski sunucu) yer tutucusuz genel metne düşülür.
    expect(localizeApiError(409, { code: "NEEDS_ACK" }, "en").message).toBe(
      en["apiError.NEEDS_ACK"],
    );
  });

  it("alan servisi kodları İngilizcede kendi metniyle gösterilir (genel metne düşmez)", () => {
    for (const code of [
      "NOT_CONFIGURED",
      "NO_DOMAIN",
      "NOT_SENDABLE",
      "CHANNEL_KEY_UNREADABLE",
      "PUBLIC_SUFFIX",
      "ACCOUNT_MISMATCH",
    ]) {
      const m = localizeApiError(409, { error: "Türkçe", code }, "en").message;
      expect(m, code).not.toBe(en["apiError.generic"]);
      expect(m, code).toBe(en[`apiError.${code}` as keyof typeof en]);
    }
  });

  it("errorText: ApiError, ağ hatası, beklenmeyen hata", () => {
    const e = new ApiError("Yerel metin", 400, "X", { error: "Sunucu" });
    expect(e.serverMessage).toBe("Sunucu");
    expect(errorText(e, "en")).toBe("Yerel metin");
    const net = new NetworkError("/api/x", { cause: new TypeError("Failed to fetch") });
    expect(net).toBeInstanceOf(TypeError);
    expect(errorText(net, "en")).toBe(en["apiError.NETWORK"]);
    expect(errorText(net, "tr")).toBe(tr["apiError.NETWORK"]);
    // Programlama hatası (TypeError) "sunucuya ulaşılamadı" diye gösterilmez.
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    expect(errorText(bug, "en")).toBe(en["apiError.generic"]);
    expect(errorText(bug, "tr")).toBe(bug.message);
    expect(errorText(new Error("Türkçe iç ileti"), "tr")).toBe("Türkçe iç ileti");
    expect(errorText(new Error("Türkçe iç ileti"), "en")).toBe(en["apiError.generic"]);
    expect(errorText("dize", "tr")).toBe(tr["apiError.generic"]);
  });

  it("api(): hata yanıtı etkin dilde ApiError olur; kod yalnızca sunucu gönderdiyse taşınır", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Bulunamadı" }), { status: 404 })),
    );
    setLocale("en");
    const err = (await api("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(en["apiError.NOT_FOUND"]);
    expect(err.code).toBeUndefined();
    expect(err.serverMessage).toBe("Bulunamadı");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );
    setLocale("tr");
    const err2 = (await api("/api/y").catch((e: unknown) => e)) as ApiError;
    expect(err2.message).toBe(tr["apiError.UPSTREAM"]);
  });

  it("api(): fetch reddi NetworkError olur; iptal (AbortError) olduğu gibi geçer; serileştirme hatası ağ hatası değildir", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const net = await api("/api/x").catch((e: unknown) => e);
    expect(net).toBeInstanceOf(NetworkError);
    expect((net as NetworkError).cause).toBeInstanceOf(TypeError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    const aborted = await api("/api/x").catch((e: unknown) => e);
    expect(aborted).not.toBeInstanceOf(NetworkError);
    expect((aborted as DOMException).name).toBe("AbortError");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ser = await api("/api/x", { method: "POST", json: circular }).catch((e: unknown) => e);
    expect(ser).toBeInstanceOf(TypeError);
    expect(ser).not.toBeInstanceOf(NetworkError);
  });
});
