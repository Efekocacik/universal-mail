import { database, HttpError, intParam, json, route, body } from "@/lib/api/http";
import { getLeadDetail } from "@/lib/leads/query";
import { leadPatchSchema, patchLead } from "@/lib/leads/mutations";
import { googleMapsUrl } from "@/lib/places/maps-url";

export const dynamic = "force-dynamic";

/**
 * Lead ayrıntısı. `place`: kalıcı kayıt (yer kimliği, en çok 30 günlük konum, türetilmiş bayraklar).
 * `google`: oturum önbelleğindeki Google içeriği; uygulama yeniden açıldıktan sonra null olur ("Yenile" ile geri yüklenir).
 */
async function detail(id: number) {
  const db = await database();
  const row = await getLeadDetail(db, id);
  if (!row) throw new HttpError(404, "Lead bulunamadı.");
  const { place, cache } = row;
  return {
    lead: row.lead,
    place: place
      ? {
          placeId: place.placeId,
          source: place.source,
          lat: place.lat,
          lng: place.lng,
          wasFuture: place.wasFuture,
          isClosed: place.isClosed,
          firstSeenAt: place.firstSeenAt,
          newDetectedAt: place.newDetectedAt,
          openedDetectedAt: place.openedDetectedAt,
          notFoundInScanId: place.notFoundInScanId,
          mapsUrl: googleMapsUrl(place.placeId, {
            source: place.source,
            lat: place.lat,
            lng: place.lng,
          }),
        }
      : null,
    google: cache
      ? {
          name: cache.name,
          formattedAddress: cache.formattedAddress,
          primaryType: cache.primaryType,
          types: cache.types,
          businessStatus: cache.businessStatus,
          openingDate: cache.openingDate,
          website: cache.website,
          phone: cache.phone,
          intlPhone: cache.intlPhone,
          userRatingCount: cache.userRatingCount,
          fetchedAt: cache.fetchedAt,
          enrichedAt: cache.enrichedAt,
        }
      : null,
  };
}

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  return json(await detail(intParam((await ctx.params).id)));
});

export const PATCH = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const patch = await body(req, leadPatchSchema);
  if (!(await patchLead(db, id, patch))) throw new HttpError(404, "Lead bulunamadı.");
  return json(await detail(id));
});
