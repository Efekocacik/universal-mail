import { describe, expect, it } from "vitest";
import { pauseReasonText } from "@/lib/client/pause-reason";
import { hasTranslation, type TrKey } from "@/lib/i18n";
import { PlacesApiError, PLACES_ERROR_KINDS } from "@/lib/places/errors";
import {
  APP_STOPPED,
  BUDGET_STOP_CODE,
  CALL_LIMIT,
  COST_CAP,
  INTERRUPTED,
  PROVIDER_CHANGED,
  providerPauseCode,
  USER_PAUSED,
} from "@/lib/scan/pause-codes";

/**
 * Duraklatma nedeni metni (Faz 5): sunucu `pause_reason`'u Türkçe yazar; İngilizce arayüz bunu GÖSTERMEZ, kararlı
 * `pause_code`'dan `scans.pause.<KOD>` metnini kullanır. Sunucunun yazabileceği her kodun iki dilde de metni vardır.
 */

/** Çalıştırıcı, işçi kurtarması, kullanıcı ve sağlayıcı değişimi tarafından yazılabilen bütün kodlar. */
const SERVER_CODES = [
  USER_PAUSED,
  APP_STOPPED,
  INTERRUPTED,
  CALL_LIMIT,
  COST_CAP,
  BUDGET_STOP_CODE,
  PROVIDER_CHANGED,
  ...PLACES_ERROR_KINDS.filter((k) => new PlacesApiError(k, "x").isPausable).map(providerPauseCode),
];

describe("pauseReasonText", () => {
  it.each(SERVER_CODES)("%s: TR ve EN metni var", (code) => {
    const key = `scans.pause.${code}` as TrKey;
    expect(hasTranslation(key, "tr")).toBe(true);
    expect(hasTranslation(key, "en")).toBe(true);
  });

  it("İngilizce: Türkçe sunucu metni gösterilmez, koddan metin kurulur", () => {
    const scan = { status: "paused", pauseCode: USER_PAUSED, pauseReason: "Siz duraklattınız." };
    expect(pauseReasonText(scan, "en")).toBe("You paused this scan.");
    expect(pauseReasonText(scan, "tr")).toBe("Siz duraklattınız.");
  });

  it("Türkçe: sunucunun ayrıntılı metni (sayılarla) korunur; metin yoksa koddan", () => {
    const capped = {
      status: "paused",
      pauseCode: COST_CAP,
      pauseReason: "Bu zamanlanmış tarama onayladığınız 1.50 USD tutarına ulaştı.",
    };
    expect(pauseReasonText(capped, "tr")).toContain("1.50 USD");
    expect(pauseReasonText({ ...capped, pauseReason: null }, "tr")).toMatch(/onayladığınız tutara/);
  });

  it("eski kayıt (kodsuz) ve bilinmeyen kod: İngilizcede genel metin; neden yoksa null", () => {
    expect(
      pauseReasonText(
        { status: "paused", pauseCode: null, pauseReason: "Eski Türkçe neden" },
        "en",
      ),
    ).toBe("The scan is paused.");
    expect(
      pauseReasonText(
        { status: "paused", pauseCode: "PROVIDER_AUTH", pauseReason: "Anahtar" },
        "en",
      ),
    ).toBe("The scan is paused.");
    expect(
      pauseReasonText({ status: "paused", pauseCode: null, pauseReason: null }, "en"),
    ).toBeNull();
    expect(pauseReasonText({ status: "running", pauseReason: null }, "tr")).toBeNull();
  });

  it("bütçe nedeniyle duran tarama kodsuz da olsa bütçe metni alır", () => {
    expect(
      pauseReasonText({ status: "budget_stopped", pauseCode: null, pauseReason: null }, "en"),
    ).toMatch(/monthly budget/);
  });
});
