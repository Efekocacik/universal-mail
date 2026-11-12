/**
 * Sözlük parçası türleri. Türkçe parça (`tr/<paket>.ts`) kaynaktır; İngilizce parça (`en/<paket>.ts`) aynı anahtarların
 * bir ALT kümesini içerir (`EnFragment`): olmayan anahtar Türkçeye düşer ve `tests/i18n.test.ts` eksikleri raporlar.
 * Türkçede olmayan bir anahtar İngilizceye yazılırsa `satisfies EnFragment<…>` derleme hatası verir.
 */
export type EnFragment<T> = { readonly [K in keyof T]?: string };
