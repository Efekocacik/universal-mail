import { z } from "zod";
import type { LeadFilters, LeadSort } from "@/lib/leads/query";
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
  const parsed = z
    .object({
      novelty: z.array(z.enum(NOVELTY)).optional(),
      leadStatus: z.array(z.enum(LEAD_STATUS)).optional(),
      source: z.array(z.enum(["google", "demo"])).optional(),
    })
    .safeParse({ novelty, leadStatus, source });
  if (!parsed.success) throw new HttpError(400, "Geçersiz süzgeç değeri.");

  let bbox: LeadFilters["bbox"];
  const b = sp.get("bbox");
  if (b) {
    const [south, west, north, east] = b.split(",").map(Number);
    if ([south, west, north, east].some((x) => x === undefined || !Number.isFinite(x)))
      throw new HttpError(400, "Geçersiz harita kutusu.");
    bbox = { south: south!, west: west!, north: north!, east: east! };
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
  };
}

export function parseSort(sp: URLSearchParams): LeadSort {
  const s = sp.get("sort");
  return s === "name" || s === "recent" ? s : "novelty";
}
