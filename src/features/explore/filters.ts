import type { BBox } from "@/lib/client/types";
import { EMPTY_SNAPSHOT, type FilterSnapshot } from "@/lib/leads/saved-filter-payload";

/** Keşif süzgeçleri (saf; React'ten bağımsız). Kayıtlı süzgeç yükü (`FilterSnapshot`) ile yapısal olarak aynıdır. */
export type UiFilters = FilterSnapshot;
export type LeadSort = "novelty" | "name" | "recent";

export const EMPTY_FILTERS: UiFilters = EMPTY_SNAPSHOT;

const bboxParam = (b: BBox) =>
  [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(",");

export function toApiFilters(
  f: UiFilters,
  bounds: BBox | null,
  onlyInView: boolean,
): Record<string, unknown> {
  return {
    q: f.q.trim() || undefined,
    countries: f.countries,
    city: f.city || undefined,
    categories: f.categories,
    novelty: f.novelty,
    status: f.leadStatus,
    businessStatus: f.businessStatus,
    emailStatus: f.emailStatus,
    hasWebsite: f.hasWebsite === "any" ? undefined : f.hasWebsite === "yes",
    scanId: f.scanId,
    notFound: f.hideNotFound ? false : undefined,
    lifecycle: f.lifecycle,
    detectedSince: f.detected?.since,
    archived: f.archived ? true : undefined,
    bbox: onlyInView && bounds ? bboxParam(bounds) : undefined,
  };
}

/** Etkin süzgeç sayısı (saf). */
export function countActiveFilters(f: UiFilters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.countries.length) n++;
  if (f.city) n++;
  if (f.categories.length) n++;
  if (f.novelty.length) n++;
  if (f.leadStatus.length) n++;
  if (f.businessStatus.length) n++;
  if (f.emailStatus.length) n++;
  if (f.hasWebsite !== "any") n++;
  if (f.scanId !== undefined) n++;
  if (f.hideNotFound) n++;
  if (f.lifecycle.length) n++;
  if (f.detected) n++;
  if (f.archived) n++;
  return n;
}
