import type { CampaignStatus } from "@/lib/client/campaigns";

/**
 * Kuyruk tablosundaki "Hariç tutulanları yeniden denetle" alanının görünümü (saf; DOM'suz test edilir).
 *
 *  - `button`: taslak/hazır kampanyada hariç tutulan alıcı varsa düğme gösterilir.
 *  - `closed`: kampanya başlamışsa (çalışıyor/duraklatıldı) başlatma planı dondurulmuştur; düğme gizlenir ve NEDENİ
 *    açıklanır (yeni alıcılar yeni bir kampanyaya eklenmeli).
 *  - `null`: gösterilecek bir şey yok (hariç tutulan yok veya kampanya kapandı).
 */
export type ReevaluateView = "button" | "closed" | null;

export const REEVALUATE_OPEN: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  "draft",
  "ready",
]);
export const REEVALUATE_FROZEN: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  "running",
  "paused",
]);

export function reevaluateView(
  status: CampaignStatus | undefined,
  excludedCount: number,
): ReevaluateView {
  if (status === undefined || excludedCount <= 0) return null;
  if (REEVALUATE_OPEN.has(status)) return "button";
  if (REEVALUATE_FROZEN.has(status)) return "closed";
  return null;
}

/** Hariç tutulan sayısı hangi durumlarda sorgulanır (gereksiz istek atılmaz). */
export function shouldCountExcluded(status: CampaignStatus | undefined): boolean {
  return status !== undefined && (REEVALUATE_OPEN.has(status) || REEVALUATE_FROZEN.has(status));
}

/** Dizi, alıcıdan gelen ve incelemede bekleyen bir yanıt yüzünden mi bekletiliyor (Faz 4, 9a)? */
export function isReviewHold(lastError: string | null | undefined): boolean {
  return (lastError ?? "").split(",").includes("inbound_review_pending");
}
