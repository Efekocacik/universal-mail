import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCostCap,
  scheduleControlName,
  scheduleWarningText,
  scheduleViewModel,
  SKIP_CODES,
  startScheduleRun,
  type ScheduleItem,
} from "@/lib/client/schedules";
import { ApiError, localizeApiError } from "@/lib/client/api";
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

  it("inceleme: zamanlama uyarısı koda göre yerelleşir; İngilizce arayüzde sunucunun Türkçe metni görünmez", () => {
    const w = {
      code: "COUNTRY_NOT_TARGETED",
      message: "Birleşik Krallık hedef pazarlarınız arasında değil.",
    };
    expect(scheduleWarningText(w, "en")).toMatch(/schedule is saved.*target markets/);
    expect(scheduleWarningText(w, "tr")).toMatch(/^Zamanlama kaydedildi/);
    // Bilinmeyen kod: Türkçede sunucu metni, İngilizcede genel metin (asla ham Türkçe değil).
    const other = { code: "SOMETHING_NEW", message: "Türkçe sunucu iletisi" };
    expect(scheduleWarningText(other, "tr")).toBe("Türkçe sunucu iletisi");
    expect(scheduleWarningText(other, "en")).not.toMatch(/Türkçe/);
  });

  it("inceleme a11y: satır denetimlerinin adları görünür etiketle başlar ve bölgeyi taşır", () => {
    const title = scheduleViewModel(base, NOW, fmt).title;
    const name = scheduleControlName(t("schedules.delete"), title);
    expect(name.startsWith(t("schedules.delete"))).toBe(true); // WCAG 2.5.3: görünür ad içinde
    expect(name).toContain("London");
    // Bileşen: tek tip (bölgesiz) aria-label kalmamalı; her satır denetimi adı scheduleControlName ile kurar.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/features/scans/schedules-section.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/aria-label=\{t\("schedules\./);
    for (const key of ["toggle", "runNow", "delete"])
      expect(src).toContain(`aria-label={named(t("schedules.${key}"))}`);
    expect(src).toContain("aria-labelledby={titleId}");
  });

  it("inceleme: geri alınmış ön onay '$0.00 onaylı' demez, ne yapılacağını söyler ve uyarı tonundadır", () => {
    // Google'a geçişte ön onay 0'a çekilir; kullanıcının eski üst sınırı (2) kayıtta kalır.
    const revoked = scheduleViewModel({ ...base, maxCostUsd: 2, ackMaxUsd: 0 }, NOW, fmt);
    expect(revoked.capRevoked).toBe(true);
    expect(revoked.capLabel).toMatch(/onaylanmış bir tutar yok/);
    expect(revoked.capLabel).not.toMatch(/\$0\.00/);
    const autoRevoked = scheduleViewModel({ ...base, maxCostUsd: null, ackMaxUsd: 0 }, NOW, fmt);
    expect(autoRevoked.capRevoked).toBe(true);
    // Kullanıcı bilerek 0 yazdıysa (yalnızca ücretsiz kota) bu onun sınırıdır, geri alma değil.
    const userZero = scheduleViewModel({ ...base, maxCostUsd: 0, ackMaxUsd: 0 }, NOW, fmt);
    expect(userZero.capRevoked).toBe(false);
    expect(userZero.capLabel).toBe("Tarama başına onaylanan üst sınır: $0.00");
    expect(scheduleViewModel(base, NOW, fmt).capRevoked).toBe(false);
  });

  it("her atlama kodu sade Türkçe nedenle gösterilir; bilinmeyen kod genel metne düşer", () => {
    for (const code of SKIP_CODES) {
      const vm = scheduleViewModel(
        { ...base, lastOutcome: "skipped", lastSkipCode: code },
        NOW,
        fmt,
      );
      expect(vm.outcomeTone).toBe(code === "PREVIOUS_RUN_ACTIVE" ? "ok" : "warning");
      expect(vm.outcomeLabel).toBe(
        code === "PREVIOUS_RUN_ACTIVE"
          ? "Çalışıyor"
          : code.startsWith("SCAN_")
            ? "Duraklatıldı"
            : "Atlandı",
      );
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

describe("şimdi çalıştır akışı (startScheduleRun)", () => {
  const needsAck = (locale: "tr" | "en") => {
    const body = {
      error: "Yüksek tahmin (2.40 USD) kalan bütçenizi (0.01 USD) aşabilir.",
      code: "NEEDS_ACK",
      highUsd: 2.4,
      remainingUsd: 0.01,
    };
    const { message, code } = localizeApiError(409, body, locale);
    return new ApiError(message, 409, code, body);
  };
  const harness = (fail: (ack: boolean) => unknown) => {
    const calls: boolean[] = [];
    const ev: string[] = [];
    const run = async (p: { id: number; acknowledgeRisk: boolean }) => {
      calls.push(p.acknowledgeRisk);
      const e = fail(p.acknowledgeRisk);
      if (e) throw e;
      return { scanId: 42 };
    };
    const on = {
      started: (id: number) => ev.push(`started:${id}`),
      needsAck: (m: string) => ev.push(`ack:${m}`),
      failed: (e: unknown) => ev.push(`failed:${(e as Error).message}`),
    };
    return { calls, ev, run, on };
  };

  it("NEEDS_ACK: onay penceresi açılır, istek kendiliğinden onaylı TEKRARLANMAZ", async () => {
    setLocale("en");
    try {
      const h = harness(() => needsAck("en"));
      await startScheduleRun(h.run, 7, false, h.on);
      expect(h.calls).toEqual([false]);
      expect(h.ev).toHaveLength(1);
      // İngilizce arayüz tutarları yapılandırılmış alanlardan kurar (sunucunun Türkçe metni gösterilmez).
      expect(h.ev[0]).toMatch(/^ack:/);
      expect(h.ev[0]).toContain("$2.40");
      expect(h.ev[0]).not.toContain("Yüksek tahmin");
    } finally {
      setLocale("tr");
    }
  });

  it("onaylı çağrı başarılı: başlatıldı; başarısızsa hata yeniden fırlatılır (pencere hatayı gösterir)", async () => {
    const ok = harness(() => null);
    await startScheduleRun(ok.run, 7, true, ok.on);
    expect(ok.calls).toEqual([true]);
    expect(ok.ev).toEqual(["started:42"]);

    const bad = harness(() => new ApiError("Bütçe doldu", 409, "BUDGET_BLOCKED"));
    await expect(startScheduleRun(bad.run, 7, true, bad.on)).rejects.toBeInstanceOf(ApiError);
    expect(bad.calls).toEqual([true]);
    expect(bad.ev).toEqual(["failed:Bütçe doldu"]);
  });

  it("onaysız çağrıda diğer hatalar fırlatılmaz, bildirim olarak gösterilir", async () => {
    const h = harness(() => new ApiError("Etkin tarama var", 409, "ACTIVE_SCAN"));
    await startScheduleRun(h.run, 7, false, h.on);
    expect(h.calls).toEqual([false]);
    expect(h.ev).toEqual(["failed:Etkin tarama var"]);
  });
});
