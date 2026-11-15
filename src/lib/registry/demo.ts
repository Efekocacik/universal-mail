import { bboxFromCenter } from "@/lib/geo/bbox";
import { deriveLocation, loadCities, searchCities, type City } from "@/lib/geo/cities";
import { DISCOVERY_FIELDS } from "@/lib/places/fields";
import { MockPlacesProvider } from "@/lib/places/mock";
import { BUILTIN_CATEGORIES } from "@/lib/scan/categories";
import { categoryForCodes } from "./codes";
import { foldText } from "./match";
import {
  REGISTRY_COUNTRY,
  type RegistryCompanyInput,
  type RegistryPage,
  type RegistryProvider,
  type RegistryQuery,
  type RegistrySource,
} from "./types";

/**
 * Demo sicil sağlayıcısı (ağsız, anahtarsız, `isDemo = true`). Kayıtlar BELİRLENİMCİDİR: aynı (kaynak, yer, kodlar,
 * pencere, demo dönemi) her zaman aynı listeyi verir.
 *
 *  - Yer çözümü: `locality` şehir listesinde aranır (GB → London, FR → Paris varsayılan).
 *  - Şehir merkezinin `DEMO_RADIUS_KM` çevresinde, demo taramanın KULLANDIĞI AYNI üretici (`MockPlacesProvider`, aynı
 *    `mock.epoch`) kodun kategorisi için çalıştırılır. Bulunan yerlerin ~%60'ı sicil biçimli şirkete dönüşür (büyük harf,
 *    aksansız, " LTD" / " SARL"; FR'de tabela adı `tradingName`), adres satırı yerin kapı no + sokağıdır.
 *  - ~%40 hiçbir zaman eşleşmeyen yapay ad eklenir (demo üreticinin kullanmadığı sözcüklerden).
 *  - Kuruluş tarihleri pencerenin içine yayılır; `externalId` "DEMO" + 6 hane.
 * Haritada hangi yerlerin bulunduğu kullanıcının taramasına bağlıdır; eşleşme oranı bu yüzden tarama alanına göre değişir.
 */
export const DEMO_RADIUS_KM = 1.5;
/** Kod başına üreticiden alınan en çok yer (sayfa başına 100 kayıtla 1–2 sayfa). */
const MAX_PLACES_PER_CODE = 40;
const PAGE_SIZE = 100;
const DEFAULT_CITY: Record<"GB" | "FR", string> = { GB: "London", FR: "Paris" };

/** Demo üreticinin (`src/lib/places/mock.ts`) KULLANMADIĞI sözcükler: bu adlar haritada asla bulunmaz. */
const SYN_ADJ = ["Birch", "Cobalt", "Juniper", "Marlow", "Pebble", "Quill", "Rowan", "Tidal"];
const SYN_NOUN = ["Larder", "Pantry", "Hearth", "Parlour", "Galley", "Nook", "Cellar"];
const SYN_STREET = ["Orchard Row", "Tanner Yard", "Weaver Close", "Cooper Mews", "Saddler Walk"];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const upperAscii = (s: string) => foldText(s).toUpperCase();

function resolveCity(country: "GB" | "FR", locality: string | null): City {
  const hit = locality ? searchCities(locality, { countries: [country], limit: 1 })[0] : undefined;
  if (hit) return hit;
  const def = loadCities().find((c) => c.cc === country && c.ascii === DEFAULT_CITY[country]);
  /* v8 ignore next -- şehir veri seti her iki başkenti de içerir */
  if (!def) throw new Error(`Demo şehri bulunamadı: ${country}`);
  return def;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000),
  );
}

function postcodeFor(country: "GB" | "FR", h: number): string {
  if (country === "FR") return `750${String(1 + (h % 20)).padStart(2, "0")}`;
  const L = "ABDEFGHJLNPQRSTUWXYZ";
  return `EC${1 + (h % 4)}A ${h % 10}${L[(h >>> 4) % L.length]}${L[(h >>> 9) % L.length]}`;
}

