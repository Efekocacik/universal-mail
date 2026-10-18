import type { BBox, PlaceRecord } from "@/lib/domain/types";
import { circleToBBox, haversineM } from "@/lib/geo/bbox";
import { defaultRadiusKm, loadCities, type City } from "@/lib/geo/cities";
import { PlacesApiError } from "./errors";
import { skuFor } from "./fields";
import type {
  DetailsResult,
  NearbySearchRequest,
  PlacesProvider,
  SearchResult,
  TextSearchRequest,
} from "./provider";

/**
 * Demo sağlayıcı: Google'a hiç istek atmadan, gerçekçi ve DETERMİNİSTİK yapay işletme üretir.
 * Amaç; arayüzü, harita/liste akışını, sayfalamayı, hücre bölmeyi, bütçe sayacını ve yeni açılan
 * işletme tespitini anahtarsız denemek ve test etmektir. Üretilen kayıtlar `source = "demo"` ile
 * işaretlenir ve gerçek veriyle karıştırılmaz. Web siteleri ayrılmış `.example` alan adlarıdır.
 *
 * `getEpoch()` "kaç tarama dönemi geçti" bilgisini verir. Epoch arttıkça bazı yeni işletmeler
 * belirir ve bazı FUTURE_OPENING işletmeler açılır; böylece "14 gün sonraki ikinci tarama" simüle edilir.
 */

const TILE_DEG = 0.01;
const MAX_TILES = 40_000;

/** Tür → göreli yoğunluk. */
const TYPE_WEIGHT: Record<string, number> = {
  cafe: 1,
  coffee_shop: 0.7,
  pub: 0.6,
  bar: 0.8,
  restaurant: 1.6,
  bakery: 0.5,
  hotel: 0.35,
};

const KEYWORD_TYPES: [RegExp, string[]][] = [
  [/coffee|kahve|caf[eé]|espresso|brunch/i, ["cafe", "coffee_shop"]],
  [/pub|gastropub|tavern/i, ["pub"]],
  [/cocktail|bar\b/i, ["bar"]],
  [/bakery|f[ıi]r[ıi]n|pastry/i, ["bakery"]],
  [/restaurant|lokanta|bistro/i, ["restaurant"]],
  [/hotel|hostel/i, ["hotel"]],
];

const NAME_PARTS: Record<string, { adj: string[]; noun: string[] }> = {
  cafe: {
    adj: ["Daily", "Little", "Golden", "Corner", "Maple", "Velvet", "Urban", "Quiet", "Sunny", "Olive"],
    noun: ["Grind Café", "Bean Café", "Owl Café", "Kettle Café", "Table Café", "Pour Café", "Crumb Café"],
  },
  coffee_shop: {
    adj: ["Copper", "Black", "Fresh", "Nordic", "Mellow", "Bright", "Arabica", "Dawn", "Stone", "Harbor"],
    noun: ["Coffee Roasters", "Coffee House", "Espresso Bar", "Coffee Works", "Brew Lab"],
  },
  pub: {
    adj: ["Red", "Old", "Royal", "Crown", "Silver", "Iron", "Hungry", "Wandering", "Lucky", "Foxes"],
    noun: ["Lion Pub", "Arms", "Anchor Inn", "Oak Tavern", "Swan Pub", "Barrel House"],
  },
  bar: {
    adj: ["Blue", "Midnight", "Neon", "Hidden", "Social", "Amber", "Velvet", "Dry", "Spirit", "Lemon"],
    noun: ["Cocktail Bar", "Wine Bar", "Lounge", "Social Club", "Tap Room"],
  },
  restaurant: {
    adj: ["La", "Casa", "Saffron", "Basil", "Harvest", "Smoke", "Salt", "Fig", "Cedar", "Pearl"],
    noun: ["Kitchen", "Bistro", "Trattoria", "Grill", "Table", "Eatery"],
  },
  bakery: {
    adj: ["Warm", "Flour", "Sweet", "Rye", "Butter", "Honey", "Rustic", "Early", "Spelt", "Sugar"],
    noun: ["Bakery", "Bread Co.", "Patisserie", "Bake House", "Oven"],
  },
  hotel: {
    adj: ["Grand", "Park", "City", "Station", "Garden", "Plaza", "Harbour", "Central", "Albert", "Regent"],
    noun: ["Hotel", "Inn", "Suites", "Lodge", "Guest House"],
  },
};

const STREETS = ["High", "Station", "Church", "Market", "Park", "Mill", "King", "Queen", "Bridge", "Garden", "Victoria", "Lake"];
const STREET_SUFFIX = ["Street", "Road", "Lane", "Square", "Avenue"];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enc = (n: number): string => (n + 100_000).toString(36);
const dec = (s: string): number => parseInt(s, 36) - 100_000;

