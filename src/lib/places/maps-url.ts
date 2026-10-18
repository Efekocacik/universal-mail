/**
 * Google Haritalar bağlantısı yer kimliğinden üretilir (Maps URLs: query + query_place_id); bu yüzden Google'dan gelen
 * bir bağlantı alanını saklamaya gerek yoktur. Demo kayıtlarda gerçek yer kimliği olmadığından koordinat araması kullanılır.
 */
export function googleMapsUrl(
  placeId: string,
  opts: { source?: string; lat?: number | null; lng?: number | null } = {},
): string {
  if (opts.source === "demo") {
    return opts.lat != null && opts.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${opts.lat.toFixed(5)},${opts.lng.toFixed(5)}`
      : "https://www.google.com/maps";
  }
  return `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`;
}
