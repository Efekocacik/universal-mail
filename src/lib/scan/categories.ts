import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { categorySets } from "@/lib/db/schema";

/**
 * Yerleşik kategori kümeleri (SRS 3). `placeTypes`, Google Places Table A tür adlarıdır. Her tür
 * ayrı bir arama sorgusu demek olduğundan çekirdek türlerle sınırlı tutulmuştur; kullanıcı ayarlardan
 * kendi tür ve anahtar kelimelerini ekleyebilir. Tür adları ilk gerçek API çağrısında doğrulanır
 * (geçersiz tür 400 döner, yalnızca o sorgu başarısız olur).
 */
export interface BuiltInCategory {
  key: string;
  name: string;
  placeTypes: string[];
  keywords: string[];
  priority: 1 | 2 | 3;
  defaultEnabled: boolean;
}

export const BUILTIN_CATEGORIES: readonly BuiltInCategory[] = [
  {
    key: "cafe",
    name: "Kafe / kahveci",
    placeTypes: ["cafe", "coffee_shop"],
    keywords: [],
    priority: 3,
    defaultEnabled: true,
  },
  {
    key: "pub",
    name: "Bar / pub",
    placeTypes: ["pub", "bar"],
    keywords: [],
    priority: 3,
    defaultEnabled: true,
  },
  {
    key: "restaurant",
    name: "Restoran / paket servis",
    placeTypes: ["restaurant", "fast_food_restaurant", "meal_takeaway"],
    keywords: [],
    priority: 3,
    defaultEnabled: false,
  },
  {
    key: "bakery",
    name: "Fırın / pastane / tatlıcı",
    placeTypes: ["bakery", "dessert_shop", "ice_cream_shop"],
    keywords: [],
    priority: 3,
    defaultEnabled: false,
  },
  {
    key: "hotel",
    name: "Otel / hostel / pansiyon",
    placeTypes: ["hotel", "hostel", "bed_and_breakfast"],
    keywords: [],
    priority: 2,
    defaultEnabled: false,
  },
  {
    key: "catering",
    name: "Catering / etkinlik mekânı",
    placeTypes: ["catering_service", "event_venue", "wedding_venue"],
    keywords: [],
    priority: 2,
    defaultEnabled: false,
  },
  {
    key: "health",
    name: "Hastane / klinik / diş",
    placeTypes: ["hospital", "dental_clinic", "physiotherapist"],
    keywords: [],
    priority: 2,
    defaultEnabled: false,
  },
  {
    key: "education",
    name: "Kreş / okul / üniversite",
    placeTypes: ["child_care_agency", "preschool", "school", "university"],
    keywords: [],
    priority: 1,
    defaultEnabled: false,
  },
  {
    key: "office",
    name: "Ofis / ortak çalışma alanı",
    placeTypes: ["corporate_office", "coworking_space"],
    keywords: [],
    priority: 1,
    defaultEnabled: false,
  },
  {
    key: "wellness",
    name: "Spor salonu / güzellik / spa",
    placeTypes: ["gym", "beauty_salon", "hair_salon", "spa"],
    keywords: [],
    priority: 1,
    defaultEnabled: false,
  },
  {
    key: "convenience",
    name: "Benzinlik market / büfe / kantin",
    placeTypes: ["gas_station", "convenience_store", "cafeteria"],
    keywords: [],
    priority: 1,
    defaultEnabled: false,
  },
];

/**
 * Yerleşik kategorileri ekler. Mevcut kayıtların kullanıcı ayarları (etkin mi, eklenen anahtar kelime/tür)
 * ASLA ezilmez; yalnızca eksik olanlar eklenir. Böylece sürüm güncellemesinde yeni kategori gelir ama
 * kullanıcının seçimleri korunur.
 */
export async function seedCategories(db: Db): Promise<number> {
  let inserted = 0;
  for (const [i, c] of BUILTIN_CATEGORIES.entries()) {
    const existing = await db
      .select({ id: categorySets.id })
      .from(categorySets)
      .where(eq(categorySets.key, c.key))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(categorySets).values({
      key: c.key,
      name: c.name,
      placeTypes: c.placeTypes,
      keywords: c.keywords,
      enabled: c.defaultEnabled,
      builtIn: true,
      priority: c.priority,
      sortOrder: i,
    });
    inserted++;
  }
  return inserted;
}
