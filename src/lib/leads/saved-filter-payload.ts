import { z } from "zod";
import type { BBox, NoveltyLabel } from "@/lib/domain/types";
import type { LeadStatus } from "@/lib/db/schema";
import type { LeadLifecycle } from "./query";

/**
 * Kaydedilmiş süzgeç yükü (isomorfik: hem sunucu hem tarayıcı kullanır; veritabanı içe aktarmaz).
 *
 * Yük SÜRÜMLÜDÜR (`v: 1`). Süzgeç seçenekleri zamanla değişebileceği için okurken doğrulanır; uymayan satırlar silinmez,
 * `invalid: true` ile döner ve arayüz silmeyi önerir. Tarih süzgeci göreli (`detectedDays`) saklanır; böylece "son 7 gün"
 * bir hafta sonra uygulandığında da son 7 günü gösterir. Mutlak `detectedSince` yalnızca bir bağlantıdan gelen süzgeç
 * kaydedilirse kullanılır.
 */
export const SAVED_FILTER_VERSION = 1;
export const SAVED_FILTER_LIMIT = 50;
export const SAVED_FILTER_NAME_MAX = 60;

const NOVELTY = [
  "future_opening",
  "high",
  "likely",
  "low",
] as const satisfies readonly NoveltyLabel[];
const LEAD_STATUS = [
  "new",
  "enriched",
  "queued",
  "sent",
  "replied",
  "not_interested",
  "customer",
  "do_not_contact",
] as const satisfies readonly LeadStatus[];
const BUSINESS_STATUS = ["OPERATIONAL", "FUTURE_OPENING", "CLOSED_PERMANENTLY"] as const;
/** Yaşam döngüsü seçenekleri (isomorfik kopya; sunucudaki `LEAD_LIFECYCLES` ile aynı). */
export const LIFECYCLE_OPTIONS = [
  "opened",
  "future",
  "new",
] as const satisfies readonly LeadLifecycle[];
const LIFECYCLE = LIFECYCLE_OPTIONS;
const SORTS = ["novelty", "name", "recent"] as const;

const text = z.string().max(200);
const lat = z.number().finite().min(-90).max(90);
const lng = z.number().finite().min(-180).max(180);

export const savedFilterPayloadSchema = z
  .object({
    v: z.literal(SAVED_FILTER_VERSION),
    q: text.optional(),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(60)
      .default([]),
    city: text.optional(),
    categories: z.array(z.string().min(1).max(80)).max(60).default([]),
    novelty: z.array(z.enum(NOVELTY)).max(NOVELTY.length).default([]),
    status: z.array(z.enum(LEAD_STATUS)).max(LEAD_STATUS.length).default([]),
    businessStatus: z.array(z.enum(BUSINESS_STATUS)).max(BUSINESS_STATUS.length).default([]),
    emailStatus: z.array(z.string().min(1).max(40)).max(20).default([]),
    hasWebsite: z.boolean().optional(),
    hideNotFound: z.boolean().optional(),
    scanId: z.number().int().positive().optional(),
    lifecycle: z.array(z.enum(LIFECYCLE)).max(LIFECYCLE.length).default([]),
    detectedDays: z.number().int().min(1).max(3650).optional(),
    detectedSince: z.number().int().min(0).optional(),
    archived: z.boolean().optional(),
    bbox: z.object({ south: lat, west: lng, north: lat, east: lng }).strict().optional(),
  })
  .strict();
export type SavedFilterPayload = z.infer<typeof savedFilterPayloadSchema>;

export const savedFilterSortSchema = z.enum(SORTS);
export type SavedFilterSortValue = z.infer<typeof savedFilterSortSchema>;

export const savedFilterNameSchema = z.string().trim().min(1).max(SAVED_FILTER_NAME_MAX);

/**
 * Ad tekliği anahtarı: Türkçe büyük/küçük harf duyarsız ("İstanbul kafeler" ile "istanbul kafeler" aynıdır;
 * "I" → "ı"). Veritabanındaki `saved_filters_name_uq` bu değer üzerindedir.
 */
export function savedFilterNameKey(name: string): string {
  return name.trim().normalize("NFC").toLocaleLowerCase("tr").replace(/\s+/g, " ");
}

