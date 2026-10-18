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
}

export const DEFAULT_NOVELTY_CONFIG: NoveltyConfig = {
  highAt: 60,
  likelyAt: 30,
  newWindowDays: 60,
};

export interface NoveltyInput {
  businessStatus?: string | null;
  openingDate?: string | null;
  userRatingCount?: number | null;
  /** Snapshot karşılaştırmasıyla "yeni tespit edildi" olarak işaretlendiği an (ms). */
  newDetectedAt?: number | null;
  /** FUTURE_OPENING → OPERATIONAL geçişinin gözlendiği an (ms). */
  openedDetectedAt?: number | null;
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
    const when = input.openingDate ? ` (beklenen açılış: ${input.openingDate})` : "";
    signals.push({
      id: "future_opening",
      group: "lifecycle",
      points: 100,
      reason: `Google bu işletmeyi "yakında açılacak" olarak bildiriyor${when}. Tedarikçi aradığı anlamına gelmez.`,
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
        reason: `Çok az değerlendirme var (${ratings}). Tek başına yeni olduğunu göstermez.`,
      });
    } else if (ratings <= 20) {
      signals.push({
        id: "reviews_few",
        group: "reviews",
        points: 10,
        reason: `Az sayıda değerlendirme var (${ratings}). Düşük güvenilirlikte bir gösterge.`,
      });
    }
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
