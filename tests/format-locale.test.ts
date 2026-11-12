import { afterEach, describe, expect, it } from "vitest";
import {
  categoryLabel,
  countryLabel,
  fmtDate,
  fmtNumber,
  fmtOpeningDate,
  fmtRelativeDays,
  fmtRelativeTime,
  fmtUsd,
  noveltySignalText,
  typeLabel,
} from "@/lib/client/format";
import { setLocale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";

/** Faz 4 10a-3: biçimlendirme etkin arayüz diline uyar (sayı, para, tarih, göreli zaman, etiketler). */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 12);

describe("dil duyarlı biçimlendirme", () => {
  afterEach(() => setLocale("tr"));

  it("sayı ve para", () => {
    setLocale("tr");
    expect(fmtNumber(1846)).toBe("1.846");
    const trUsd = fmtUsd(12.5);
    expect(trUsd).toContain("12,50");
    setLocale("en");
    expect(fmtNumber(1846)).toBe("1,846");
    expect(fmtUsd(12.5)).toBe("US$12.50");
    expect(fmtUsd(0.032)).toBe("US$0.032");
  });

  it("tarih ve açılış tarihi", () => {
    const ms = Date.UTC(2026, 2, 5, 12);
    setLocale("tr");
    expect(fmtDate(ms)).toMatch(/5 Mar 2026/);
    expect(fmtOpeningDate("2027-03")).toBe("Mart 2027");
    setLocale("en");
    expect(fmtDate(ms)).toBe("5 Mar 2026");
    expect(fmtOpeningDate("2027-03")).toBe("March 2027");
    expect(fmtOpeningDate("2027")).toBe("2027");
    expect(fmtOpeningDate("")).toBe("");
    expect(fmtDate(null)).toBe("—");
  });

  it("göreli zaman: dün / yesterday, dakikalar, saatler", () => {
    setLocale("tr");
    expect(fmtRelativeDays(NOW - DAY, NOW)).toBe("dün");
    expect(fmtRelativeDays(NOW - 3 * DAY, NOW)).toBe("3 gün önce");
    setLocale("en");
    expect(fmtRelativeDays(NOW - DAY, NOW)).toBe("yesterday");
    expect(fmtRelativeDays(NOW, NOW)).toBe("today");
    expect(fmtRelativeTime(NOW - 20_000, NOW)).toBe("this minute");
    expect(fmtRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(fmtRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2 hours ago");
    expect(fmtRelativeTime(NOW - 2 * DAY, NOW)).toBe("2 days ago");
  });

  it("işletme türü, kategori ve ülke etiketleri", () => {
    setLocale("tr");
    expect(typeLabel("cafe")).toBe("Kafe");
    expect(typeLabel("dog_cafe")).toBe("dog cafe");
    expect(typeLabel(null)).toBe("");
    expect(categoryLabel("cafe")).toBe(tr["category.cafe"]);
    expect(categoryLabel("bilinmeyen", "Yedek")).toBe("Yedek");
    expect(categoryLabel(null, "Yedek")).toBe("Yedek");
    expect(countryLabel("DE")).toBe("Almanya");
    setLocale("en");
    expect(typeLabel("cafe")).toBe("Café");
    expect(categoryLabel("cafe")).toBe(en["category.cafe"]);
    expect(countryLabel("DE")).toBe("Germany");
    expect(countryLabel(null)).toBe("");
  });

  it("yenilik gerekçesi: bilinen sinyal yerelleşir, bilinmeyende saklanan metin kalır", () => {
    setLocale("en");
    const known = Object.keys(en).find(
      (k) => k.startsWith("noveltySignal.") && en[k as keyof typeof en]!.includes("{days}"),
    );
    if (known) {
      const id = known.replace("noveltySignal.", "");
      expect(noveltySignalText(id, "saklı", { days: 7 })).toContain("7");
    }
    expect(noveltySignalText("future_opening", "saklı")).toBe(en["noveltySignal.future_opening"]);
    expect(noveltySignalText("yeni_sinyal", "saklanan metin")).toBe("saklanan metin");
  });
});
