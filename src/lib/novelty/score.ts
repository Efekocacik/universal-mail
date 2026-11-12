import type { NoveltyLabel, NoveltySignal } from "@/lib/domain/types";

/**
 * Yenilik skoru (SRS 4.2). Skor, işletmenin YENİ AÇILMIŞ OLMA İHTİMALİNİ gösterir; kesin açılış
 * tarihi veya doğrulanmış bilgi değildir.
 *
 * Sinyaller gruplanır; aynı gruptan yalnızca EN YÜKSEK puan sayılır (mükerrer puanlamayı önler).
 * Toplam 100 ile sınırlanır. Sicil ve alan adı yaşı gibi sonraki faz sinyalleri `extraSignals` ile
 * bu fonksiyonu değiştirmeden eklenir.
 */
export interface NoveltyConfig {
  highAt: number;
  likelyAt: number;
  newWindowDays: number;
  /**
   * Faz 4: "genç alan adı" penceresi (gün; ayar `novelty.domainYoungDays`). Verilmezse (RDAP kapalı) alan adı yaşı
   * sinyali üretilmez.
   */
  domainYoungDays?: number;
}

export const DEFAULT_NOVELTY_CONFIG: NoveltyConfig = {
  highAt: 60,
  likelyAt: 30,
  newWindowDays: 60,
};

export interface NoveltyInput {
  businessStatus?: string | null;
  userRatingCount?: number | null;
  /** Snapshot karşılaştırmasıyla "yeni tespit edildi" olarak işaretlendiği an (ms). */
  newDetectedAt?: number | null;
  /** FUTURE_OPENING → OPERATIONAL geçişinin gözlendiği an (ms). */
  openedDetectedAt?: number | null;
  /** Faz 4: işletmenin web sitesi alan adının RDAP kayıt tarihi (ms). */
  domainRegisteredAt?: number | null;
  extraSignals?: NoveltySignal[];
  now?: number;
}

export interface NoveltyResult {
  score: number;
  label: NoveltyLabel;
  signals: NoveltySignal[];
}

const DAY_MS = 86_400_000;

function within(ts: number | null | undefined, now: number, days: number): boolean {
  return typeof ts === "number" && now - ts <= days * DAY_MS && now - ts >= -DAY_MS;
}

export function computeNovelty(
  input: NoveltyInput,
  config: NoveltyConfig = DEFAULT_NOVELTY_CONFIG,
): NoveltyResult {
  const now = input.now ?? Date.now();

  if (input.businessStatus === "CLOSED_PERMANENTLY") {
    return { score: 0, label: "low", signals: [] };
  }

  const signals: NoveltySignal[] = [];

  if (input.businessStatus === "FUTURE_OPENING") {
    // Gerekçe metni KALICI saklanır; bu yüzden Google'dan gelen açılış tarihi metne yazılmaz (arayüz tarihi önbellekten gösterir).
    signals.push({
      id: "future_opening",
      group: "lifecycle",
      points: 100,
      reason:
        'Google bu işletmeyi "yakında açılacak" olarak bildiriyor. Tedarikçi aradığı anlamına gelmez.',
    });
  }
  if (within(input.openedDetectedAt, now, config.newWindowDays)) {
    signals.push({
      id: "opened_transition",
      group: "lifecycle",
      points: 90,
      reason: `"Yakında açılacak" iken artık faaliyette olarak görüldü (son ${config.newWindowDays} gün içinde).`,
    });
  }
  if (within(input.newDetectedAt, now, config.newWindowDays)) {
    signals.push({
      id: "new_in_snapshot",
      group: "lifecycle",
      points: 70,
      reason: `Önceki taramada yoktu, son taramada bulundu (son ${config.newWindowDays} gün içinde). Gerçek açılış tarihini kanıtlamaz.`,
    });
  }

  const ratings = input.userRatingCount;
  if (typeof ratings === "number") {
    if (ratings <= 5) {
      signals.push({
        id: "reviews_very_few",
        group: "reviews",
        points: 25,
        reason: "Çok az değerlendirme var. Tek başına yeni olduğunu göstermez.",
      });
    } else if (ratings <= 20) {
      signals.push({
        id: "reviews_few",
        group: "reviews",
        points: 10,
        reason: "Az sayıda değerlendirme var. Düşük güvenilirlikte bir gösterge.",
      });
    }
  }

  const young = config.domainYoungDays;
  const reg = input.domainRegisteredAt;
  if (typeof young === "number" && typeof reg === "number" && within(reg, now, young)) {
    const months = Math.max(1, Math.round((now - reg) / (30.44 * DAY_MS)));
    signals.push({
      id: "domain_young",
      group: "domain",
      points: 20,
      reason: `Web sitesinin alan adı yaklaşık ${months} ay önce kaydedilmiş. Yeni bir işletme olabilir; kanıt değildir.`,
      params: { months, days: young },
    });
  }

  signals.push(...(input.extraSignals ?? []));

  const bestByGroup = new Map<string, number>();
  for (const s of signals)
    bestByGroup.set(s.group, Math.max(bestByGroup.get(s.group) ?? 0, s.points));
  const score = Math.min(
    100,
    [...bestByGroup.values()].reduce((a, b) => a + b, 0),
  );

  const label: NoveltyLabel =
    input.businessStatus === "FUTURE_OPENING"
      ? "future_opening"
      : score >= config.highAt
        ? "high"
        : score >= config.likelyAt
          ? "likely"
          : "low";

  return { score, label, signals };
}
