import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { placeCache } from "@/lib/db/cache-schema";
import { leads, places } from "@/lib/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";
import { buildWhere, type LeadFilters } from "@/lib/leads/query";
import { googleMapsUrl } from "@/lib/places/maps-url";

/**
 * CSV dışa aktarma. Alanlar KAYNAĞINA göre ayrılır (SRS 8.1):
 *  - "own": uygulamanın veya kullanıcının ürettiği alanlar (skor, durum, not, etiket, yer kimliği)
 *  - "google": Google Places'ten gelen içerik (ad, adres, koordinat, web sitesi, telefon...)
 * Google alanları varsayılan olarak DAHİL EDİLMEZ; kullanıcı bilinçli olarak açmalıdır. Google alanları yalnızca oturum
 * önbelleğinde (ve en çok 30 günlük koordinatlarda) bulunur; yüklü olmayan satırlarda boş çıkar.
 */
export type FieldOrigin = "own" | "google";

export interface CsvColumn {
  key: string;
  header: string;
  origin: FieldOrigin;
}

export const CSV_COLUMNS: readonly CsvColumn[] = [
  { key: "lead_id", header: "lead_id", origin: "own" },
  { key: "place_id", header: "place_id", origin: "own" },
  { key: "novelty_score", header: "yenilik_skoru", origin: "own" },
  { key: "novelty_label", header: "yenilik_etiketi", origin: "own" },
  { key: "novelty_reasons", header: "yenilik_nedenleri", origin: "own" },
  { key: "lead_status", header: "lead_durumu", origin: "own" },
  { key: "tags", header: "etiketler", origin: "own" },
  { key: "notes", header: "notlar", origin: "own" },
  { key: "source", header: "kaynak", origin: "own" },
  { key: "first_seen", header: "ilk_tespit", origin: "own" },
  { key: "detected_new", header: "yeni_tespit_tarihi", origin: "own" },
  { key: "display_name", header: "gorunen_ad", origin: "own" },
  { key: "category", header: "kategori", origin: "own" },
  { key: "city", header: "sehir_tahmini", origin: "own" },
  { key: "country", header: "ulke_tahmini", origin: "own" },
  { key: "maps_url", header: "google_haritalar_baglantisi", origin: "own" },
  { key: "name", header: "ad", origin: "google" },
  { key: "address", header: "adres", origin: "google" },
  { key: "lat", header: "enlem", origin: "google" },
  { key: "lng", header: "boylam", origin: "google" },
  { key: "type", header: "tur", origin: "google" },
  { key: "business_status", header: "isletme_durumu", origin: "google" },
  { key: "opening_date", header: "beklenen_acilis", origin: "google" },
  { key: "website", header: "web_sitesi", origin: "google" },
  { key: "phone", header: "telefon", origin: "google" },
  { key: "rating_count", header: "degerlendirme_sayisi", origin: "google" },
];

/**
 * CSV enjeksiyonunu önler: Excel/Sheets, `= + - @` ile başlayan hücreleri formül sayar. Dış kaynaklı
 * metinler (işletme adları) bu karakterlerle başlayabileceğinden başına `'` eklenir.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function selectColumns(includeGoogleFields: boolean): CsvColumn[] {
  return CSV_COLUMNS.filter((c) => includeGoogleFields || c.origin === "own");
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

/** Filtreye uyan lead'leri sayfa sayfa CSV parçaları olarak üretir (UTF-8 BOM ile, Excel uyumlu). */
export async function* exportLeadsCsv(
  db: Db,
  filters: LeadFilters,
  opts: { includeGoogleFields: boolean },
): AsyncGenerator<string> {
  const cols = selectColumns(opts.includeGoogleFields);
  yield "﻿" + cols.map((c) => csvCell(c.header)).join(",") + "\r\n";

  const where = await buildWhere(db, filters);
  let lastId = 0;
  let count = 0;
  for (;;) {
    const cond = where ? and(where, gt(leads.id, lastId)) : gt(leads.id, lastId);
    const rows = await db
      .select({ lead: leads, place: places, cache: placeCache })
      .from(leads)
      .innerJoin(places, eq(leads.placeId, places.placeId))
      .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
      .where(cond)
      .orderBy(asc(leads.id))
      .limit(1000);
    if (rows.length === 0) break;
    let chunk = "";
    for (const { lead, place, cache } of rows) {
      const values: Record<string, unknown> = {
        lead_id: lead.id,
        place_id: place.placeId,
        novelty_score: lead.noveltyScore,
        novelty_label: lead.noveltyLabel,
        novelty_reasons: lead.noveltySignals.map((s) => s.reason).join(" | "),
        lead_status: lead.status,
        tags: lead.tags.join(";"),
        notes: lead.notes ?? "",
        source: lead.source,
        first_seen: iso(place.firstSeenAt),
        detected_new: iso(place.newDetectedAt),
        display_name: lead.displayName,
        category: lead.categoryKey,
        city: lead.city,
        country: lead.countryCode,
        maps_url: googleMapsUrl(place.placeId, {
          source: place.source,
          lat: place.lat,
          lng: place.lng,
        }),
        name: cache?.name,
        address: cache?.formattedAddress,
        lat: place.lat,
        lng: place.lng,
        type: cache?.primaryType,
        business_status: cache?.businessStatus,
        opening_date: cache?.openingDate,
        website: cache?.website,
        phone: cache?.phone,
        rating_count: cache?.userRatingCount,
      };
      chunk += cols.map((c) => csvCell(values[c.key])).join(",") + "\r\n";
      count++;
    }
    lastId = rows[rows.length - 1]!.lead.id;
    yield chunk;
  }
  await audit(db, "export.leads", "leads", undefined, {
    rows: count,
    includeGoogleFields: opts.includeGoogleFields,
    filters,
  });
}
