import { sql } from "drizzle-orm";
import { database, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { placeCache } from "@/lib/db/cache-schema";
import { places } from "@/lib/db/schema";
import { clearGoogleData, MAX_GOOGLE_RETENTION_DAYS } from "@/lib/places/cache";

export const dynamic = "force-dynamic";

/** Saklanan Google verisinin özeti: oturum önbelleğindeki işletme ve kayıtlı konum sayısı. */
export const GET = route(async () => {
  const db = await database();
  const cache = await db.select({ n: sql<number>`count(*)` }).from(placeCache);
  const coords = await db
    .select({ n: sql<number>`count(*)` })
    .from(places)
    .where(sql`${places.lat} IS NOT NULL`);
  return json({
    cachedPlaces: Number(cache[0]?.n ?? 0),
    storedCoordinates: Number(coords[0]?.n ?? 0),
    maxRetentionDays: MAX_GOOGLE_RETENTION_DAYS,
  });
});

/** "Google verilerini sil": önbellek ve konumlar temizlenir; yer kimlikleri ve kendi kayıtlarımız kalır. */
export const DELETE = route(async () => {
  const db = await database();
  const removed = await clearGoogleData(db);
  await audit(db, "google_data.cleared", "places", undefined, removed);
  return json({ ok: true, ...removed });
});
