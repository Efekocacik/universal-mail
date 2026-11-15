import type { CategoryTemplateInput, StepInput, TemplateItem } from "@/lib/client/campaigns";

/**
 * Sihirbazın "Kategori varyantları" bölümünün saf mantığı (DOM'suz; node testleriyle doğrulanır). Sunucu kurallarının
 * yerine GEÇMEZ: dil/tür uyumu ve bilgi amaçlı şablon reddi API'dedir (`CATEGORY_TEMPLATE_MISMATCH`,
 * `TEMPLATE_INFO_ONLY`). Arayüz yalnızca ilk e-posta (adım 0) için varyant seçtirir; API her adımı destekler. API ile
 * takip adımlarına yazılmış varyantlar sihirbazdan kaydederken KORUNUR (`preservedFollowupVariants`).
 */

/** Seçim anahtarı: `<dil>|<kategori>` → şablon kimliği (0 = kullanılmıyor). */
export type VariantSelection = Record<string, number>;

export const variantKey = (language: string, categoryKey: string) => `${language}|${categoryKey}`;

/** Gönderimde kullanılabilir şablon mu (arşivli ve bilgi amaçlı değil)? */
const usable = (t: TemplateItem, kind: "initial" | "followup") =>
  t.kind === kind && !t.archived && !t.infoOnly;
const usableInitial = (t: TemplateItem) => usable(t, "initial");

export interface VariantOption {
  language: string;
  categoryKey: string;
  templates: TemplateItem[];
}

/** Seçili dillerde kategoriye özel ilk e-posta şablonları (dil, kategori sırasıyla). */
export function variantOptions(
  templates: readonly TemplateItem[],
  languages: readonly string[],
): VariantOption[] {
  const map = new Map<string, VariantOption>();
  for (const t of templates) {
    if (!usableInitial(t) || !t.categoryKey || !languages.includes(t.language)) continue;
    const k = variantKey(t.language, t.categoryKey);
    const o = map.get(k) ?? { language: t.language, categoryKey: t.categoryKey, templates: [] };
    o.templates.push(t);
    map.set(k, o);
  }
  return [...map.values()].sort(
    (a, b) => a.language.localeCompare(b.language) || a.categoryKey.localeCompare(b.categoryKey),
  );
}

/**
 * Bir dil seçildiğinde önerilen varyantlar: her kategorinin ilk (en eski) şablonu. Var olan seçim korunur.
 * Sözleşmeden fark (bilinçli): öneri kampanyanın lead kategorilerinden değil, o dildeki TÜM kategori şablonlarından
 * yapılır; sihirbazda "Adımlar" adımı "Alıcılar"dan önce gelir, bu anda kampanyada henüz lead yoktur. Kategorisi
 * kampanyada bulunmayan varyant zararsızdır (hiçbir lead'e eşleşmez) ve işareti kaldırılabilir.
 */
export function suggestVariants(
  templates: readonly TemplateItem[],
  language: string,
  current: VariantSelection,
): VariantSelection {
  const next = { ...current };
  for (const o of variantOptions(templates, [language])) {
    const k = variantKey(o.language, o.categoryKey);
    if (next[k] === undefined) next[k] = o.templates[0]!.id;
  }
  return next;
}

/** Kayıtlı adımlardan seçim (yalnızca adım 0). */
export function selectionFromSteps(steps: readonly StepInput[]): VariantSelection {
  const out: VariantSelection = {};
  for (const s of steps) {
    if (s.stepIndex !== 0) continue;
    for (const c of s.categoryTemplates ?? [])
      out[variantKey(s.language, c.categoryKey)] = c.templateId;
  }
  return out;
}

/** Bir dilin adım 0'ına yazılacak varyantlar (kullanılan, kategoriye göre sıralı). */
export function categoryTemplatesFor(
  language: string,
  sel: VariantSelection,
): CategoryTemplateInput[] {
  return Object.entries(sel)
    .filter(([k, id]) => id > 0 && k.startsWith(`${language}|`))
    .map(([k, templateId]) => ({ categoryKey: k.slice(language.length + 1), templateId }))
    .sort((a, b) => a.categoryKey.localeCompare(b.categoryKey));
}

/** Şablon listesinde A/B konusu (B konusu) olan şablon mu? */
export function hasAbSubject(templates: readonly TemplateItem[], templateId: number): boolean {
  return !!templates.find((t) => t.id === templateId)?.subjectB;
}

/** Kaydedilemeyecek (artık listelenmeyen) varyant seçimi: şablon arşivlenmiş, bilgi amaçlı ya da dili/türü değişmiş. */
export interface StaleVariant {
  stepIndex: number;
  language: string;
  categoryKey: string;
  templateId: number;
}

/**
 * Adım 0 seçiminden, şablonu artık o (dil, kategori) satırında listelenmeyenleri ayırır. Böyle bir seçim gönderilirse
 * her kayıt 400 alır ve satırı görünmediği için kullanıcı işaretini kaldıramaz; bu yüzden kaydedilmez ve arayüz
 * kaldırılacağını söyler.
 */
export function pruneVariantSelection(
  sel: VariantSelection,
  options: readonly VariantOption[],
  /** Seçili (gönderilecek) diller; diğer dillerin seçimi gönderilmez, olduğu gibi kalır. */
  languages: readonly string[],
): { kept: VariantSelection; stale: StaleVariant[] } {
  const listed = new Map(
    options.map((o) => [
      variantKey(o.language, o.categoryKey),
      new Set(o.templates.map((t) => t.id)),
    ]),
  );
  const kept: VariantSelection = {};
  const stale: StaleVariant[] = [];
  for (const [k, id] of Object.entries(sel)) {
    if (id <= 0) continue;
    const sep = k.indexOf("|");
    const language = k.slice(0, sep);
    if (listed.get(k)?.has(id) || !languages.includes(language)) kept[k] = id;
    else stale.push({ stepIndex: 0, language, categoryKey: k.slice(sep + 1), templateId: id });
  }
  return { kept, stale };
}

/**
 * Takip adımlarına (API ile) yazılmış kategori varyantları: sihirbaz bunları seçtirmez ama kaydederken siler de değil.
 * Anahtar `<dil>|<adım>`. Şablonu artık uygun olmayan (arşivli, bilgi amaçlı, dil/tür farklı) varyant `stale`e gider.
 */
export function preservedFollowupVariants(
  existing: readonly StepInput[],
  templates: readonly TemplateItem[],
): { byStep: Record<string, CategoryTemplateInput[]>; stale: StaleVariant[] } {
  const byStep: Record<string, CategoryTemplateInput[]> = {};
  const stale: StaleVariant[] = [];
  for (const s of existing) {
    if (s.stepIndex === 0) continue;
    for (const c of s.categoryTemplates ?? []) {
      const t = templates.find((x) => x.id === c.templateId);
      if (t && usable(t, "followup") && t.language === s.language)
        (byStep[`${s.language}|${s.stepIndex}`] ??= []).push(c);
      else stale.push({ stepIndex: s.stepIndex, language: s.language, ...c });
    }
  }
  return { byStep, stale };
}
