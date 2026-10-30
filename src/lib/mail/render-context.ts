import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { leads } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import type { SenderProfile } from "./footer";
import type { TemplateLanguage } from "./language";
import type { VariableValues } from "./template-engine";

/**
 * Şablon değişkenlerinin değerleri. Yalnızca BİZİM verimiz kullanılır:
 *  - lead: kullanıcının girdiği görünen ad, GeoNames'ten türetilen şehir, kendi kategori etiketimiz;
 *  - gönderen: firma profili (eksikse değer boş kalır; UYDURULMAZ);
 *  - sistem: çıkış bağlantısı (alt bilgiyi üreten taraf verir).
 * Google oturum önbelleği (işletme adı, açılış tarihi) bilerek OKUNMAZ.
 */

/** Kategori anahtarı → e-posta metninde kullanılacak tekil ad. Diğer diller İngilizceye düşer. */
export const CATEGORY_LABELS: Readonly<Record<string, { tr: string; en: string }>> = {
  cafe: { tr: "kafe", en: "café" },
  pub: { tr: "bar", en: "pub" },
  restaurant: { tr: "restoran", en: "restaurant" },
  bakery: { tr: "fırın", en: "bakery" },
  hotel: { tr: "otel", en: "hotel" },
  catering: { tr: "catering işletmesi", en: "catering business" },
  health: { tr: "klinik", en: "clinic" },
  education: { tr: "eğitim kurumu", en: "school" },
  office: { tr: "ofis", en: "office" },
  wellness: { tr: "spor ve bakım merkezi", en: "wellness centre" },
  convenience: { tr: "market", en: "convenience store" },
};

export function categoryLabel(
  key: string | null | undefined,
  language: TemplateLanguage,
): string | null {
  if (!key) return null;
  const l = CATEGORY_LABELS[key];
  if (!l) return null;
  return language === "tr" ? l.tr : l.en;
}

export interface RenderContext {
  values: VariableValues;
  profile: SenderProfile | null;
  /** Lead'in ülkesi (dil önerisi için). */
  countryCode: string | null;
}

export class RenderContextError extends Error {
  constructor(readonly kind: "lead_not_found") {
    super("Lead bulunamadı.");
  }
}

export async function buildRenderContext(
  db: DbExecutor,
  leadId: number,
  language: TemplateLanguage,
): Promise<RenderContext> {
  const [lead] = await db
    .select({
      displayName: leads.displayName,
      city: leads.city,
      categoryKey: leads.categoryKey,
      countryCode: leads.countryCode,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) throw new RenderContextError("lead_not_found");
  const profile = (await getSetting(db, "company.profile")) ?? null;

  const values: VariableValues = {
    isletme_adi: lead.displayName,
    sehir: lead.city,
    kategori: categoryLabel(lead.categoryKey, language),
    gonderen_ad: profile?.contactName,
    firma: profile?.legalName,
    firma_adres: profile?.address,
    telefon: profile?.phone,
    // cikis_linki: alt bilgiyi üreten taraf (gerçek veya demo bağlantı) doldurur.
  };
  return { values, profile, countryCode: lead.countryCode };
}
