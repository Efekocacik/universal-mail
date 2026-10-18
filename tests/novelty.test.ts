import { describe, expect, it } from "vitest";
import { computeNovelty, DEFAULT_NOVELTY_CONFIG } from "@/lib/novelty/score";

const NOW = Date.UTC(2026, 9, 18);
const DAY = 86_400_000;

describe("computeNovelty", () => {
  it("yakında açılacak işletme 100 puan ve mor etiket", () => {
    const r = computeNovelty({
      businessStatus: "FUTURE_OPENING",
      now: NOW,
    });
    expect(r.score).toBe(100);
    expect(r.label).toBe("future_opening");
    expect(r.signals[0]?.reason).toContain("yakında açılacak");
  });

  it("sinyal yoksa düşük", () => {
    const r = computeNovelty({ businessStatus: "OPERATIONAL", now: NOW });
    expect(r).toMatchObject({ score: 0, label: "low", signals: [] });
  });

  it("yeni tespit edilen (snapshot farkı) 70 puan, yüksek etiket", () => {
    const r = computeNovelty({
      businessStatus: "OPERATIONAL",
      newDetectedAt: NOW - 3 * DAY,
      now: NOW,
    });
    expect(r.score).toBe(70);
    expect(r.label).toBe("high");
  });

  it("yeni tespit sinyali pencere dışına çıkınca düşer", () => {
    const r = computeNovelty({
      businessStatus: "OPERATIONAL",
      newDetectedAt: NOW - 90 * DAY,
      now: NOW,
    });
    expect(r.score).toBe(0);
    const wide = computeNovelty(
      { businessStatus: "OPERATIONAL", newDetectedAt: NOW - 90 * DAY, now: NOW },
      { ...DEFAULT_NOVELTY_CONFIG, newWindowDays: 120 },
    );
    expect(wide.score).toBe(70);
  });

  it("geçiş sinyali (90) ile yeni tespit (70) aynı gruptan: yalnızca en yüksek sayılır", () => {
    const r = computeNovelty({
      businessStatus: "OPERATIONAL",
      openedDetectedAt: NOW - DAY,
      newDetectedAt: NOW - DAY,
      now: NOW,
    });
    expect(r.score).toBe(90);
  });

  it("yorum sayısı sinyalleri toplanır ama kendi içinde tek sayılır", () => {
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: 2, now: NOW }).score,
    ).toBe(25);
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: 5, now: NOW }).score,
    ).toBe(25);
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: 6, now: NOW }).score,
    ).toBe(10);
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: 20, now: NOW }).score,
    ).toBe(10);
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: 21, now: NOW }).score,
    ).toBe(0);
    expect(
      computeNovelty({ businessStatus: "OPERATIONAL", userRatingCount: null, now: NOW }).score,
    ).toBe(0);
  });

  it("farklı gruplar toplanır ve 100 ile sınırlanır", () => {
    const r = computeNovelty({
      businessStatus: "OPERATIONAL",
      newDetectedAt: NOW,
      userRatingCount: 1,
      now: NOW,
    });
    expect(r.score).toBe(95);
    const capped = computeNovelty({
      businessStatus: "OPERATIONAL",
      openedDetectedAt: NOW,
      userRatingCount: 1,
      now: NOW,
    });
    expect(capped.score).toBe(100);
  });

  it("eşikler ayarlanabilir", () => {
    const input = { businessStatus: "OPERATIONAL", newDetectedAt: NOW, now: NOW } as const;
    expect(computeNovelty(input, { highAt: 80, likelyAt: 50, newWindowDays: 60 }).label).toBe(
      "likely",
    );
    expect(computeNovelty(input, { highAt: 80, likelyAt: 75, newWindowDays: 60 }).label).toBe(
      "low",
    );
  });

  it("kalıcı olarak kapanan işletme 0 puan", () => {
    const r = computeNovelty({
      businessStatus: "CLOSED_PERMANENTLY",
      newDetectedAt: NOW,
      userRatingCount: 0,
      now: NOW,
    });
    expect(r).toMatchObject({ score: 0, label: "low" });
  });

  it("sonraki faz sinyalleri (sicil, alan adı) ek sinyal olarak eklenir", () => {
    const r = computeNovelty({
      businessStatus: "OPERATIONAL",
      extraSignals: [
        { id: "registry_recent", group: "registry", points: 60, reason: "Sicilde yeni kayıt" },
        { id: "domain_young", group: "domain", points: 20, reason: "Alan adı yeni" },
      ],
      now: NOW,
    });
    expect(r.score).toBe(80);
    expect(r.label).toBe("high");
  });
});
