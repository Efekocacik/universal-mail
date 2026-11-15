import { describe, expect, it } from "vitest";
import { isAutoResumable, ownRunCodeFor } from "@/lib/scan/pause-codes";

/**
 * Hangi duraklatma kodunun zamanlanmış taramada kullanıcı onayı OLMADAN sürdürülebileceği yalnızca
 * `AUTO_RESUME_PAUSE_CODES` izin listesine bağlıdır. Listeye yanlışlıkla eklenen bir maliyet kodu (CALL_LIMIT, COST_CAP)
 * veya kalıcı sağlayıcı hatası, güvenlik sınırına takılan taramanın her saat kendiliğinden ücretli çağrı yapması demektir.
 */
describe("isAutoResumable / ownRunCodeFor (tablo)", () => {
  const cases: Array<[string | null, boolean]> = [
    ["APP_STOPPED", true],
    ["INTERRUPTED", true],
    ["PROVIDER_QUOTA", true],
    ["PROVIDER_RATE", true],
    ["PROVIDER_NETWORK", true],
    ["PROVIDER_SERVER", true],
    ["CALL_LIMIT", false],
    ["COST_CAP", false],
    ["USER_PAUSED", false],
    ["PROVIDER_CHANGED", false],
    ["PROVIDER_AUTH", false],
    ["PROVIDER_BILLING", false],
    ["PROVIDER_INVALID", false],
    ["PROVIDER_DISABLED", false],
    ["PROVIDER_UNKNOWN", false],
    [null, false], // kullanıcı duraklattı / eski kayıt
  ];
  it.each(cases)("paused + %s → kendiliğinden sürer mi: %s", (code, auto) => {
    expect(isAutoResumable("paused", code)).toBe(auto);
    expect(ownRunCodeFor("paused", code)).toBe(auto ? "SCAN_RETRYING" : "SCAN_PAUSED");
  });
  it("budget_stopped her zaman bütçe kapısına bırakılır; bitmiş/çalışan durumlar sürdürülmez", () => {
    expect(isAutoResumable("budget_stopped", null)).toBe(true);
    expect(ownRunCodeFor("budget_stopped", "BUDGET_BLOCKED")).toBe("SCAN_BUDGET_STOPPED");
    for (const st of ["queued", "running", "completed", "failed", "cancelled"])
      expect(isAutoResumable(st, "APP_STOPPED")).toBe(false);
  });
});
