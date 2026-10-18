import { Badge } from "@/components/ui/badge";
import type { NoveltyLabel } from "@/lib/client/types";
import { t } from "@/lib/i18n";

const VARIANT = { future_opening: "future", high: "high", likely: "likely", low: "low" } as const;

export function NoveltyBadge({
  label,
  score,
  showScore = false,
}: {
  label: NoveltyLabel;
  score?: number;
  showScore?: boolean;
}) {
  return (
    <Badge variant={VARIANT[label]}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t(`novelty.${label}`)}
      {showScore && score !== undefined && <span className="tabular opacity-80">· {score}</span>}
    </Badge>
  );
}

export const NOVELTY_DOT: Record<NoveltyLabel, string> = {
  future_opening: "bg-nov-future",
  high: "bg-nov-high",
  likely: "bg-nov-likely",
  low: "bg-nov-low",
};
