import fs from "node:fs";
import path from "node:path";
import { staticDataDir } from "@/lib/config/paths";
import type { BBox } from "@/lib/domain/types";
import { clamp } from "@/lib/util";
import { bboxFromCenter, haversineM } from "./bbox";

export interface City {
  id: number;
  name: string;
  ascii: string;
  cc: string;
  lat: number;
  lng: number;
  pop: number;
  capital?: boolean;
}

/** Türkçe yazılışı yaygın büyük şehirler için takma adlar → GeoNames ASCII adı. */
const ALIASES_TR: Record<string, string> = {
  londra: "london",
  viyana: "vienna",
  brüksel: "brussels",
  bruksel: "brussels",
  prag: "prague",
  lizbon: "lisbon",
  atina: "athens",
  roma: "rome",
  milano: "milan",
  münih: "munich",
  munih: "munich",
  köln: "cologne",
  koln: "cologne",
  cenevre: "geneva",
  zürih: "zurich",
  zurih: "zurich",
  kopenhag: "copenhagen",
  stokholm: "stockholm",
  varşova: "warsaw",
  varsova: "warsaw",
  budapeşte: "budapest",
  budapeste: "budapest",
  bükreş: "bucharest",
  bukres: "bucharest",
  sofya: "sofia",
  belgrad: "belgrade",
  üsküp: "skopje",
  uskup: "skopje",
  dublin: "dublin",
  edinburg: "edinburgh",
  venedik: "venice",
  floransa: "florence",
  napoli: "naples",
  istanbul: "istanbul",
  izmir: "izmir",
};

let cache: City[] | undefined;

export function loadCities(): City[] {
  if (!cache) {
    const file = path.join(staticDataDir(), "cities.eu-tr.json");
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as City[];
  }
  return cache;
}

/** Test için önbelleği temizler. */
export function resetCityCache(): void {
  cache = undefined;
}

export function normalizeText(s: string): string {
  return s.toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").trim();
}

export function searchCities(
  query: string,
  opts: { countries?: string[]; limit?: number } = {},
): City[] {
  const limit = opts.limit ?? 20;
  const q = normalizeText(query);
  const alias = ALIASES_TR[query.toLocaleLowerCase("tr").trim()];
  const needles = [q, ...(alias ? [normalizeText(alias)] : [])].filter(Boolean);
  const allowed = opts.countries?.length ? new Set(opts.countries) : undefined;

  const scored: { city: City; score: number }[] = [];
  for (const city of loadCities()) {
    if (allowed && !allowed.has(city.cc)) continue;
    if (needles.length === 0) {
      scored.push({ city, score: city.pop });
      continue;
    }
    const hay = [normalizeText(city.name), normalizeText(city.ascii)];
    let rank = 0;
    for (const n of needles) {
      if (hay.some((h) => h === n)) rank = Math.max(rank, 3);
      else if (hay.some((h) => h.startsWith(n))) rank = Math.max(rank, 2);
      else if (hay.some((h) => h.includes(n))) rank = Math.max(rank, 1);
    }
    if (rank > 0) scored.push({ city, score: rank * 1e9 + city.pop });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.city);
}

export function getCityById(id: number): City | undefined {
  return loadCities().find((c) => c.id === id);
}

/** Nüfusa göre yaklaşık kent merkezi yarıçapı (km). Yoğunluk ≈ 3.500 kişi/km², 2,5–25 km aralığı. */
export function defaultRadiusKm(population: number): number {
  const areaKm2 = Math.max(1, population) / 3500;
  const radius = Math.sqrt(areaKm2 / Math.PI);
  return Math.round(clamp(radius, 2.5, 25) * 10) / 10;
}

export function cityBBox(city: City, radiusKm: number = defaultRadiusKm(city.pop)): BBox {
  return bboxFromCenter(city.lat, city.lng, radiusKm);
}

/**
 * Bir koordinat için yaklaşık ülke ve şehir: KENDİ şehir veri setimizden (GeoNames) türetilir, Google adres verisinden değil.
 * Yakında şehir yoksa bölgenin ülkesi (varsa) kullanılır. Yaklaşıktır; e-posta uyumu için kesin ülke gönderim anında
 * canlı olarak doğrulanır (docs/05-FAZ1-NOTLARI.md).
 */
export function deriveLocation(
  lat: number,
  lng: number,
  regionCountry?: string | null,
): { countryCode: string | null; city: string | null } {
  const near = nearestCity(lat, lng, 60);
  if (near) return { countryCode: near.cc, city: near.ascii };
  return { countryCode: regionCountry ?? null, city: null };
}

/** Koordinata en yakın şehir (belirli bir uzaklığın içinde). Ülke/şehir tahmini için yedek yöntemdir. */
export function nearestCity(lat: number, lng: number, maxKm = 60): City | undefined {
  let best: City | undefined;
  let bestD = maxKm * 1000;
  for (const c of loadCities()) {
    if (Math.abs(c.lat - lat) > 1 || Math.abs(c.lng - lng) > 1.5) continue;
    const d = haversineM({ lat, lng }, { lat: c.lat, lng: c.lng });
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}
