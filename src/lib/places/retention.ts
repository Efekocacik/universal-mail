import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeSnapshots, places, scans } from "@/lib/db/schema";
import { FIELD_TIERS } from "./fields";

/**
 * Google Maps Platform verisi için ALAN DÜZEYİNDE saklama politikası (Faz 4, madde 2). "Her şey 30 gün" varsayılmaz:
 * her alanın sınıfı, nerede tutulduğu ve kaynağı ayrı yazılır. Kod-olarak-yapılandırma: yeni bir Places alanı
 * (`FIELD_TIERS`) bu tabloya satır eklenmeden kullanılamaz (tests/google-retention.test.ts CI'da yakalar).
 *
 * Kaynaklar (son kontrol `TERMS_REVIEWED_AT`; canlıya geçmeden hukukçu ile yeniden doğrulanmalıdır):
 *  - Google Maps Platform Hizmet Şartları, §3.2.3 (b) "No Caching": https://cloud.google.com/maps-platform/terms
 *  - Places API politikaları (place_id süresiz saklanabilir; lat/lng en çok 30 gün):
 *    https://developers.google.com/maps/documentation/places/web-service/policies#pre-fetching,-caching,-or-storage-of-content
 *  - Place ID'ler (12 aydan eski kimlikleri yenileme önerisi; eskimiş kimlik NOT_FOUND döndürür):
 *    https://developers.google.com/maps/documentation/places/web-service/place-id#save-id
 *  - Hizmete Özgü Şartlar, Places: https://cloud.google.com/maps-platform/terms/maps-service-terms
 *
 * Sınıflar:
 *  - `indefinite`: süresiz saklanabilir (yalnızca place_id); `refreshAfterDays` sonra yenileme önerilir.
 *  - `ttl`: en çok `maxDays` gün (koordinatlar: 30 gün mutlak üst sınır, ayar daha kısa yapabilir).
 *  - `session`: yalnızca geçici oturum önbelleğinde (gcache); açılış/kapanışta ve `google.cacheDays` sonra silinir.
 *  - `derived`: bizim türettiğimiz kalıcı bayraklar. Google içeriği mi sayılır hukuki görüşü BEKLİYOR (`legalReview:
 *    "pending"`); o zamana dek bugünkü davranış (süresiz) korunur, `google.derivedFlagsDays` ayarlanırsa o kadar gün sonra
 *    temizlenir — YALNIZCA `settingKey` taşıyan alanlar (`purgeDerivedFlags` tam olarak bunları siler; test eşleştirir).
 *    Ayarın silmediği türetilmiş alanlar `settingKey` taşımaz, `maxDays` null'dır ve `keptBecause` gerçek davranışı
 *    söyler (politika tablosu yapılmayan bir silmeyi vaat etmez):
 *      `prevents_reappearing`  goneAt: Google'da kaybolan yer yeniden "etkin" görünmesin diye kalır (yalnızca bizim
 *                              zaman damgamız; Google içeriği yok)
 *      `recomputed_each_scan`  reviewsSignal: her taramada güncel (oturumluk) değerlendirme sayısından yeniden hesaplanır
 *      `own_dataset`           countryCity: KENDİ GeoNames veri setimizden türetilir, Google içeriği değildir
 */
export const TERMS_REVIEWED_AT = "2026-11-12";
export const TERMS_URL = "https://cloud.google.com/maps-platform/terms";
export const PLACES_POLICY_URL =
  "https://developers.google.com/maps/documentation/places/web-service/policies";
export const PLACE_ID_URL =
  "https://developers.google.com/maps/documentation/places/web-service/place-id#save-id";

/** Koordinatların mutlak üst sınırı (gün). Ayar şeması değişse bile bu aşılmaz. */
export const MAX_COORD_DAYS = 30;
/** place_id yenileme önerisi (gün). */
export const PLACE_ID_REFRESH_DAYS = 365;

export type RetentionClass = "indefinite" | "ttl" | "session" | "derived";
export type Storage = "places" | "gcache" | "snapshots" | "leads";

export interface RetentionRule {
  class: RetentionClass;
  storage: Storage[];
  maxDays?: number;
  settingKey?: "google.cacheDays" | "google.derivedFlagsDays";
  refreshAfterDays?: number;
  termsRef: string;
  legalReview?: "pending";
  /** Türetilmiş ama `google.derivedFlagsDays` ile SİLİNMEYEN alanın gerçek davranışı. */
  keptBecause?: KeptBecause;
}

export type KeptBecause = "prevents_reappearing" | "recomputed_each_scan" | "own_dataset";

/** Bizim türettiğimiz kalıcı alanlar (Google alanı değil ama Google verisinden hesaplanan). */
export const DERIVED_FIELDS = [
  "wasFuture",
  "isClosed",
  "openedDetectedAt",
  "newDetectedAt",
  "notFoundInScanId",
  "statusCheckedAt",
  "goneAt",
  "reviewsSignal",
  "countryCity",
] as const;
export type DerivedField = (typeof DERIVED_FIELDS)[number];

const session = (termsRef = PLACES_POLICY_URL): RetentionRule => ({
  class: "session",
  storage: ["gcache"],
  maxDays: MAX_COORD_DAYS,
  settingKey: "google.cacheDays",
  termsRef,
});
const derived = (storage: Storage[]): RetentionRule => ({
  class: "derived",
  storage,
  settingKey: "google.derivedFlagsDays",
  termsRef: TERMS_URL,
  legalReview: "pending",
});
/** Türetilmiş, ayar tarafından silinmeyen alan (gerekçesiyle). */
const derivedKept = (storage: Storage[], keptBecause: KeptBecause): RetentionRule => ({
  class: "derived",
  storage,
  termsRef: TERMS_URL,
  legalReview: "pending",
  keptBecause,
});

