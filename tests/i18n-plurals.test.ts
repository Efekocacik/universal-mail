import { describe, expect, it } from "vitest";
import { t, type TrKey } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { enOne } from "@/lib/i18n/en/plurals";
import { tr } from "@/lib/i18n/tr";

/** İnceleme: İngilizce arayüzde "1 new businesses found" gibi tekil/çoğul hataları (en sık durum tek sonuçtur). */

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("İngilizce tekil/çoğul", () => {
  it("en sık bildirimler ve sayaçlar 1 için tekil, 0 ve 2 için çoğul", () => {
    expect(t("notif.scanDone.title", { n: 1 }, "en")).toBe("1 new business found");
    expect(t("notif.scanDone.title", { n: 2 }, "en")).toBe("2 new businesses found");
    expect(t("notif.scanDone.title", { n: 0 }, "en")).toBe("0 new businesses found");
    expect(t("notif.opened.title", { n: 1 }, "en")).toBe("1 business has opened!");
    expect(t("selection.count", { n: 1 }, "en")).toBe("1 business selected");
    expect(t("dash.scans.active", { n: 1 }, "en")).toBe("1 scan is running now.");
    expect(t("schedules.missed", { n: 1 }, "en")).toMatch(/^1 run was missed/);
  });

  it("biçimlenmiş sayı dizesi de tanınır; sayı olmayan değer çoğulda kalır", () => {
    expect(t("list.count", { n: "1" }, "en")).toBe("1 business");
    expect(t("list.count", { n: "1,000" }, "en")).toBe("1,000 businesses");
    expect(t("list.count", { n: "1.5" }, "en")).toBe("1.5 businesses");
    expect(t("list.count", { n: "—" }, "en")).toBe("— businesses");
    expect(t("list.count", { n: "" }, "en")).toBe(" businesses");
  });

  it("Türkçe etkilenmez (isim sayıdan sonra tekil kalır)", () => {
    expect(t("notif.scanDone.title", { n: 1 }, "tr")).toBe(
      tr["notif.scanDone.title"].replace("{n}", "1"),
    );
  });

  it("her tekil biçim var olan bir anahtara ait ve çoğul metinle aynı yer tutucuları taşır", () => {
    for (const [key, one] of Object.entries(enOne)) {
      const plural = en[key as TrKey];
      expect(plural, key).toBeTruthy();
      expect(placeholders(one!), key).toEqual(placeholders(plural));
      expect(one, key).toContain("{n}");
      expect(one, key).not.toBe(plural);
    }
  });

  it("sayılabilir isimli '{n} …' metinlerinin tekil biçimi unutulmaz", () => {
    const nouns =
      "businesses|recipients|scans|campaigns|emails|days|filters|countries|queries|runs|records|domains|notifications|people|follow-ups|sequences|IDs|areas|blocks|characters";
    const countNoun = new RegExp(`\\{n\\}(?: [\\w-]+){0,2} (?:${nouns})\\b`);
    const missing = Object.entries(en)
      .filter(([k, v]) => countNoun.test(v) && !(k in enOne))
      // "{n} lifted" gibi isimsiz sayaçlar ve sıra bildirenler bu deseni zaten tutmaz; bilinçli istisna yok.
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
