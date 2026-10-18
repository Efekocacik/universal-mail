import { HttpError } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { budgetStatus } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { bboxCenter } from "@/lib/geo/bbox";
import { nearestCity } from "@/lib/geo/cities";
import { countryName } from "@/lib/geo/countries";
import { getSettings } from "@/lib/settings";
import type { ScanRequestBody } from "./schema";

/** Veri toplama işlevleri kurulum ve kullanım onayı olmadan çalışmaz (FR-SET-08). */
export async function requireCollectionReady(db: Db): Promise<void> {
  const setup = await getSetupState(db);
  if (!setup.consentAccepted)
    throw new HttpError(403, "Önce kurulum sihirbazında kullanım onayını verin.", {
      code: "SETUP_REQUIRED",
    });
  if (!setup.completed)
    throw new HttpError(403, `Kurulumu tamamlayın. Eksik: ${setup.missing.join(", ")}.`, {
      code: "SETUP_REQUIRED",
    });
}

/** Bölgenin ülkesi hedef pazarlar dışındaysa uyarır (FR-SET-09). Çizilen alanlarda en yakın şehirden tahmin edilir. */
export async function checkTargetCountry(
  db: Db,
  region: ScanRequestBody["region"],
): Promise<{ countryCode: string | null; blocked: boolean; message?: string }> {
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

export async function budgetSummary(db: Db) {
  const s = await getSettings(db, ["places.provider", "budget.monthlyUsd"] as const);
  return budgetStatus(db, s["places.provider"], s["budget.monthlyUsd"]);
}
