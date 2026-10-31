import { describe, expect, it } from "vitest";
import { classifyReasons } from "@/lib/mail/scheduler/dispatcher";
import {
  MAX_ATTEMPTS_PER_STEP,
  MAX_RETRY_AFTER_MS,
  retryDelayMs,
} from "@/lib/mail/scheduler/retry";
import {
  effectiveMailboxCap,
  gapMs,
  nextUtcDayStart,
  warmupCeiling,
  WEEK_MS,
} from "@/lib/mail/scheduler/throttle";
import {
  effectiveWindow,
  isInWindow,
  localParts,
  nextWindowStart,
  timeZonesForCountry,
} from "@/lib/mail/scheduler/window";

/** Zamanlayıcının saf kuralları: pencere, saat dilimi, ısınma, tavan, bekleme ve yeniden deneme. */

const W = effectiveWindow({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" })!;
const LONDON = timeZonesForCountry("GB")!;
const utc = (...a: [number, number, number, number, number?]) =>
  Date.UTC(a[0], a[1] - 1, a[2], a[3], a[4] ?? 0);

describe("gönderim penceresi", () => {
  it("kampanya penceresi yalnızca varsayılanı (hafta içi 09–17) daraltabilir", () => {
    expect(effectiveWindow({ days: [2, 3], start: "10:00", end: "12:30" })).not.toBeNull();
    for (const w of [
      { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" },
      { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
      { days: [1, 6], start: "09:00", end: "17:00" },
      { days: [7], start: "09:00", end: "17:00" },
      { days: [], start: "09:00", end: "17:00" },
      { days: [1], start: "12:00", end: "12:00" },
      { days: [1], start: "9:00", end: "17:00" },
      { days: [1.5], start: "09:00", end: "17:00" },
    ]) {
      expect(effectiveWindow(w), JSON.stringify(w)).toBeNull();
    }
    expect(effectiveWindow(null)).toBeNull();
  });

  it("ülke saat dilimi tablosu; bilinmeyen ülke için null", () => {
    expect(timeZonesForCountry(" gb ")).toEqual(["Europe/London"]);
    expect(timeZonesForCountry("ES")).toHaveLength(2);
    expect(timeZonesForCountry("XX")).toBeNull();
    expect(timeZonesForCountry(null)).toBeNull();
  });

  it("alıcının yerel saatine göre açık/kapalı (bitiş hariç, hafta sonu kapalı)", () => {
    expect(isInWindow(utc(2026, 11, 2, 10), W, LONDON)).toBe(true);
    expect(isInWindow(utc(2026, 11, 2, 8, 59), W, LONDON)).toBe(false);
    expect(isInWindow(utc(2026, 11, 2, 9), W, LONDON)).toBe(true);
    expect(isInWindow(utc(2026, 11, 2, 17), W, LONDON)).toBe(false);
    expect(isInWindow(utc(2026, 11, 7, 12), W, LONDON)).toBe(false); // cumartesi
    // İstanbul UTC+3: 06:00 UTC = 09:00 yerel.
    expect(isInWindow(utc(2026, 11, 2, 6), W, timeZonesForCountry("TR")!)).toBe(true);
    expect(isInWindow(utc(2026, 11, 2, 14), W, timeZonesForCountry("TR")!)).toBe(false);
    expect(isInWindow(utc(2026, 11, 2, 10), W, [])).toBe(false);
  });

  it("yaz saati geçişleri doğru işlenir", () => {
    // 29 Mart 2026: Londra BST'ye geçer. Pazartesi 08:30 UTC = 09:30 yerel.
    expect(isInWindow(utc(2026, 3, 30, 8, 30), W, LONDON)).toBe(true);
    // Önceki cuma 08:30 UTC = 08:30 yerel (kapalı).
    expect(isInWindow(utc(2026, 3, 27, 8, 30), W, LONDON)).toBe(false);
    expect(localParts(utc(2026, 3, 30, 8, 30), "Europe/London")).toEqual({
      weekday: 1,
      minutes: 9 * 60 + 30,
    });
  });

  it("birden çok saat dilimli ülkede pencere tüm dilimlerde açık olmalı (kesişim)", () => {
    const es = timeZonesForCountry("ES")!;
    // Kasım: Madrid UTC+1, Kanarya UTC+0.
    expect(isInWindow(utc(2026, 11, 2, 8, 30), W, es)).toBe(false); // Kanarya 08:30
    expect(isInWindow(utc(2026, 11, 2, 9), W, es)).toBe(true);
    expect(isInWindow(utc(2026, 11, 2, 15, 59), W, es)).toBe(true);
    expect(isInWindow(utc(2026, 11, 2, 16), W, es)).toBe(false); // Madrid 17:00
  });

  it("bir sonraki açılış: asla erken değil; hafta sonunu atlar", () => {
    expect(nextWindowStart(utc(2026, 11, 2, 10), W, LONDON)).toBe(utc(2026, 11, 2, 10));
    expect(nextWindowStart(utc(2026, 11, 6, 17), W, LONDON)).toBe(utc(2026, 11, 9, 9));
    expect(nextWindowStart(utc(2026, 11, 7, 3, 17), W, LONDON)).toBe(utc(2026, 11, 9, 9));
    const odd = utc(2026, 11, 2, 7, 3) + 1234;
    const n = nextWindowStart(odd, W, LONDON)!;
    expect(n).toBeGreaterThanOrEqual(utc(2026, 11, 2, 9));
    expect(n - utc(2026, 11, 2, 9)).toBeLessThanOrEqual(5 * 60_000);
    expect(nextWindowStart(odd, W, [])).toBeNull();
  });
});

describe("ısınma, günlük tavan, bekleme", () => {
  const T = utc(2026, 11, 2, 10);
  it("ısınma eğrisi yalnızca tavandır: 20 + haftalık adım, en fazla 80", () => {
    expect(warmupCeiling({ warmupStep: 10, warmupStartedAt: null }, T)).toBe(20);
    expect(warmupCeiling({ warmupStep: 10, warmupStartedAt: T }, T + WEEK_MS - 1)).toBe(20);
    expect(warmupCeiling({ warmupStep: 10, warmupStartedAt: T }, T + WEEK_MS)).toBe(30);
    expect(warmupCeiling({ warmupStep: 10, warmupStartedAt: T }, T + 30 * WEEK_MS)).toBe(80);
    expect(warmupCeiling({ warmupStep: 0, warmupStartedAt: T }, T + 30 * WEEK_MS)).toBe(20);
    expect(warmupCeiling({ warmupStep: 99, warmupStartedAt: T }, T + WEEK_MS)).toBe(30);
    expect(warmupCeiling({ warmupStep: 10, warmupStartedAt: T + 1 }, T)).toBe(20);
  });

  it("geçerli tavan: kutu tavanı, ısınma ve 80'in en küçüğü (otomatik artış yok)", () => {
    const m = { dailyCap: 20, warmupStep: 10, warmupStartedAt: T };
    expect(effectiveMailboxCap(m, T + 10 * WEEK_MS)).toBe(20);
    expect(effectiveMailboxCap({ ...m, dailyCap: 50 }, T + 2 * WEEK_MS)).toBe(40);
    expect(effectiveMailboxCap({ ...m, dailyCap: 50 }, T)).toBe(20);
    expect(effectiveMailboxCap({ ...m, dailyCap: 500 }, T + 99 * WEEK_MS)).toBe(80);
  });

  it("bekleme 90–240 s aralığında, deterministik ve yayılmış", () => {
    const values = Array.from({ length: 2000 }, (_, i) => gapMs(i + 1, 90, 240));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(90_000);
    expect(Math.max(...values)).toBeLessThanOrEqual(240_000);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(120_000);
    expect(gapMs(42, 90, 240)).toBe(gapMs(42, 90, 240));
    expect(gapMs(7, 10, 20)).toBeGreaterThanOrEqual(90_000); // alt sınır zorunlu
    expect(gapMs(7, 120, 120)).toBe(120_000);
  });

  it("günlük sınırlar UTC gününe göre sıfırlanır", () => {
    expect(nextUtcDayStart(utc(2026, 11, 2, 23, 59))).toBe(utc(2026, 11, 3, 0));
    expect(nextUtcDayStart(utc(2026, 11, 3, 0))).toBe(utc(2026, 11, 4, 0));
  });
});

describe("yeniden deneme politikası", () => {
  it("kalıcı ret asla; geçici ret adım başına en fazla 3 deneme", () => {
    expect(MAX_ATTEMPTS_PER_STEP).toBe(3);
    expect(retryDelayMs(1, true)).toBeNull();
    expect(retryDelayMs(1, false)).toBe(15 * 60_000);
    expect(retryDelayMs(2, false)).toBe(2 * 3_600_000);
    expect(retryDelayMs(3, false)).toBeNull();
    expect(retryDelayMs(9, false)).toBeNull();
    expect(retryDelayMs(0, false)).toBeNull();
    expect(retryDelayMs(1.5, false)).toBeNull();
  });

  it("sağlayıcının bildirdiği bekleme süresi dikkate alınır (üst sınırlı)", () => {
    expect(retryDelayMs(1, false, 3_600_000)).toBe(3_600_000);
    expect(retryDelayMs(1, false, 60_000)).toBe(15 * 60_000);
    expect(retryDelayMs(1, false, 99 * 3_600_000)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryDelayMs(1, false, Number.NaN)).toBe(15 * 60_000);
    expect(retryDelayMs(1, true, 60_000)).toBeNull();
  });
});

describe("uygunsuzluk sınıflandırması (ertele / çıkar / duraklat)", () => {
  const now = utc(2026, 11, 2, 10);
  it("sistem/yapılandırma nedenleri kampanyayı duraklatır", () => {
    expect(classifyReasons([{ code: "suppressed" }, { code: "consent_missing" }], now)).toEqual({
      action: "pause",
    });
    expect(classifyReasons([{ code: "mailbox_not_ready" }], now).action).toBe("pause");
  });

  it("kampanya bu arada kapandıysa hiçbir şey değişmez", () => {
    expect(classifyReasons([{ code: "campaign_not_active" }], now).action).toBe("skip");
  });

  it("yalnızca kesin ve kalıcı nedenler diziyi sonlandırır", () => {
    for (const code of [
      "suppressed",
      "country_blocked",
      "email_consumer",
      "reply_received",
    ] as const) {
      expect(classifyReasons([{ code }], now).action, code).toBe("exclude");
    }
  });

  it("belirsiz veya sistem kaynaklı hata varsa dışlanmaz, kısa ertelenir", () => {
    expect(classifyReasons([{ code: "suppressed" }, { code: "evaluation_error" }], now)).toEqual({
      action: "defer",
      retryAt: now + 15 * 60_000,
    });
    expect(classifyReasons([], now)).toEqual({ action: "defer", retryAt: now + 15 * 60_000 });
  });

  it("geçici veya sınıflandırılamayan nedenler ertelenir (bildirilen ana veya 1 gün)", () => {
    expect(classifyReasons([{ code: "domain_daily_cap", until: now + 5_000_000 }], now)).toEqual({
      action: "defer",
      retryAt: now + 5_000_000,
    });
    for (const code of [
      "email_not_verified",
      "already_sent",
      "unresolved_delivery",
      "cross_campaign_gap",
      "step_missing",
    ] as const) {
      expect(classifyReasons([{ code }], now), code).toEqual({
        action: "defer",
        retryAt: now + 86_400_000,
      });
    }
  });
});
