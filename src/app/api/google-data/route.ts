import { database, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { clearGoogleData } from "@/lib/places/cache";
import { googleDataSummary } from "@/lib/scan/google-data";

export const dynamic = "force-dynamic";

/**
 * Saklanan Google verisinin özeti. Eski alanlar (`cachedPlaces`, `storedCoordinates`, `maxRetentionDays`) korunur;
 * Faz 4: `byPolicy` (süresiz place_id / 30 gün koordinat / oturum önbelleği / türetilmiş bayraklar) ve alan düzeyinde
 * `policy` tablosu (kaynak bağlantılarıyla) eklenir.
 */
export const GET = route(async () => {
  const db = await database();
  return json(await googleDataSummary(db, Date.now()));
});

/** "Google verilerini sil": önbellek ve konumlar temizlenir; yer kimlikleri ve kendi kayıtlarımız kalır. */
export const DELETE = route(async () => {
  const db = await database();
  const removed = await clearGoogleData(db);
  await audit(db, "google_data.cleared", "places", undefined, removed);
  return json({ ok: true, ...removed });
});
