import { json, route, database } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { getSecret } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Arayüzün ihtiyaç duyduğu genel yapılandırma. Harita anahtarı tarayıcıya gider (zaten istemci anahtarıdır). */
export const GET = route(async () => {
  const db = await database();
  const s = await getSettings(db, [
    "maps.mapId",
    "targets.countries",
    "places.provider",
    "novelty.thresholds",
    "ui.language",
  ] as const);
  const setup = await getSetupState(db);
  return json({
    setup,
    provider: s["places.provider"],
    mapsKey: (await getSecret("google.mapsKey")) ?? null,
    mapId: s["maps.mapId"] || "DEMO_MAP_ID",
    targetCountries: s["targets.countries"],
    novelty: s["novelty.thresholds"],
    language: s["ui.language"],
  });
});