/** Tüm kayıtlar (sayfalamadan önce). Dışa açık: testler belirlenimciliği ve eşleşme oranını doğrular. */
export async function generateDemoCompanies(
  source: RegistrySource,
  query: Pick<
    RegistryQuery,
    "scheme" | "activityCodes" | "incorporatedFrom" | "incorporatedTo" | "locality"
  >,
  epoch: number,
): Promise<RegistryCompanyInput[]> {
  const country = REGISTRY_COUNTRY[source];
  const city = resolveCity(country, query.locality);
  const bbox = bboxFromCenter(city.lat, city.lng, DEMO_RADIUS_KM);
  const mock = new MockPlacesProvider({ getEpoch: () => epoch });
  const span = spanDays(query.incorporatedFrom, query.incorporatedTo);
  const legal = country === "GB" ? "LTD" : "SARL";
  const out: RegistryCompanyInput[] = [];
  const usedIds = new Set<string>();
  const externalId = (seed: string) => {
    let n = 100_000 + (fnv1a(seed) % 900_000);
    while (usedIds.has(`DEMO${n}`)) n = n >= 999_999 ? 100_000 : n + 1;
    usedIds.add(`DEMO${n}`);
    return `DEMO${n}`;
  };
  const base = (seed: string, code: string) => ({
    countryCode: country,
    activityScheme: query.scheme,
    activityCodes: [code],
    incorporatedOn: addDays(query.incorporatedFrom, fnv1a(`inc:${seed}`) % (span + 1)),
    registryStatus: country === "GB" ? "active" : "A",
  });

  for (const code of query.activityCodes) {
    const category = categoryForCodes(query.scheme, [code]);
    const types = BUILTIN_CATEGORIES.find((c) => c.key === category)?.placeTypes ?? [];
    const places = [];
    for (const type of types) {
      const res = await mock.searchText({
        textQuery: type,
        includedType: type,
        bbox,
        fields: DISCOVERY_FIELDS,
        includeFutureOpening: false,
      });
      places.push(...res.places);
    }
    const picked = places
      .filter((p) => fnv1a(`pick:${source}:${p.placeId}`) % 10 < 6)
      .sort((a, b) => a.placeId.localeCompare(b.placeId))
      .slice(0, MAX_PLACES_PER_CODE);
    for (const p of picked) {
      const seed = `${source}:${p.placeId}`;
      const street = (p.formattedAddress ?? "").split(",")[0]?.trim() || null;
      out.push({
        ...base(seed, code),
        externalId: externalId(seed),
        name: `${upperAscii(p.name)} ${legal}`,
        tradingName: country === "FR" ? p.name : null,
        postcode: postcodeFor(country, fnv1a(`pc:${seed}`)),
        // Taramanın lead şehriyle AYNI türetme (kendi şehir veri setimiz), adresteki karo şehri değil.
        locality: deriveLocation(p.lat, p.lng, country).city ?? city.ascii,
        addressLine: street ? street.toUpperCase() : null,
      });
    }
    // ~%40 eşleşmeyen yapay kayıt (toplamın 2/3'ü kadar ek → türetilenler ≈ %60).
    const synthetic = Math.round((picked.length * 2) / 3);
    for (let i = 0; i < synthetic; i++) {
      const seed = `${source}:${city.id}:${code}:syn:${i}`;
      const h = fnv1a(seed);
      const name = `${SYN_ADJ[h % SYN_ADJ.length]} ${SYN_NOUN[(h >>> 8) % SYN_NOUN.length]}`;
      out.push({
        ...base(seed, code),
        externalId: externalId(seed),
        name: `${name.toUpperCase()} ${legal}`,
        tradingName: country === "FR" ? name : null,
        postcode: postcodeFor(country, h),
        locality: city.ascii,
        addressLine: `${1 + (h % 90)} ${SYN_STREET[(h >>> 12) % SYN_STREET.length]}`.toUpperCase(),
      });
    }
  }
  return out;
}

export interface DemoRegistryOptions {
  /** Demo tarama dönemi (`mock.epoch`); demo taramayla aynı yerleri üretmek için. Varsayılan 0. */
  getEpoch?: () => number | Promise<number>;
}

export function createDemoRegistryProvider(
  source: RegistrySource,
  opts: DemoRegistryOptions = {},
): RegistryProvider {
  return {
    source,
    isDemo: true,
    async search(query: RegistryQuery): Promise<RegistryPage> {
      const all = await generateDemoCompanies(source, query, (await opts.getEpoch?.()) ?? 0);
      const offset = query.cursor ? Number(query.cursor) || 0 : 0;
      const next = offset + PAGE_SIZE;
      return {
        items: all.slice(offset, next),
        total: all.length,
        nextCursor: next < all.length ? String(next) : null,
      };
    },
    async test(): Promise<void> {},
  };
}