/** Keşif ekranının süzgeç durumu (state.tsx `UiFilters` ile yapısal olarak aynı). */
export interface FilterSnapshot {
  q: string;
  countries: string[];
  city: string;
  categories: string[];
  novelty: NoveltyLabel[];
  leadStatus: LeadStatus[];
  businessStatus: string[];
  emailStatus: string[];
  hasWebsite: "any" | "yes" | "no";
  scanId?: number;
  hideNotFound: boolean;
  lifecycle: LeadLifecycle[];
  /** Tespit tarihi alt sınırı; `days` varsa göreli dönemden (son N gün) hesaplanmıştır. */
  detected: { since: number; days?: number } | null;
  archived: boolean;
}

export const EMPTY_SNAPSHOT: FilterSnapshot = {
  q: "",
  countries: [],
  city: "",
  categories: [],
  novelty: [],
  leadStatus: [],
  businessStatus: [],
  emailStatus: [],
  hasWebsite: "any",
  hideNotFound: false,
  lifecycle: [],
  detected: null,
  archived: false,
};

const DAY_MS = 86_400_000;

/** Ekran durumunu kaydedilecek yüke çevirir. Harita alanı yalnızca `bbox` verilirse (kullanıcı isterse) eklenir. */
export function toSavedPayload(f: FilterSnapshot, bbox?: BBox | null): SavedFilterPayload {
  return {
    v: SAVED_FILTER_VERSION,
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    countries: [...f.countries],
    ...(f.city ? { city: f.city } : {}),
    categories: [...f.categories],
    novelty: [...f.novelty],
    status: [...f.leadStatus],
    businessStatus: f.businessStatus.filter((s): s is (typeof BUSINESS_STATUS)[number] =>
      (BUSINESS_STATUS as readonly string[]).includes(s),
    ),
    emailStatus: [...f.emailStatus],
    ...(f.hasWebsite !== "any" ? { hasWebsite: f.hasWebsite === "yes" } : {}),
    ...(f.hideNotFound ? { hideNotFound: true } : {}),
    ...(f.scanId !== undefined ? { scanId: f.scanId } : {}),
    lifecycle: [...f.lifecycle],
    ...(f.detected?.days !== undefined
      ? { detectedDays: f.detected.days }
      : f.detected
        ? { detectedSince: f.detected.since }
        : {}),
    ...(f.archived ? { archived: true } : {}),
    ...(bbox
      ? { bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east } }
      : {}),
  };
}

export interface AppliedSavedFilter {
  filters: FilterSnapshot;
  bbox: BBox | null;
  /** Artık bilinmeyen kategori anahtarları atıldı (kullanıcıya "bazı değerler artık yok" denir). */
  dropped: string[];
}

/**
 * Kayıtlı yükü ekran durumuna çevirir. `knownCategories` verilirse bilinmeyen kategori anahtarları atılır ve
 * `dropped` içinde döner. Göreli dönem `now` anına göre hesaplanır.
 */
export function fromSavedPayload(
  raw: unknown,
  opts: { knownCategories?: readonly string[]; now?: number } = {},
): AppliedSavedFilter | null {
  const parsed = savedFilterPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const now = opts.now ?? Date.now();
  const known = opts.knownCategories ? new Set(opts.knownCategories) : null;
  const categories = known ? p.categories.filter((c) => known.has(c)) : p.categories;
  const dropped = known ? p.categories.filter((c) => !known.has(c)) : [];
  return {
    filters: {
      q: p.q ?? "",
      countries: p.countries,
      city: p.city ?? "",
      categories,
      novelty: p.novelty,
      leadStatus: p.status,
      businessStatus: p.businessStatus,
      emailStatus: p.emailStatus,
      hasWebsite: p.hasWebsite === undefined ? "any" : p.hasWebsite ? "yes" : "no",
      scanId: p.scanId,
      hideNotFound: p.hideNotFound === true,
      lifecycle: p.lifecycle,
      detected:
        p.detectedDays !== undefined
          ? { since: now - p.detectedDays * DAY_MS, days: p.detectedDays }
          : p.detectedSince !== undefined
            ? { since: p.detectedSince }
            : null,
      archived: p.archived === true,
    },
    bbox: p.bbox ?? null,
    dropped,
  };
}

/** İki süzgeç durumu aynı yükü mü üretir? ("Değişti · Güncelle" göstergesi için.) */
export function sameFilters(a: FilterSnapshot, b: FilterSnapshot): boolean {
  return JSON.stringify(toSavedPayload(a)) === JSON.stringify(toSavedPayload(b));
}
