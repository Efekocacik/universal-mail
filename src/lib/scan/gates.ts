import { getSetupState } from "@/lib/app/state";
import { budgetStatus, type BudgetStatus } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import type { RegionInput } from "@/lib/domain/types";
import { bboxCenter } from "@/lib/geo/bbox";
import { nearestCity } from "@/lib/geo/cities";
import { countryName } from "@/lib/geo/countries";
import { getSecret } from "@/lib/secrets/store";
import { getSetting, getSettings } from "@/lib/settings";
import type { ScanEstimate } from "./planner";
import type { GateCode, GateFailure, GateResult } from "./gate-error";
import { estimateForRequest, type ScanRequest } from "./service";

/**
 * Ücretli tarama kapıları (Faz 4: uç noktalardan çıkarıldı). Hem etkileşimli istekler (yeni tarama, "Yeniden tara",
 * "Şimdi çalıştır") hem de arka plan zamanlayıcısı AYNI kuralları kullanır. Burada hiçbir şey fırlatılmaz: sonuç tiplidir
 * (`{ok:false, code}`); `app/api/scans/guard.ts` bunu HttpError'a çevirir, zamanlayıcı atlama koduna.
 *
 * Kodlar (istemci ve bildirim metinleri bu kodları yerelleştirir):
 *  SETUP_REQUIRED        kurulum/kullanım onayı eksik (403)
 *  PLACES_KEY_MISSING    Google sağlayıcısı seçili ama anahtar yok (400)
 *  BUDGET_BLOCKED        aylık bütçe doldu (409)
 *  NEEDS_ACK             yüksek tahmin kalan bütçeyi (veya önceden onaylanan üst sınırı) aşıyor (409)
 *  COUNTRY_NOT_TARGETED  bölgenin ülkesi hedef pazarlarda değil (400)
 *  ACTIVE_SCAN           aynı tarama anahtarıyla sürmekte/duraklatılmış tarama var (409; service.ts denetler)
 */
export {
  ACTIVE_SCAN_MESSAGE,
  GATE_CODES,
  GATE_HTTP_STATUS,
  ScanGateError,
  type GateCode,
  type GateFailure,
  type GateResult,
} from "./gate-error";

const fail = (code: GateCode, message: string): GateFailure => ({ ok: false, code, message });

/** Veri toplama işlevleri kurulum ve kullanım onayı olmadan çalışmaz (FR-SET-08). */
export async function checkCollectionReady(db: Db): Promise<GateResult> {
  const setup = await getSetupState(db);
  if (!setup.consentAccepted)
    return fail("SETUP_REQUIRED", "Önce kurulum sihirbazında kullanım onayını verin.");
  if (!setup.completed)
    return fail("SETUP_REQUIRED", `Kurulumu tamamlayın. Eksik: ${setup.missing.join(", ")}.`);
  return { ok: true };
}

export interface CountryCheck {
  countryCode: string | null;
  blocked: boolean;
  message?: string;
}

/** Bölgenin ülkesi hedef pazarlar dışındaysa uyarır (FR-SET-09). Çizilen alanlarda en yakın şehirden tahmin edilir. */
export async function checkTargetCountry(
  db: Db,
  region: Pick<RegionInput, "bbox"> & { countryCode?: string | null },
): Promise<CountryCheck> {
  const c = bboxCenter(region.bbox);
  const cc =
    (region.countryCode ?? nearestCity(c.lat, c.lng, 80)?.cc ?? null)?.toUpperCase() ?? null;
  const targets = (await getSettings(db, ["targets.countries"] as const))["targets.countries"];
  if (cc && targets.length > 0 && !targets.includes(cc)) {
    return {
      countryCode: cc,
      blocked: true,
      message: `${countryName(cc)} hedef pazarlarınız arasında değil. Taramak için Ayarlar > Hedef pazarlar bölümünden ekleyin.`,
    };
  }
  return { countryCode: cc, blocked: false };
}

export async function budgetSummary(db: Db): Promise<BudgetStatus> {
  const s = await getSettings(db, ["places.provider", "budget.monthlyUsd"] as const);
  return budgetStatus(db, s["places.provider"], s["budget.monthlyUsd"]);
}

export interface PaidScanOptions {
  /** Kullanıcı bu istekte riski açıkça onayladı (yalnızca etkileşimli istekler). */
  acknowledgeRisk?: boolean;
  /**
   * M5: zamanlama oluşturulurken/düzenlenirken kullanıcının ÖNCEDEN onayladığı tarama başına azami tahmini maliyet (USD).
   * Verildiyse kural "yüksek tahmin ≤ onaylanan tutar" olur (kalan bütçeyi aşsa bile; çalıştırıcının bütçe durdurması
   * gerçek harcamayı yine sınırlar). Verilmediyse kural "yüksek tahmin ≤ kalan bütçe" dir.
   */
  ackMaxUsd?: number | null;
}

/** Google sağlayıcısı seçiliyse anahtar tanımlı olmalı (demo sağlayıcıda her zaman geçer). */
export async function checkProviderKey(db: Db): Promise<GateResult> {
  if (
    (await getSetting(db, "places.provider")) === "google" &&
    !(await getSecret("google.placesKey"))
  ) {
    return fail(
      "PLACES_KEY_MISSING",
      "Google Places API anahtarı tanımlı değil. Ayarlar'dan ekleyin.",
    );
  }
  return { ok: true };
}

/**
 * Ücretli tarama kapısı (yeni tarama, "Yeniden tara", zamanlanmış ve "Şimdi çalıştır" için ORTAK). Sağlayıcı ve fiyatlar
 * GÜNCEL ayarlardan okunur (eski taramanın sağlayıcısından değil).
 */
export async function checkPaidScan(
  db: Db,
  request: ScanRequest,
  opts: PaidScanOptions = {},
): Promise<GateResult<{ estimate: ScanEstimate; budget: BudgetStatus }>> {
  const key = await checkProviderKey(db);
  if (!key.ok) return key;
  const { estimate } = await estimateForRequest(db, request);
  const budget = await budgetSummary(db);
  if (budget.level === "blocked")
    return fail("BUDGET_BLOCKED", "Aylık bütçe sınırına ulaşıldı. Ayarlar'dan bütçeyi artırın.");
  const high = estimate.costUsd.high;
  if (!opts.acknowledgeRisk) {
    if (typeof opts.ackMaxUsd === "number") {
      if (high > opts.ackMaxUsd + 1e-9)
        return fail(
          "NEEDS_ACK",
          `Yüksek tahmin (${high.toFixed(2)} USD), bu zamanlama için onayladığınız üst sınırı (${opts.ackMaxUsd.toFixed(2)} USD) aşıyor.`,
        );
    } else if (high > budget.remainingUsd) {
      return fail(
        "NEEDS_ACK",
        `Yüksek tahmin (${high.toFixed(2)} USD) kalan bütçenizi (${budget.remainingUsd.toFixed(2)} USD) aşabilir. Tarama bütçe dolunca otomatik durur. Yine de başlatmak için onaylayın.`,
      );
    }
  }
  return { ok: true, estimate, budget };
}
