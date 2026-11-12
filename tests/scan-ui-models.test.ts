import { describe, expect, it } from "vitest";
import {
  parseCostCap,
  scheduleViewModel,
  SKIP_CODES,
  type ScheduleItem,
} from "@/lib/client/schedules";
import { retentionRows, type GoogleRetentionSummary } from "@/lib/scan/google-data-view";
import { rdapSummary } from "@/lib/novelty/rdap-view";
import { hasTranslation, setLocale, t, type TrKey } from "@/lib/i18n";

const NOW = Date.UTC(2026, 10, 12, 10);
const DAY = 86_400_000;
const fmt = { dateTime: (ms: number) => `T${ms}`, usd: (n: number) => `$${n.toFixed(2)}` };

const base: ScheduleItem = {
  id: 1,
  regionId: 1,
  regionName: "London",
  countryCode: "GB",
  categories: ["Kafe"],
  customKeywords: ["bubble tea"],
  strategy: "text",
  fieldProfile: "discovery",
  intervalDays: 14,
  enabled: true,
  nextRunAt: NOW + 3 * DAY,
  lastRunAt: NOW - 11 * DAY,
  lastScanId: 5,
  lastOutcome: "completed",
  lastSkipCode: null,
  missedRuns: 0,
  maxCostUsd: null,
  ackMaxUsd: 1.5,
  createdAt: NOW - 30 * DAY,
};

describe("zamanlama kartı görünüm modeli", () => {
  it("başlık, aralık, sonraki çalışma, sonuç ve otomatik üst sınır", () => {
    const vm = scheduleViewModel(base, NOW, fmt);
    expect(vm.title).toBe('London · Kafe · "bubble tea"');
    expect(vm.intervalLabel).toBe("İki haftada bir");
    expect(vm.nextLabel).toBe(`T${NOW + 3 * DAY}`);
    expect(vm).toMatchObject({
      overdue: false,
      outcomeTone: "ok",
      skipReason: null,
      missedNote: null,
    });
    expect(vm.capLabel).toMatch(/otomatik.*\$1\.50/);
  });

  it("kapalı, gecikmiş, yakın; kaçırılan çalışma notu; kullanıcı üst sınırı", () => {
    expect(scheduleViewModel({ ...base, enabled: false }, NOW, fmt).nextLabel).toBe("Durduruldu");
    const due = scheduleViewModel({ ...base, nextRunAt: NOW - 1 }, NOW, fmt);
    expect(due.overdue).toBe(true);
    expect(due.nextLabel).toMatch(/Şimdi/);
    expect(scheduleViewModel({ ...base, nextRunAt: NOW + 3600_000 }, NOW, fmt).nextLabel).toMatch(
      /^Yakında: T/,
    );
    const vm = scheduleViewModel({ ...base, missedRuns: 3, maxCostUsd: 2, ackMaxUsd: 2 }, NOW, fmt);
    expect(vm.missedNote).toMatch(/3 çalışma/);
    expect(vm.capLabel).toBe("Tarama başına onaylanan üst sınır: $2.00");
    expect(scheduleViewModel({ ...base, ackMaxUsd: null }, NOW, fmt).capLabel).toBeNull();
  });

  it("her atlama kodu sade Türkçe nedenle gösterilir; bilinmeyen kod genel metne düşer", () => {
    for (const code of SKIP_CODES) {
      const vm = scheduleViewModel(
        { ...base, lastOutcome: "skipped", lastSkipCode: code },
        NOW,
        fmt,
      );
      expect(vm.outcomeTone).toBe("warning");
      expect(vm.skipReason).toBe(t(`schedules.skip.${code}` as TrKey));
      expect(hasTranslation(`schedules.skip.${code}` as TrKey, "en")).toBe(true);
    }
    const other = scheduleViewModel(
      { ...base, lastOutcome: "skipped", lastSkipCode: "PLAN_INVALID" },
      NOW,
      fmt,
    );
    expect(other.skipReason).toBe(t("schedules.skip.other"));
    expect(scheduleViewModel({ ...base, lastOutcome: "failed" }, NOW, fmt).outcomeTone).toBe(
      "danger",
    );
    expect(scheduleViewModel({ ...base, lastOutcome: "started" }, NOW, fmt).outcomeLabel).toBe(
      "Çalışıyor",
    );
    expect(scheduleViewModel({ ...base, lastOutcome: null }, NOW, fmt).outcomeLabel).toBeNull();
  });

  it("İngilizce arayüzde de metin üretilir", () => {
    setLocale("en");
    try {
      expect(scheduleViewModel(base, NOW, fmt).intervalLabel).toBe("Every two weeks");
    } finally {
      setLocale("tr");
    }
  });

  it("üst sınır girişi", () => {
    expect(parseCostCap("")).toEqual({ ok: true, value: null });
    expect(parseCostCap(" 2,456 ")).toEqual({ ok: true, value: 2.46 });
    expect(parseCostCap("-1")).toEqual({ ok: false });
    expect(parseCostCap("abc")).toEqual({ ok: false });
    expect(parseCostCap("10001")).toEqual({ ok: false });
  });
});

describe("ayarlar kartları görünüm modeli", () => {
  it("saklama kartı satırları", () => {
    const s: GoogleRetentionSummary = {
      cachedPlaces: 4,
      storedCoordinates: 7,
      maxRetentionDays: 30,
      termsReviewedAt: "2026-11-12",
      byPolicy: {
        indefinite: { placeIds: 9, dueRefresh: 2, gone: 1, refreshAfterDays: 365 },
        ttl: { coordinates: 7, maxDays: 30 },
        session: { cachedPlaces: 4, maxDays: 30 },
        derived: { flaggedPlaces: 3, maxDays: null, legalReview: "pending" },
      },
      policy: [],
    };
    const rows = retentionRows(s);
    expect(rows.map((r) => r.key)).toEqual(["indefinite", "ttl", "session", "derived"]);
    expect(rows[0]!.rule).toMatch(/365 günde bir/);
    expect(rows[3]!.rule).toMatch(/Süresiz/);
    const limited = retentionRows({
      ...s,
      byPolicy: { ...s.byPolicy, derived: { ...s.byPolicy.derived, maxDays: 180 } },
    });
    expect(limited[3]!.rule).toBe("En çok 180 gün");
  });

  it("RDAP özeti", () => {
    const text = rdapSummary({
      enabled: true,
      demo: false,
      bootstrap: null,
      counts: { ok: 5, pending: 2, error: 1, rate_limited: 1, no_date: 1, unsupported_tld: 2 },
      due: 3,
      lastCheckedAt: null,
    });
    expect(text).toBe(
      "5 alan adının kayıt tarihi biliniyor · 3 sırada · 3 tarih yok · 2 yeniden denenecek",
    );
  });
});
