import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CH_BASE_URL,
  createCompaniesHouseProvider,
  mapChItem,
} from "@/lib/registry/companies-house";
import { fromProviderError } from "@/lib/registry/errors";
import {
  clip,
  createSpacer,
  isIsoDay,
  parseRetryAfter,
  RETRY_AFTER_CAP_MS,
} from "@/lib/registry/http";
import {
  createInseeProvider,
  inseeLocalityClause,
  inseeQuery,
  INSEE_BASE_URL,
} from "@/lib/registry/insee";
import { RegistryProviderError, registryWindow, type RegistryQuery } from "@/lib/registry/types";

/** Canlı sicil istemcileri: sahte `fetch` + YAPAY fikstürler; gerçek API'ye asla gidilmez. */

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", "registry", name), "utf8");

interface Call {
  url: URL;
  init: RequestInit;
}

function fakeFetch(responses: (Response | Error | ((u: URL) => Response))[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("beklenmeyen istek");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url) : next;
  }) as typeof fetch;
  return { impl, calls };
}

const jsonRes = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });

const query = (over: Partial<RegistryQuery> = {}): RegistryQuery => ({
  scheme: "SIC2007",
  activityCodes: ["56102", "56302"],
  incorporatedFrom: "2026-10-16",
  incorporatedTo: "2026-11-15",
  locality: "London",
  cursor: null,
  ...over,
});

const noSleep = async () => undefined;
const KEY = "test-registry-key-0001";

