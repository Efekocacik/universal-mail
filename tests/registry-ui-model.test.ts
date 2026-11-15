import { afterEach, describe, expect, it } from "vitest";
import {
  codeLabel,
  companyTitle,
  formatRate,
  isRunActive,
  pickLeadRegistryCompany,
  reasonText,
  runsSignature,
  runErrorText,
  runMatchRate,
  runSummary,
  runTone,
  type RegistryCompanyDto,
  type RegistryRunDto,
} from "@/lib/client/registry";
import { setLocale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";
import { fromSavedPayload, toSavedPayload } from "@/lib/leads/saved-filter-payload";
import { exploreHref, parseExploreLink } from "@/features/explore/deep-link";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  initialExploreFilters,
  toApiFilters,
} from "@/features/explore/filters";

/** Sicil arayüzü saf yardımcıları + keşif "Kaynak" süzgecinin bağlantı/kayıt gidiş-dönüşü. */

afterEach(() => setLocale("tr"));

const run = (o: Partial<RegistryRunDto> = {}): RegistryRunDto =>
  ({
    id: 1,
    source: "companies_house",
    status: "done",
    isDemo: true,
    locality: "London",
    activityScheme: "SIC2007",
    activityCodes: ["56102"],
    windowFrom: "2026-10-16",
    windowTo: "2026-11-15",
    fetchedCount: 20,
    newCount: 20,
    matchedCount: 8,
    unmatchedCount: 12,
    pendingCount: 0,
    errorCode: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: 0,
    ...o,
  }) as RegistryRunDto;

describe("çalışma özeti", () => {
  it("etkinlik, ton, oran", () => {
    expect(isRunActive({ status: "queued" })).toBe(true);
    expect(isRunActive({ status: "running" })).toBe(true);
    expect(isRunActive({ status: "done" })).toBe(false);
    expect(runTone("done")).toBe("success");
    expect(runTone("failed")).toBe("danger");
    expect(runTone("running")).toBe("info");
    expect(runMatchRate(run())).toBe(0.4);
    expect(runMatchRate(run({ matchedCount: 0, unmatchedCount: 0 }))).toBeNull();
    expect(formatRate(null)).toBeNull();
    expect(formatRate(Number.NaN)).toBeNull();
    expect(formatRate(0.4, "en")).toBe("40%");
    expect(formatRate(0.4, "tr")).toMatch(/^%\s?40$/);
  });

  it("bitmiş çalışma oran gösterir; başarısız hata metni; süren ikisini de göstermez", () => {
    const done = runSummary(run());
    expect(done.rate).toContain("40");
    expect(done.error).toBeNull();
    expect(done.window).toContain("2026-10-16");
    const failed = runSummary(run({ status: "failed", errorCode: "REGISTRY_AUTH" }));
    expect(failed.rate).toBeNull();
    expect(failed.error).toBe(tr["registry.error.REGISTRY_AUTH"]);
    expect(runSummary(run({ status: "running" }))).toMatchObject({ rate: null, error: null });
    setLocale("en");
    expect(runSummary(run({ status: "failed", errorCode: "REGISTRY_AUTH" })).error).toBe(
      en["registry.error.REGISTRY_AUTH"],
    );
  });

  it("neden/hata/kod metinleri: bilinmeyen değerler güvenli", () => {
    expect(reasonText(null)).toBe("");
    expect(reasonText("weird")).toBe("");
    expect(reasonText("name_city")).toBe(tr["registry.reason.name_city"]);
    expect(runErrorText(null)).toBeNull();
    expect(runErrorText("NOPE")).toBe(tr["registry.error.REGISTRY_UPSTREAM"]);
    expect(codeLabel("56102")).toBe(tr["registry.code.56102"]);
    expect(codeLabel("99999")).toBe("99999");
  });

  it("şirket başlığı: tabela adı önce", () => {
    expect(companyTitle({ name: "X SARL", tradingName: "Chez X" })).toEqual({
      primary: "Chez X",
      secondary: "X SARL",
    });
    expect(companyTitle({ name: "X LTD", tradingName: null })).toEqual({
      primary: "X LTD",
      secondary: null,
    });
    expect(companyTitle({ name: "X", tradingName: "X" }).secondary).toBeNull();
  });
});

