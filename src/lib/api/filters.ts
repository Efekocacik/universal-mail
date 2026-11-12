import { z } from "zod";
import { LEAD_LIFECYCLES, type LeadFilters, type LeadSort } from "@/lib/leads/query";
import { HttpError } from "./http";

const NOVELTY = ["future_opening", "high", "likely", "low"] as const;
const LEAD_STATUS = [
  "new",
  "enriched",
  "queued",
  "sent",
  "replied",
  "not_interested",
  "customer",
  "do_not_contact",
] as const;

/**
 * Lead listesinin süzgeç sorgu dizesi (`/api/leads` ile aynı biçim) için TEK sınır. Kampanyaya ekleme, e-posta bulma,
 * toplu işlemler ve dışa aktarma bunu kullanır; böylece uzun (çok ülkeli/kategorili) bir süzgeç birinde geçip diğerinde
 * 400 vermez. 8000 karakter, Node'un 16 KB başlık sınırının güvenle altındadır.
 */
export const FILTER_QUERY_MAX = 8000;
export const filterQuerySchema = z.string().max(FILTER_QUERY_MAX);

/** Bir toplu işlemde tek tek seçilebilecek en fazla lead (e-posta bulma ve toplu işlemlerle aynı). */
export const MAX_SELECTION = 2000;

/**
 * Toplu uç noktaların ortak seçim biçimi: açık kimlikler (1–2000) VEYA süzgeç sorgusu. Süzgeç seçimi sunucuda o anki
 * veriye göre çözülür; 2000'den fazlası eşleşirse yanıt `capped: true` taşır (sessizce kesilmez).
 */
export const selectionSchema = z.union([
  z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(MAX_SELECTION) }).strict(),
  z.object({ filterQuery: filterQuerySchema }).strict(),
]);
export type Selection = z.infer<typeof selectionSchema>;

const list = (v: string | null) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const bool = (v: string | null) =>
  v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined;
const num = (v: string | null) =>
  v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** URL parametrelerinden lead süzgeçlerini çözümler ve doğrular. */
export function parseLeadFilters(sp: URLSearchParams): LeadFilters {
  const novelty = list(sp.get("novelty"));
  const leadStatus = list(sp.get("status"));
  const source = list(sp.get("source"));
  const lifecycle = list(sp.get("lifecycle"));
  const parsed = z
    .object({
      novelty: z.array(z.enum(NOVELTY)).optional(),
      leadStatus: z.array(z.enum(LEAD_STATUS)).optional(),
      source: z.array(z.enum(["google", "demo"])).optional(),
      lifecycle: z.array(z.enum(LEAD_LIFECYCLES)).optional(),
    })
    .safeParse({ novelty, leadStatus, source, lifecycle });
  if (!parsed.success)
    throw new HttpError(400, "Geçersiz süzgeç değeri.", { code: "FILTER_INVALID" });

  let bbox: LeadFilters["bbox"];
  const b = sp.get("bbox");
  if (b) {
    const [south, west, north, east] = b.split(",").map(Number);
    if ([south, west, north, east].some((x) => x === undefined || !Number.isFinite(x)))
      throw new HttpError(400, "Geçersiz harita kutusu.", { code: "FILTER_INVALID" });
    bbox = { south: south!, west: west!, north: north!, east: east! };
  }

  const since = sp.get("detectedSince");
  let detectedSince: number | undefined;
  if (since !== null && since !== "") {
    const n = Number(since);
    if (!Number.isInteger(n) || n < 0 || n > 8_640_000_000_000_000)
      throw new HttpError(400, "Geçersiz tarih süzgeci.", { code: "FILTER_INVALID" });
    detectedSince = n;
  }

  return {
    q: sp.get("q") ?? undefined,
    countries: list(sp.get("countries"))?.map((c) => c.toUpperCase()),
    city: sp.get("city") ?? undefined,
    categories: list(sp.get("categories")),
    novelty: parsed.data.novelty,
    leadStatus: parsed.data.leadStatus,
    businessStatus: list(sp.get("businessStatus")),
    source: parsed.data.source,
    bbox,
    hasWebsite: bool(sp.get("hasWebsite")),
    ratingMin: num(sp.get("ratingMin")),
    ratingMax: num(sp.get("ratingMax")),
    scanId: num(sp.get("scanId")),
    notFound: bool(sp.get("notFound")),
    emailStatus: list(sp.get("emailStatus")),
    archived: bool(sp.get("archived")) === true ? true : undefined,
    lifecycle: parsed.data.lifecycle,
    detectedSince,
  };
}

export function parseSort(sp: URLSearchParams): LeadSort {
  const s = sp.get("sort");
  return s === "name" || s === "recent" ? s : "novelty";
}
