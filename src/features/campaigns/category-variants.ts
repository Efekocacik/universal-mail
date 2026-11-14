import type { CategoryTemplateInput, StepInput, TemplateItem } from "@/lib/client/campaigns";

/**
 * Sihirbazın "Kategori varyantları" bölümünün saf mantığı (DOM'suz; node testleriyle doğrulanır). Sunucu kurallarının
 * yerine GEÇMEZ: dil/tür uyumu ve bilgi amaçlı şablon reddi API'dedir (`CATEGORY_TEMPLATE_MISMATCH`,
 * `TEMPLATE_INFO_ONLY`). Arayüz yalnızca ilk e-posta (adım 0) için varyant sunar; API her adımı destekler.
 */

/** Seçim anahtarı: `<dil>|<kategori>` → şablon kimliği (0 = kullanılmıyor). */
export type VariantSelection = Record<string, number>;

export const variantKey = (language: string, categoryKey: string) => `${language}|${categoryKey}`;

/** Gönderimde kullanılabilir ilk e-posta şablonu mu (arşivli ve bilgi amaçlı değil)? */
const usableInitial = (t: TemplateItem) => t.kind === "initial" && !t.archived && !t.infoOnly;

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

/** Bir dil seçildiğinde önerilen varyantlar: her kategorinin ilk (en eski) şablonu. Var olan seçim korunur. */
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
