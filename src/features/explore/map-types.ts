import type { BBox } from "@/lib/client/types";
import type { DraftRegion, DrawMode, FocusRequest } from "./state";

/** Nokta biçimi API'den: [leadId, lat, lng, etiketKodu, durumKodu] */
export type MapPoint = number[];

/** Etiket kodu → renk (SRS 9): 0 mor (yakında açılacak), 1 yeşil (yüksek), 2 sarı (muhtemel), 3 gri (düşük). */
export const LABEL_COLORS = ["#7c3aed", "#16a34a", "#d4a017", "#9aa0a8"] as const;

export interface MapViewProps {
  points: MapPoint[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  draft: DraftRegion | null;
  onDraftChange: (r: DraftRegion | null) => void;
  drawMode: DrawMode;
  onDrawn: (r: DraftRegion) => void;
  onBoundsChange: (b: BBox) => void;
  focus: FocusRequest | null;
}