export function demoId(ix: number, iy: number, type: string, i: number): string {
  return `demo.${enc(ix)}.${enc(iy)}.${type}.${i}`;
}

function parseDemoId(id: string): { ix: number; iy: number; type: string; i: number } | null {
  const m = /^demo\.([0-9a-z]+)\.([0-9a-z]+)\.([a-z_]+)\.(\d+)$/.exec(id);
  if (!m) return null;
  return { ix: dec(m[1]!), iy: dec(m[2]!), type: m[3]!, i: Number(m[4]) };
}

function typesForQuery(req: { includedType?: string; textQuery?: string }): string[] {
  if (req.includedType) return TYPE_WEIGHT[req.includedType] ? [req.includedType] : [];
  const q = req.textQuery ?? "";
  const hit = KEYWORD_TYPES.find(([re]) => re.test(q));
  return hit ? hit[1] : [];
}

function nearestCityIn(cities: City[], lat: number, lng: number): { city: City; km: number } | undefined {
  let best: { city: City; km: number } | undefined;
  for (const city of cities) {
    const km = haversineM({ lat, lng }, { lat: city.lat, lng: city.lng }) / 1000;
    if (!best || km < best.km) best = { city, km };
  }
  return best;
}

function decodePageToken(token: string): number {
  const decoded = /^[A-Za-z0-9_-]+$/.test(token) ? Buffer.from(token, "base64url").toString("utf8") : "";
  if (!/^\d+$/.test(decoded)) throw new PlacesApiError("invalid", "Geçersiz sayfa belirteci.");
  return Number(decoded);
}

export interface MockOptions {
  getEpoch: () => number | Promise<number>;
}

interface Candidate {
  place: PlaceRecord;
  rank: number;
}

export class MockPlacesProvider implements PlacesProvider {
  readonly id = "mock" as const;
  readonly pageSize = 20;
  readonly maxTextResults = 60;
  readonly maxNearbyResults = 20;

  constructor(private readonly opts: MockOptions) {}

  async searchText(req: TextSearchRequest): Promise<SearchResult> {
    const epoch = await this.opts.getEpoch();
    const types = typesForQuery(req);
    const all = this.generate(req.bbox, types, epoch, req.fields, req.includeFutureOpening);
    const offset = req.pageToken ? decodePageToken(req.pageToken) : 0;
    const capped = all.slice(0, this.maxTextResults);
    const page = capped.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;
    return {
      places: page.map((c) => c.place),
      nextPageToken: next < capped.length ? Buffer.from(String(next), "utf8").toString("base64url") : undefined,
      sku: skuFor("text", req.fields),
    };
  }

  async searchNearby(req: NearbySearchRequest): Promise<SearchResult> {
    const epoch = await this.opts.getEpoch();
    const types = req.includedTypes.filter((t) => TYPE_WEIGHT[t]);
    const bbox = circleToBBox(req.circle.lat, req.circle.lng, req.circle.radiusM);
    const within = this.generate(bbox, types, epoch, req.fields, req.includeFutureOpening).filter(
      (c) =>
        haversineM({ lat: req.circle.lat, lng: req.circle.lng }, { lat: c.place.lat, lng: c.place.lng }) <=
        req.circle.radiusM,
    );
    return {
      places: within.slice(0, this.maxNearbyResults).map((c) => c.place),
      sku: skuFor("nearby", req.fields),
    };
  }

  async getDetails(placeId: string, fields: readonly string[]): Promise<DetailsResult> {
    const epoch = await this.opts.getEpoch();
    const parsed = parseDemoId(placeId);
    if (!parsed) return { place: null, sku: skuFor("details", fields) };
    const bbox: BBox = {
      south: parsed.iy * TILE_DEG,
      north: (parsed.iy + 1) * TILE_DEG,
      west: parsed.ix * TILE_DEG,
      east: (parsed.ix + 1) * TILE_DEG,
    };
    const found = this.generate(bbox, [parsed.type], epoch, fields, true).find((c) => c.place.placeId === placeId);
    return { place: found?.place ?? null, sku: skuFor("details", fields) };
  }

