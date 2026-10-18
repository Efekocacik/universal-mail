import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * GOOGLE OTURUM ÖNBELLEĞİ. Google Maps Platform şartları Places içeriğinin (ad, adres, telefon, web sitesi, tür,
 * değerlendirme sayısı vb.) saklanmasını yasaklar; yalnızca place_id süresiz, enlem/boylam en fazla 30 gün tutulabilir.
 * Bu yüzden bu alanlar ana veritabanına YAZILMAZ. Ayrı bir dosyada (google-session.db, ATTACH ile `gcache` takma adı)
 * yalnızca uygulama açıkken tutulur; uygulama açılışında ve kapanışında dosya silinir.
 *
 * Bu tablo drizzle migrasyonlarına DAHİL DEĞİLDİR (drizzle.config.ts yalnızca schema.ts'i okur); tablo,
 * ekli veritabanı açılırken `CACHE_DDL` ile oluşturulur. Sorgularda tablo adı ana veritabanında olmadığından
 * nitelendirme gerekmeden çözülür.
 */
export const placeCache = sqliteTable("place_cache", {
  placeId: text("place_id").primaryKey(),
  name: text("name").notNull(),
  formattedAddress: text("formatted_address"),
  primaryType: text("primary_type"),
  types: text("types", { mode: "json" }).$type<string[]>().notNull(),
  businessStatus: text("business_status"),
  openingDate: text("opening_date"),
  website: text("website"),
  phone: text("phone"),
  intlPhone: text("intl_phone"),
  userRatingCount: integer("user_rating_count"),
  fetchedAt: integer("fetched_at").notNull(),
  enrichedAt: integer("enriched_at"),
});

export const CACHE_DDL = `CREATE TABLE IF NOT EXISTS gcache.place_cache (
  place_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  formatted_address TEXT,
  primary_type TEXT,
  types TEXT NOT NULL,
  business_status TEXT,
  opening_date TEXT,
  website TEXT,
  phone TEXT,
  intl_phone TEXT,
  user_rating_count INTEGER,
  fetched_at INTEGER NOT NULL,
  enriched_at INTEGER
)`;