export const GOOGLE_RETENTION_POLICY: Readonly<
  Record<keyof typeof FIELD_TIERS | DerivedField, RetentionRule>
> = {
  id: {
    class: "indefinite",
    storage: ["places", "leads", "snapshots"],
    refreshAfterDays: PLACE_ID_REFRESH_DAYS,
    termsRef: PLACE_ID_URL,
  },
  location: {
    class: "ttl",
    storage: ["places"],
    maxDays: MAX_COORD_DAYS,
    settingKey: "google.cacheDays",
    termsRef: PLACES_POLICY_URL,
  },
  displayName: session(),
  formattedAddress: session(),
  types: session(),
  primaryType: session(),
  businessStatus: session(),
  openingDate: session(),
  addressComponents: session(),
  googleMapsUri: session(),
  websiteUri: session(),
  nationalPhoneNumber: session(),
  internationalPhoneNumber: session(),
  userRatingCount: session(),
  wasFuture: derived(["places", "snapshots"]),
  isClosed: derived(["places"]),
  openedDetectedAt: derived(["places"]),
  newDetectedAt: derived(["places"]),
  notFoundInScanId: derived(["places"]),
  statusCheckedAt: derived(["places"]),
  goneAt: derivedKept(["places"], "prevents_reappearing"),
  /** Değerlendirme sayısından türetilen yenilik sinyali kovası (leads.novelty_signals). */
  reviewsSignal: derivedKept(["leads"], "recomputed_each_scan"),
  /** Ülke/şehir: Google koordinatından KENDİ GeoNames veri setimizle türetilir. */
  countryCity: derivedKept(["leads"], "own_dataset"),
};

export interface PolicyRow {
  field: string;
  class: RetentionClass;
  storage: Storage[];
  maxDays: number | null;
  refreshAfterDays: number | null;
  termsRef: string;
  legalReview: "pending" | null;
  keptBecause: KeptBecause | null;
}

/** Ayarlar kartı ve GET /api/google-data için politika tablosu (güncel ayar değerleriyle). */
export function policyRows(settings: {
  cacheDays: number;
  derivedFlagsDays: number | null;
}): PolicyRow[] {
  return Object.entries(GOOGLE_RETENTION_POLICY).map(([field, r]) => ({
    field,
    class: r.class,
    storage: r.storage,
    maxDays:
      r.settingKey === "google.derivedFlagsDays"
        ? settings.derivedFlagsDays
        : r.maxDays !== undefined
          ? effectiveCacheDays(settings.cacheDays)
          : null,
    refreshAfterDays: r.refreshAfterDays ?? null,
    termsRef: r.termsRef,
    legalReview: r.legalReview ?? null,
    keptBecause: r.keptBecause ?? null,
  }));
}

/** Ayardaki gün sayısı, 1..30 aralığına sıkıştırılır (30 Google üst sınırı). */
export function effectiveCacheDays(setting: number): number {
  const n = Number.isFinite(setting) ? Math.floor(setting) : MAX_COORD_DAYS;
  return Math.min(Math.max(n, 1), MAX_COORD_DAYS);
}

/**
 * `google.derivedFlagsDays` ayarlıysa (null = süresiz) türetilmiş bayrakları temizler: son gözlemi (`status_checked_at`,
 * yoksa `updated_at`) kesimden eski yerlerde was_future/is_closed/*_detected_at/not_found/status_checked_at sıfırlanır
 * ve kesimden önce biten taramaların snapshot `was_future` bayrağı kaldırılır. place_id ve lead (kullanıcı verisi) kalır.
 * Silinen alanlar politika tablosunda `settingKey: "google.derivedFlagsDays"` taşıyanlarla birebir aynıdır.
 */
export async function purgeDerivedFlags(
  db: Db,
  derivedFlagsDays: number | null,
  now: number,
): Promise<{ places: number; snapshots: number }> {
  if (derivedFlagsDays === null) return { places: 0, snapshots: 0 };
  const cutoff = now - Math.max(30, derivedFlagsDays) * 86_400_000;
  const observed = sql`coalesce(${places.statusCheckedAt}, ${places.updatedAt})`;
  const p = await db
    .update(places)
    .set({
      wasFuture: false,
      isClosed: false,
      openedDetectedAt: null,
      newDetectedAt: null,
      notFoundInScanId: null,
      statusCheckedAt: null,
    })
    .where(
      and(
        lt(observed, cutoff),
        or(
          sql`${places.wasFuture} = 1`,
          sql`${places.isClosed} = 1`,
          isNotNull(places.openedDetectedAt),
          isNotNull(places.newDetectedAt),
          isNotNull(places.notFoundInScanId),
          isNotNull(places.statusCheckedAt),
        ),
      ),
    )
    .returning({ id: places.placeId });
  const s = await db
    .update(placeSnapshots)
    .set({ wasFuture: false })
    .where(
      and(
        sql`${placeSnapshots.wasFuture} = 1`,
        sql`${placeSnapshots.scanId} IN (SELECT ${scans.id} FROM ${scans} WHERE coalesce(${scans.finishedAt}, ${scans.createdAt}) < ${cutoff})`,
      ),
    )
    .returning({ id: placeSnapshots.placeId });
  return { places: p.length, snapshots: s.length };
}
