/**
 * Temas sıklığı sınırları (SRS 5.6.1, FR-CMP-11).
 *
 * Varsayılanlar yazılıma gömülüdür ve yalnızca SIKILAŞTIRILABİLİR: azaltılabilen sınırlar (mesaj sayısı) daha küçük,
 * süreler daha uzun yapılabilir. Gevşetme isteği hata verir; sessizce kabul edilmez.
 *
 * Kuralların SRS'e göre yorumu:
 *  - Bir iletişim dizisinde (kampanyadaki bir alıcı) en fazla 3 mesaj: ilk e-posta + 2 takip.
 *  - Takipler arasında en az 5 gün (kampanya adımı daha uzun bir süre isterse o geçerlidir).
 *  - Yanıtsız tamamlanan diziden sonra en az 180 gün yeni kampanya yok.
 *  - Diğer durumlarda aynı adrese farklı kampanyalar arasında en az 30 gün.
 *  - Aynı alan adına aynı (UTC) günde en fazla 1 kampanya iletisi (veritabanı dizini de zorlar).
 */

export interface FrequencyLimits {
  maxMessagesPerSequence: number;
  minFollowupGapDays: number;
  restAfterSequenceDays: number;
  crossCampaignGapDays: number;
  maxDomainMessagesPerDay: number;
}

export const DEFAULT_FREQUENCY_LIMITS: Readonly<FrequencyLimits> = Object.freeze({
  maxMessagesPerSequence: 3,
  minFollowupGapDays: 5,
  restAfterSequenceDays: 180,
  crossCampaignGapDays: 30,
  maxDomainMessagesPerDay: 1,
});

/** Sınırın hangi yönde sıkılaştığı: `max` → küçültmek, `min` → büyütmek. */
const DIRECTION: Record<keyof FrequencyLimits, "max" | "min"> = {
  maxMessagesPerSequence: "max",
  minFollowupGapDays: "min",
  restAfterSequenceDays: "min",
  crossCampaignGapDays: "min",
  maxDomainMessagesPerDay: "max",
};

/** Makul üst sınırlar (yanlış girişle sonsuz bekleme oluşmasın). */
const CEILING: Record<keyof FrequencyLimits, number> = {
  maxMessagesPerSequence: 3,
  minFollowupGapDays: 90,
  restAfterSequenceDays: 3650,
  crossCampaignGapDays: 3650,
  maxDomainMessagesPerDay: 1,
};

export class FrequencyLimitError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Varsayılanlar üzerine yalnızca DAHA SIKI değerleri uygular. Bilinmeyen alan, tam sayı olmayan değer veya
 * gevşetme hata verir.
 */
export function tightenFrequencyLimits(
  overrides: Partial<Record<string, unknown>> = {},
  base: Readonly<FrequencyLimits> = DEFAULT_FREQUENCY_LIMITS,
): FrequencyLimits {
  const out: FrequencyLimits = { ...base };
  for (const [key, raw] of Object.entries(overrides)) {
    if (!(key in DIRECTION)) throw new FrequencyLimitError(key, `Bilinmeyen sınır: ${key}`);
    const field = key as keyof FrequencyLimits;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new FrequencyLimitError(field, `${field} negatif olmayan bir tam sayı olmalıdır.`);
    }
    const current = base[field];
    const looser = DIRECTION[field] === "max" ? raw > current : raw < current;
    if (looser) {
      throw new FrequencyLimitError(
        field,
        `${field} yalnızca sıkılaştırılabilir (şu an ${current}).`,
      );
    }
    if (DIRECTION[field] === "min" && raw > CEILING[field]) {
      throw new FrequencyLimitError(field, `${field} en çok ${CEILING[field]} olabilir.`);
    }
    out[field] = raw;
  }
  return out;
}

/** Verilen sınırlar varsayılanlardan gevşek mi? (Dışarıdan gelen sınır nesnesini doğrulamak için.) */
export function isAtLeastAsStrict(limits: FrequencyLimits): boolean {
  return (Object.keys(DIRECTION) as (keyof FrequencyLimits)[]).every((k) => {
    const v = limits[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return false;
    return DIRECTION[k] === "max"
      ? v <= DEFAULT_FREQUENCY_LIMITS[k]
      : v >= DEFAULT_FREQUENCY_LIMITS[k];
  });
}

export const DAY_MS = 86_400_000;

/** Gönderimin UTC günü "YYYY-MM-DD" (`messages.send_day` ile aynı biçim). */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function addDays(at: number, days: number): number {
  return at + days * DAY_MS;
}
