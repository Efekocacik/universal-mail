import { json, route } from "@/lib/api/http";
import { cityBBox, defaultRadiusKm, searchCities } from "@/lib/geo/cities";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const countries = sp
    .get("cc")
    ?.split(",")
    .filter(Boolean)
    .map((c) => c.toUpperCase());
  const limit = Math.min(Number(sp.get("limit")) || 15, 50);
  const cities = searchCities(sp.get("q") ?? "", { countries, limit }).map((c) => {
    const radiusKm = defaultRadiusKm(c.pop);
    return {
      id: c.id,
      name: c.name,
      cc: c.cc,
      lat: c.lat,
      lng: c.lng,
      pop: c.pop,
      radiusKm,
      bbox: cityBBox(c, radiusKm),
    };
  });
  return json({ cities });
});