describe("ortak HTTP yardımcıları", () => {
  it("Retry-After: saniye, HTTP tarihi, üst sınır, bozuk değer", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter("600")).toBe(RETRY_AFTER_CAP_MS);
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000);
    expect(parseRetryAfter(new Date(now - 3000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
  it("tarih ve metin doğrulama", () => {
    expect(isIsoDay("2026-02-28")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("15/10/2026")).toBe(false);
    expect(isIsoDay(20261015)).toBe(false);
    expect(clip("  a   b  ", 10)).toBe("a b");
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip("   ", 3)).toBeNull();
    expect(clip(5, 3)).toBeNull();
  });
  it("aralık bekçisi istekler arasını korur", async () => {
    let now = 1000;
    const waits: number[] = [];
    const spacer = createSpacer({
      minIntervalMs: 500,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await spacer();
    now += 100;
    await spacer();
    expect(waits).toEqual([400]);
  });
  it("pencere: bugün − N gün … bugün (UTC, sabit saat)", () => {
    const now = Date.UTC(2026, 10, 15, 23, 59, 0);
    expect(registryWindow(30, now)).toEqual({ from: "2026-10-16", to: "2026-11-15" });
    expect(() => registryWindow(0, now)).toThrow(RangeError);
  });
  it("sağlayıcı hatası → API kodu", () => {
    expect(fromProviderError(new RegistryProviderError("REGISTRY_AUTH", "x")).status).toBe(400);
    expect(fromProviderError(new RegistryProviderError("REGISTRY_RATE", "x")).status).toBe(429);
    expect(fromProviderError(new RegistryProviderError("REGISTRY_TOO_MANY", "x")).code).toBe(
      "REGISTRY_UPSTREAM",
    );
  });
});

describe("Companies House", () => {
  it("sayfalar, eşler, Basic yetki ve sorgu parametreleri", async () => {
    const f = fakeFetch([jsonRes(fixture("ch-page1.json")), jsonRes(fixture("ch-page2.json"))]);
    const waits: number[] = [];
    const p = createCompaniesHouseProvider({
      getKey: async () => KEY,
      fetchImpl: f.impl,
      sleep: async (ms) => void waits.push(ms),
    });
    const first = await p.search(query());
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe("2");
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toEqual({
      externalId: "00000001",
      name: "QUIETLANE BEAN CAFE LTD",
      tradingName: null,
      countryCode: "GB",
      activityScheme: "SIC2007",
      activityCodes: ["56102"],
      incorporatedOn: "2026-11-02",
      postcode: "EC1A 1ZZ",
      locality: "London",
      addressLine: "12 Example Street",
      registryStatus: "active",
    });
    expect(first.items[1]!.activityCodes).toEqual(["56302"]);

    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe(`${CH_BASE_URL}/advanced-search/companies`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      sic_codes: "56102,56302",
      incorporated_from: "2026-10-16",
      incorporated_to: "2026-11-15",
      company_status: "active",
      size: "100",
      start_index: "0",
      location: "London",
    });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    expect(f.calls[0]!.init.redirect).toBe("error");

    const second = await p.search(query({ cursor: first.nextCursor, locality: null }));
    expect(f.calls[1]!.url.searchParams.get("start_index")).toBe("2");
    expect(f.calls[1]!.url.searchParams.has("location")).toBe(false);
    expect(second.items.map((i) => i.externalId)).toEqual(["00000003"]); // tarihsiz kayıt atlanır
    expect(second.nextCursor).toBeNull();
    expect(waits.length).toBe(1); // ikinci istekten önce ≥ 0,5 sn aralık
  });

  it("404 = sonuç yok; >5000 = REGISTRY_TOO_MANY; boş sayfa imleç üretmez", async () => {
    const f = fakeFetch([
      jsonRes('{"errors":[]}', 404),
      jsonRes(JSON.stringify({ hits: 5001, items: [] })),
      jsonRes(JSON.stringify({ items: [] })),
    ]);
    const p = createCompaniesHouseProvider({
      getKey: async () => KEY,
      fetchImpl: f.impl,
      sleep: noSleep,
    });
    expect(await p.search(query())).toEqual({ items: [], total: 0, nextCursor: null });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_TOO_MANY" });
    expect(await p.search(query())).toEqual({ items: [], total: null, nextCursor: null });
  });

  it("hata eşlemesi: 401 AUTH, 429 RATE (Retry-After), 500 UPSTREAM, 400 BAD_RESPONSE, ağ, bozuk JSON", async () => {
    const f = fakeFetch([
      jsonRes("{}", 401),
      jsonRes("{}", 429, { "Retry-After": "12" }),
      jsonRes("{}", 503),
      jsonRes("{}", 400),
      new TypeError("fetch failed"),
      jsonRes("<html>"),
      jsonRes(JSON.stringify({ hits: "many" })),
    ]);
    const p = createCompaniesHouseProvider({
      getKey: async () => KEY,
      fetchImpl: f.impl,
      sleep: noSleep,
    });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_AUTH" });
    await expect(p.search(query())).rejects.toMatchObject({
      code: "REGISTRY_RATE",
      retryAfterMs: 12_000,
    });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_UPSTREAM" });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_BAD_RESPONSE" });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_UPSTREAM" });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_BAD_RESPONSE" });
    await expect(p.search(query())).rejects.toMatchObject({ code: "REGISTRY_BAD_RESPONSE" });
    await expect(p.search(query({ cursor: "-1" }))).rejects.toMatchObject({
      code: "REGISTRY_BAD_RESPONSE",
    });
  });

  it("anahtar yoksa istek atılmaz; hata metninde anahtar geçmez; test() tek kayıt ister", async () => {
    const f = fakeFetch([jsonRes("{}", 401), jsonRes("{}", 404)]);
    const none = createCompaniesHouseProvider({ getKey: async () => undefined, fetchImpl: f.impl });
    await expect(none.test()).rejects.toMatchObject({ code: "REGISTRY_KEY_MISSING" });
    expect(f.calls).toHaveLength(0);
    const p = createCompaniesHouseProvider({
      getKey: async () => KEY,
      fetchImpl: f.impl,
      sleep: noSleep,
    });
    const err = await p.test().catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    await expect(p.test()).resolves.toBeUndefined(); // 404 (sonuç yok) yetki geçerli demektir
    expect(f.calls[1]!.url.searchParams.get("size")).toBe("1");
  });

  it("eksik alanlı kayıt atlanır", () => {
    expect(
      mapChItem({ company_number: "1", company_name: "X", date_of_creation: "bad" }),
    ).toBeNull();
    expect(mapChItem({ company_name: "X", date_of_creation: "2026-01-01" })).toBeNull();
  });

  it("kullanıcının iptali (signal) yeniden fırlatılır", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fakeFetch([new DOMException("aborted", "AbortError")]);
    const p = createCompaniesHouseProvider({
      getKey: async () => KEY,
      fetchImpl: f.impl,
      sleep: noSleep,
    });
    await expect(p.search(query(), { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("INSEE Sirene", () => {
  const fr = (over: Partial<RegistryQuery> = {}) =>
    query({ scheme: "NAFRev2", activityCodes: ["56.30Z", "56.10A"], locality: "Paris", ...over });

  it("sorgu dili, başlık anahtarı, imleç ve gizlilik süzgeci", async () => {
    const f = fakeFetch([jsonRes(fixture("insee-page.json"))]);
    const p = createInseeProvider({ getKey: async () => KEY, fetchImpl: f.impl, sleep: noSleep });
    const page = await p.search(fr());
    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe(`${INSEE_BASE_URL}/api-sirene/3.11/siret`);
    expect(u.searchParams.get("q")).toBe(
      'periode(activitePrincipaleEtablissement:(56.30Z OR 56.10A)) AND dateCreationEtablissement:[2026-10-16 TO 2026-11-15] AND periode(etatAdministratifEtablissement:A) AND libelleCommuneEtablissement:"PARIS"',
    );
    expect(u.searchParams.get("nombre")).toBe("100");
    expect(u.searchParams.get("curseur")).toBe("*");
    expect(
      (f.calls[0]!.init.headers as Record<string, string>)["X-INSEE-Api-Key-Integration"],
    ).toBe(KEY);
    // Yayılmayan (P) ve şahıs işletmesi (1000) atılır.
    expect(page.items.map((i) => i.externalId)).toEqual(["00000000000011", "00000000000044"]);
    expect(page.items[0]).toMatchObject({
      name: "EXEMPLE BRULERIE SAS",
      tradingName: "Brûlerie Exemple",
      activityCodes: ["56.30Z"],
      postcode: "75011",
      locality: "PARIS",
      addressLine: "7 RUE DE L EXEMPLE",
      registryStatus: "A",
    });
    expect(page.items[1]!.tradingName).toBe("Le Bistrot Fictif");
    expect(page.total).toBe(4);
    expect(page.nextCursor).toBe("AoE-next");
  });

  it("son sayfa: curseurSuivant aynı; 404 boş; >5000; bozuk biçim", async () => {
    const same = JSON.stringify({
      header: { total: 1, curseur: "AoE-next", curseurSuivant: "AoE-next" },
      etablissements: [{}],
    });
    const f = fakeFetch([
      jsonRes(same),
      jsonRes("{}", 404),
      jsonRes(JSON.stringify({ header: { total: 9000 } })),
      jsonRes(JSON.stringify({ etablissements: "x" })),
    ]);
    const p = createInseeProvider({ getKey: async () => KEY, fetchImpl: f.impl, sleep: noSleep });
    expect((await p.search(fr({ cursor: "AoE-next" }))).nextCursor).toBeNull();
    expect(await p.search(fr())).toEqual({ items: [], total: 0, nextCursor: null });
    await expect(p.search(fr())).rejects.toMatchObject({ code: "REGISTRY_TOO_MANY" });
    await expect(p.search(fr())).rejects.toMatchObject({ code: "REGISTRY_BAD_RESPONSE" });
  });

  it("yer süzgeci: posta kodu öneki; ad temizlenir (sorgu dili enjeksiyonu yok)", () => {
    expect(inseeLocalityClause("75011")).toBe("codePostalEtablissement:75011*");
    expect(inseeLocalityClause('Saint-Étienne") OR (x')).toBe(
      'libelleCommuneEtablissement:"SAINT ETIENNE OR X"',
    );
    expect(inseeLocalityClause("***")).toBeNull();
    expect(inseeLocalityClause(null)).toBeNull();
    expect(inseeQuery({ ...fr(), activityCodes: ["56.30Z", "bad)"], locality: null })).toBe(
      "periode(activitePrincipaleEtablissement:(56.30Z)) AND dateCreationEtablissement:[2026-10-16 TO 2026-11-15] AND periode(etatAdministratifEtablissement:A)",
    );
  });

  it("anahtar yok / 403 / test()", async () => {
    const f = fakeFetch([jsonRes("{}", 403), jsonRes("{}", 404)]);
    await expect(
      createInseeProvider({ getKey: async () => undefined, fetchImpl: f.impl }).search(fr()),
    ).rejects.toMatchObject({ code: "REGISTRY_KEY_MISSING" });
    const p = createInseeProvider({ getKey: async () => KEY, fetchImpl: f.impl, sleep: noSleep });
    await expect(p.test()).rejects.toMatchObject({ code: "REGISTRY_AUTH" });
    await expect(p.test()).resolves.toBeUndefined();
  });
});