  private generate(
    bbox: BBox,
    types: string[],
    epoch: number,
    fields: readonly string[],
    includeFuture: boolean,
  ): Candidate[] {
    if (types.length === 0) return [];
    const ixMin = Math.floor(bbox.west / TILE_DEG);
    const ixMax = Math.floor(bbox.east / TILE_DEG);
    const iyMin = Math.floor(bbox.south / TILE_DEG);
    const iyMax = Math.floor(bbox.north / TILE_DEG);
    if ((ixMax - ixMin + 1) * (iyMax - iyMin + 1) > MAX_TILES) {
      throw new PlacesApiError("invalid", "Demo modunda tarama alanı çok büyük.");
    }
    const wantEnrich = fields.includes("websiteUri") || fields.includes("userRatingCount");
    const cx = (bbox.west + bbox.east) / 2;
    const cy = (bbox.south + bbox.north) / 2;
    const nearby = loadCities().filter((c) => Math.abs(c.lat - cy) < 1.2 && Math.abs(c.lng - cx) < 1.8);
    const out: Candidate[] = [];

    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const tileLat = (iy + 0.5) * TILE_DEG;
        const tileLng = (ix + 0.5) * TILE_DEG;
        const near = nearestCityIn(nearby, tileLat, tileLng);
        if (!near) continue;
        const radius = defaultRadiusKm(near.city.pop);
        const scale = Math.max(2.5, radius / 2.2);
        const amp = Math.min(6, Math.max(0.4, near.city.pop / 60_000));
        const base = amp * Math.exp(-near.km / scale);
        if (base < 0.02) continue;

        for (const type of types) {
          const lambda = base * (TYPE_WEIGHT[type] ?? 0.3);
          const countRand = mulberry32(fnv1a(`n:${ix}:${iy}:${type}`))();
          const n = Math.floor(lambda + countRand);
          for (let i = 0; i < n; i++) {
            const p = this.makePlace(ix, iy, type, i, near.city, epoch, wantEnrich);
            if (!p) continue;
            if (p.place.businessStatus === "FUTURE_OPENING" && !includeFuture) continue;
            if (
              p.place.lat < bbox.south ||
              p.place.lat > bbox.north ||
              p.place.lng < bbox.west ||
              p.place.lng > bbox.east
            ) {
              continue;
            }
            out.push(p);
          }
        }
      }
    }
    return out.sort((a, b) => a.rank - b.rank || a.place.placeId.localeCompare(b.place.placeId));
  }

  private makePlace(
    ix: number,
    iy: number,
    type: string,
    i: number,
    city: City,
    epoch: number,
    enrich: boolean,
  ): Candidate | null {
    const id = demoId(ix, iy, type, i);
    const rnd = mulberry32(fnv1a(id));
    const lat = (iy + rnd()) * TILE_DEG;
    const lng = (ix + rnd()) * TILE_DEG;
    const isFuture = rnd() < 0.05;
    const futureUntil = 1 + Math.floor(rnd() * 2);
    const lateBirth = !isFuture && rnd() < 0.08;
    const birth = lateBirth ? 1 + Math.floor(rnd() * 3) : 0;
    if (epoch < birth) return null;

    const parts = NAME_PARTS[type] ?? NAME_PARTS.cafe!;
    const name = `${parts.adj[Math.floor(rnd() * parts.adj.length)]} ${parts.noun[Math.floor(rnd() * parts.noun.length)]}`;
    const street = `${1 + Math.floor(rnd() * 140)} ${STREETS[Math.floor(rnd() * STREETS.length)]} ${STREET_SUFFIX[Math.floor(rnd() * STREET_SUFFIX.length)]}`;
    const openingIso = `2027-${String(1 + Math.floor(rnd() * 6)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 27)).padStart(2, "0")}`;
    const ratingRand = rnd();

    const future = isFuture && epoch < futureUntil;
    const place: PlaceRecord = {
      placeId: id,
      source: "demo",
      name,
      formattedAddress: `${street}, ${city.ascii}`,
      lat,
      lng,
      countryCode: city.cc,
      city: city.ascii,
      primaryType: type,
      types: [type, "food", "point_of_interest", "establishment"],
      businessStatus: future ? "FUTURE_OPENING" : "OPERATIONAL",
      openingDate: future ? openingIso : undefined,
      googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`,
    };
    if (enrich) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      place.website = `https://www.${slug}-${ix.toString(36).replace("-", "m")}.example`;
      place.phone = `020 7946 0${String(Math.floor(rnd() * 900) + 100)}`;
      place.intlPhone = `+44 20 7946 0${String(Math.floor(rnd() * 900) + 100)}`;
      place.userRatingCount = future
        ? 0
        : lateBirth
          ? Math.floor(ratingRand * 7)
          : 4 + Math.floor(ratingRand * ratingRand * 900);
    }
    return { place, rank: fnv1a(`rank:${id}`) };
  }
}