describe("çeviriler", () => {
  it("TR ve EN sicil anahtarları birebir; apiError kodları ikisinde de var", () => {
    const keys = (o: Record<string, string>) =>
      Object.keys(o)
        .filter((k) => k.startsWith("registry.") || k.startsWith("apiError.REGISTRY_"))
        .sort();
    expect(keys(en as Record<string, string>)).toEqual(keys(tr as Record<string, string>));
    for (const code of [
      "REGISTRY_DISABLED",
      "REGISTRY_KEY_MISSING",
      "REGISTRY_RUN_ACTIVE",
      "REGISTRY_MATCH_ACTIVE",
      "REGISTRY_SCHEME_UNAVAILABLE",
      "REGISTRY_ALREADY_LEAD",
      "REGISTRY_MATCHED",
      "REGISTRY_AUTH",
      "REGISTRY_RATE",
      "REGISTRY_UPSTREAM",
    ]) {
      expect((tr as Record<string, string>)[`apiError.${code}`]).toBeTruthy();
      expect((en as Record<string, string>)[`apiError.${code}`]).toBeTruthy();
    }
  });
});

describe("keşif: kaynak süzgeci", () => {
  it("bağlantı çözülür ve geri üretilir; bilinmeyen kaynak atılır", () => {
    const link = parseExploreLink({ source: "registry,nope,import,registry" });
    expect(link.source).toEqual(["registry", "import"]);
    expect(exploreHref(link)).toBe("/?source=registry%2Cimport");
    expect(parseExploreLink({ source: "x" }).source).toBeUndefined();
  });

  it("başlangıç süzgeci, API parametreleri, etkin sayısı", () => {
    const f = initialExploreFilters({ source: ["registry"] });
    expect(f.source).toEqual(["registry"]);
    expect(countActiveFilters(f)).toBe(1);
    expect(toApiFilters(f, null, false)).toMatchObject({
      source: ["registry"],
      registryMatch: undefined,
    });
    const g = { ...EMPTY_FILTERS, registryMatch: false };
    expect(countActiveFilters(g)).toBe(1);
    expect(toApiFilters(g, null, false)).toMatchObject({ source: undefined, registryMatch: false });
    expect(initialExploreFilters().source).toBeUndefined();
  });

  it("kayıtlı süzgeç gidiş-dönüş: kaynak ve sicil eşleşmesi korunur", () => {
    const f = { ...EMPTY_FILTERS, source: ["registry" as const], registryMatch: true };
    const payload = toSavedPayload(f);
    expect(payload).toMatchObject({ source: ["registry"], registryMatch: true });
    expect(fromSavedPayload(payload)!.filters).toMatchObject({
      source: ["registry"],
      registryMatch: true,
    });
    const plain = toSavedPayload(EMPTY_FILTERS);
    expect(plain).not.toHaveProperty("source");
    expect(fromSavedPayload(plain)!.filters).not.toHaveProperty("registryMatch");
    expect(fromSavedPayload({ ...plain, source: ["bogus"] })).toBeNull();
  });
});

describe("yoklama bitişi ve lead rozeti", () => {
  it("çalışma imzası durum/sayaç/eşleştirme değişince değişir (etkin → boşta geçişi yenileme tetikler)", () => {
    expect(runsSignature(undefined)).toBeNull();
    const running = runsSignature({
      runs: [run({ status: "running", matchedCount: 0 })],
      matchActive: false,
    });
    const fetched = runsSignature({
      runs: [run({ status: "done", matchedCount: 0 })],
      matchActive: true,
    });
    const matched = runsSignature({
      runs: [run({ status: "done", matchedCount: 8 })],
      matchActive: false,
    });
    expect(new Set([running, fetched, matched]).size).toBe(3);
    expect(runsSignature({ runs: [run()], matchActive: false })).toBe(
      runsSignature({ runs: [run({ createdAt: 99 })], matchActive: false }),
    );
  });

  it("rozet: sicilden oluşturulan lead (bekliyor) ve eşleşen yer lead'i görünür; ilgisiz kayıt görünmez", () => {
    const c = (o: Partial<RegistryCompanyDto>) =>
      ({ id: 1, leadId: null, matchStatus: "pending", ...o }) as RegistryCompanyDto;
    const created = c({ id: 1, leadId: 7, matchStatus: "pending" });
    expect(pickLeadRegistryCompany([created], 7)).toBe(created);
    const matched = c({ id: 2, matchStatus: "matched" });
    expect(pickLeadRegistryCompany([matched], 9)).toBe(matched);
    expect(pickLeadRegistryCompany([c({ id: 3, matchStatus: "manual" })], 9)?.id).toBe(3);
    expect(pickLeadRegistryCompany([c({ id: 4, matchStatus: "unmatched" })], 9)).toBeNull();
    expect(pickLeadRegistryCompany(undefined, 9)).toBeNull();
  });
});
