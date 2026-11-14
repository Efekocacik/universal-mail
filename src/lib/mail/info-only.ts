/**
 * Faz 5: gönderimde ASLA kullanılmayan, yalnızca bilgi amaçlı şablon dilleri (saf; istemci de kullanır).
 * Almanca: DE/AT/CH için ülke politikası hem demo hem canlıda `blocked` (UWG § 7: B2B soğuk e-posta için önceden
 * açık rıza); şablon örnek olarak durur. `templates.info_only` bu listeden türetilir (seed, oluşturma, güncelleme,
 * çoğaltma); API ile yazılamaz.
 */
export const INFO_ONLY_LANGUAGES: readonly string[] = ["de"];

export function isInfoOnlyLanguage(language: string): boolean {
  return INFO_ONLY_LANGUAGES.includes(language);
}
