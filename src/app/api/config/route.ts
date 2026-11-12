import { json, route, database } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { getSecret } from "@/lib/secrets/store";
import { getSettings } from "@/lib/settings";
import { effectiveMapId } from "@/lib/settings/map-id";

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
    "ui.theme",
    "notifications.os",
  ] as const);
  const setup = await getSetupState(db);
  return json({
    setup,
    provider: s["places.provider"],
    mapsKey: (await getSecret("google.mapsKey")) ?? null,
    // Geçersiz kayıtlı değer (ör. eskiden kaydedilmiş e-posta) asla Google'a gönderilmez: demo kimliğine düşülür.
    mapId: effectiveMapId(s["maps.mapId"]),
    targetCountries: s["targets.countries"],
    novelty: s["novelty.thresholds"],
    language: s["ui.language"],
    theme: s["ui.theme"],
    // Faz 4: masaüstü işletim sistemi bildirimleri açık mı (Electron ana süreci ve uygulama içi zil okur).
    notificationsOs: s["notifications.os"],
  });
});
