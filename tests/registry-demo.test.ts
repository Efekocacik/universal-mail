import { describe, expect, it } from "vitest";
import { createDemoRegistryProvider, generateDemoCompanies } from "@/lib/registry/demo";

/** Demo sicil üreticisi: belirlenimci, pencere içinde, ~%60 türetilmiş / ~%40 yapay, sayfalı (ağsız). */

const UK = {
  scheme: "SIC2007" as const,
  activityCodes: ["56102"],
  incorporatedFrom: "2026-10-16",
  incorporatedTo: "2026-11-15",
  locality: "London",
};
const SYN = /^(BIRCH|COBALT|JUNIPER|MARLOW|PEBBLE|QUILL|ROWAN|TIDAL) /;

describe("generateDemoCompanies", () => {
  it("aynı girdi aynı listeyi verir; dönem değişince liste değişir", async () => {
    const a = await generateDemoCompanies("companies_house", UK, 0);
    const b = await generateDemoCompanies("companies_house", UK, 0);
    expect(a).toEqual(b);
    const c = await generateDemoCompanies("companies_house", UK, 3);
    expect(c.map((x) => x.name)).not.toEqual(a.map((x) => x.name));
  });

  it("GB: kimlikler tekil DEMO######, tarihler pencerede, LTD eki, ~%60/%40", async () => {
    const all = await generateDemoCompanies("companies_house", UK, 0);
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(new Set(all.map((x) => x.externalId)).size).toBe(all.length);
    for (const c of all) {
      expect(c.externalId).toMatch(/^DEMO\d{6}$/);
      expect(c.incorporatedOn >= UK.incorporatedFrom && c.incorporatedOn <= UK.incorporatedTo).toBe(
        true,
      );
      expect(c.name).toMatch(/ LTD$/);
      expect(c).toMatchObject({
        countryCode: "GB",
        activityScheme: "SIC2007",
        activityCodes: ["56102"],
      });
      expect(c.tradingName).toBeNull();
      expect(c.postcode).toMatch(/^EC[1-4]A \d[A-Z]{2}$/);
    }
    const synthetic = all.filter((c) => SYN.test(c.name)).length;
    const share = synthetic / all.length;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.5);
  });

  it("FR: SARL eki, tabela adı, Paris varsayılan, 750xx posta kodu", async () => {
    const all = await generateDemoCompanies(
      "insee",
      { ...UK, scheme: "NAFRev2", activityCodes: ["56.30Z"], locality: null },
      0,
    );
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(c.countryCode).toBe("FR");
      expect(c.name).toMatch(/ SARL$/);
      expect(c.tradingName).toBeTruthy();
      expect(c.postcode).toMatch(/^750\d{2}$/);
    }
  });

  it("kategorisi olmayan kod ve tek günlük pencere", async () => {
    const none = await generateDemoCompanies(
      "companies_house",
      { ...UK, activityCodes: ["01110"] },
      0,
    );
    expect(none).toEqual([]);
    const oneDay = await generateDemoCompanies(
      "companies_house",
      { ...UK, incorporatedFrom: "2026-11-15", incorporatedTo: "2026-11-15" },
      0,
    );
    expect(oneDay.every((c) => c.incorporatedOn === "2026-11-15")).toBe(true);
  });
});

describe("createDemoRegistryProvider", () => {
  it("100'lük sayfalar ve imleç; test() ağsız", async () => {
    const p = createDemoRegistryProvider("companies_house", { getEpoch: () => 0 });
    expect(p).toMatchObject({ source: "companies_house", isDemo: true });
    await expect(p.test()).resolves.toBeUndefined();
    const q = { ...UK, activityCodes: ["56102", "56302", "56101", "55100"], cursor: null };
    const first = await p.search(q);
    const all = await generateDemoCompanies("companies_house", q, 0);
    expect(first.total).toBe(all.length);
    expect(first.items).toHaveLength(Math.min(100, all.length));
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await p.search({ ...q, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.map((c) => c.externalId)).toEqual(all.map((c) => c.externalId));
    // Bozuk imleç baştan başlar; varsayılan dönem 0.
    const bad = await createDemoRegistryProvider("companies_house").search({ ...q, cursor: "x" });
    expect(bad.items[0]!.externalId).toBe(all[0]!.externalId);
  });
});
