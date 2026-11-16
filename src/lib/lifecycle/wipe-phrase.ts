/**
 * Faz 6 (paket Y.6): "Tüm verilerimi sil" onay ifadesi. Saf modül (Node bağımlılığı yok): sunucu (`scheduleWipe`) ve
 * arayüz (düğmeyi ifade tutunca açmak) aynı kuralı kullanır. TR veya EN ifadesi kabul edilir; büyük/küçük harf, I/İ
 * farkı ve fazla boşluk önemsizdir.
 */
export const WIPE_PHRASES = ["VERİLERİMİ SİL", "DELETE MY DATA"] as const;

/** Büyük harf (Türkçe kurallarıyla) + noktalı/noktasız I farkı yok sayılır + boşluklar tekleşir. */
function foldPhrase(s: string): string {
  return s
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "I");
}

/** Yazılan onay ifadesi TR veya EN ifadeyle eşleşiyor mu? */
export function wipePhraseMatches(input: string): boolean {
  const v = foldPhrase(input);
  return WIPE_PHRASES.some((p) => foldPhrase(p) === v);
}
