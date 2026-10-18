import { json, route, database } from "@/lib/api/http";
import { recordUsage } from "@/lib/budget";
import { GooglePlacesClient } from "@/lib/places/client";
import { PlacesApiError } from "@/lib/places/errors";
import { getSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Places API anahtarını test eder (FR-SET-04). Yalnızca `id` alanı istenir: "IDs Only" sınıfı ücretsizdir.
 * Hata türleri (anahtar, faturalandırma, API kapalı, kota) anlaşılır Türkçe mesajlarla döner.
 */
export const POST = route(async () => {
  const db = await database();
  if ((await getSetting(db, "places.provider")) === "mock") {
    return json({ ok: true, message: "Demo modu etkin: Google'a istek atılmaz." });
  }
  const client = new GooglePlacesClient({
    getApiKey: () => getSecret("google.placesKey"),
    maxRetries: 1,
  });
  try {
    const res = await client.searchText({
      textQuery: "cafe",
      bbox: { south: 51.5, west: -0.13, north: 51.51, east: -0.12 },
      fields: ["id"],
      includeFutureOpening: false,
    });
    await recordUsage(db, "google", res.sku, 1);
    return json({ ok: true, message: "Anahtar çalışıyor. Places API (New) erişilebilir." });
  } catch (e) {
    if (e instanceof PlacesApiError) return json({ ok: false, kind: e.kind, message: e.message });
    throw e;
  }
});
