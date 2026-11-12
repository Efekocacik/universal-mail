import type { NoveltySignal } from "@/lib/domain/types";
import { hasTranslation, t, type Locale, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Yenilik sinyalinin arayüz dilindeki gerekçesi. Gerekçe KALICI saklanır (Türkçe); Faz 4'te parametreli sinyaller
 * (`params`) `novelty.signal.<id>` anahtarıyla yerelleştirilir. Parametre gerektiren anahtar parametresiz eski satıra
 * uygulanmaz (yer tutucu görünmesin); o zaman saklı metin gösterilir.
 */
export function signalText(s: NoveltySignal, locale?: Locale): string {
  const key = `novelty.signal.${s.id}`;
  if (!(key in tr)) return s.reason;
  const template = tr[key as TrKey];
  if (template.includes("{") && !s.params) return s.reason;
  if (locale && locale !== "tr" && !hasTranslation(key as TrKey, locale)) return s.reason;
  return t(key as TrKey, s.params, locale);
}
