import type { Db } from "@/lib/db/client";
import { secretStatus } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";

export interface SetupState {
  completed: boolean;
  consentAccepted: boolean;
  companyComplete: boolean;
  countriesSelected: boolean;
  provider: "google" | "mock";
  placesKeySet: boolean;
  mapsKeySet: boolean;
  /** Tamamlanması gereken adımların insan-okunur listesi. */
  missing: string[];
}

export async function getSetupState(db: Db): Promise<SetupState> {
  const s = await getSettings(db, [
    "setup.completed",
    "consent",
    "company.profile",
    "targets.countries",
    "places.provider",
  ] as const);
  const [places, maps] = await Promise.all([
    secretStatus("google.placesKey"),
    secretStatus("google.mapsKey"),
  ]);
  const provider = s["places.provider"];
  const consentAccepted = s.consent !== null;
  const companyComplete = s["company.profile"] !== null;
  const countriesSelected = s["targets.countries"].length > 0;
  const missing: string[] = [];
  if (!consentAccepted) missing.push("Kullanım onayı");
  if (!companyComplete) missing.push("Gönderen firma bilgileri");
  if (!countriesSelected) missing.push("Hedef ülkeler");
  if (provider === "google" && !places.set) missing.push("Google Places API anahtarı");
  return {
    completed: s["setup.completed"] && missing.length === 0,
    consentAccepted,
    companyComplete,
    countriesSelected,
    provider,
    placesKeySet: places.set,
    mapsKeySet: maps.set,
    missing,
  };
}
