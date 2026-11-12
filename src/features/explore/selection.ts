/**
 * Keşif ekranındaki toplu seçim modeli (saf; React'ten bağımsız ve sınanır).
 *
 * İki kip vardır:
 *  - `ids`: kullanıcının tek tek (veya aralıkla, veya "Görünümdekileri seç" ile) işaretlediği lead'ler. En fazla
 *    `MAX_SELECTION` (2000; e-posta bulma ve toplu uç noktalarla aynı). Süzgeç değişse de korunur; listede görünmeyenler
 *    sayılır ("N tanesi bu listede görünmüyor").
 *  - `query`: "Süzgece uyan tümü" veya sınırı aşan "Görünümdekiler". Seçim, tıklandığı andaki süzgeç sorgusunun
 *    ANLIK GÖRÜNTÜSÜDÜR; süzgeç değişince geçersizleşir ve temizlenir (yanlış kümeye işlem yapılmasın diye).
 * Sessiz kesme yoktur: sınırı aşan tek tek seçim reddedilir ve çağıran kullanıcıya söyler.
 */
export const MAX_SELECTION = 2000;

export type Selection =
  | { mode: "ids"; ids: ReadonlySet<number>; anchor: number | null }
  | {
      mode: "query";
      /** Sunucuya giden süzgeç sorgusu (görünüm seçiminde harita kutusu dahil). */
      filterQuery: string;
      /** Seçim anındaki listenin süzgeç sorgusu; değişirse seçim geçersizdir. */
      basis: string;
      count: number;
      source: "view" | "all";
    };

export const EMPTY_SELECTION: Selection = { mode: "ids", ids: new Set(), anchor: null };

export type SelectionNotice = "cap" | null;
export interface SelectionUpdate {
  selection: Selection;
  notice: SelectionNotice;
}

export function selectionCount(s: Selection): number {
  return s.mode === "ids" ? s.ids.size : s.count;
}

export function isSelected(s: Selection, id: number): boolean {
  return s.mode === "ids" && s.ids.has(id);
}

export function isEmpty(s: Selection): boolean {
  return selectionCount(s) === 0;
}

/** Tek lead'i ekler/çıkarır. Sorgu kipindeyken tek tıklama yeni bir kimlik seçimi başlatır. */
export function toggleId(s: Selection, id: number): SelectionUpdate {
  const ids = new Set(s.mode === "ids" ? s.ids : []);
  if (ids.has(id)) {
    ids.delete(id);
    return { selection: { mode: "ids", ids, anchor: id }, notice: null };
  }
  if (ids.size >= MAX_SELECTION) return { selection: s, notice: "cap" };
  ids.add(id);
  return { selection: { mode: "ids", ids, anchor: id }, notice: null };
}

/**
 * Shift+tıklama: çapa ile hedef arasındaki YÜKLÜ satırları seçime ekler (`ordered`: listedeki sıra). Çapa listede yoksa
 * yalnızca hedefi değiştirir. Sınır aşılırsa hiçbir şey eklenmez.
 */
export function selectRange(
  s: Selection,
  toId: number,
  ordered: readonly number[],
): SelectionUpdate {
  const anchor = s.mode === "ids" ? s.anchor : null;
  const a = anchor === null ? -1 : ordered.indexOf(anchor);
  const b = ordered.indexOf(toId);
  if (a < 0 || b < 0) return toggleId(s, toId);
  const [from, to] = a <= b ? [a, b] : [b, a];
  const ids = new Set(s.mode === "ids" ? s.ids : []);
  for (let i = from; i <= to; i++) ids.add(ordered[i]!);
  if (ids.size > MAX_SELECTION) return { selection: s, notice: "cap" };
  return { selection: { mode: "ids", ids, anchor: toId }, notice: null };
}

/** Kimlik kümesini seçer (ör. görünümdekiler). Sınırı aşarsa çağıran sorgu kipine geçmelidir. */
export function selectIds(ids: readonly number[]): SelectionUpdate {
  const set = new Set(ids);
  if (set.size > MAX_SELECTION) return { selection: EMPTY_SELECTION, notice: "cap" };
  return { selection: { mode: "ids", ids: set, anchor: null }, notice: null };
}

export function selectQuery(
  filterQuery: string,
  basis: string,
  count: number,
  source: "view" | "all",
): Selection {
  if (count <= 0) return EMPTY_SELECTION;
  return { mode: "query", filterQuery, basis, count, source };
}

/** Süzgeç değişti: sorgu seçimi geçersizse temizlenir (`invalidated: true` ise kullanıcıya söylenir). */
export function onFiltersChanged(
  s: Selection,
  basis: string,
): { selection: Selection; invalidated: boolean } {
  if (s.mode === "query" && s.basis !== basis)
    return { selection: EMPTY_SELECTION, invalidated: true };
  return { selection: s, invalidated: false };
}

/** Kimlik seçiminde listede (yüklü satırlarda) görünmeyenlerin sayısı. */
export function hiddenCount(s: Selection, visibleIds: ReadonlySet<number>): number {
  if (s.mode !== "ids") return 0;
  let n = 0;
  for (const id of s.ids) if (!visibleIds.has(id)) n++;
  return n;
}

/** Uç noktalara gidecek seçim biçimi (`/api/leads/bulk`, `/api/export/leads`). */
export function selectionTarget(
  s: Selection,
): { leadIds: number[] } | { filterQuery: string } | null {
  if (isEmpty(s)) return null;
  return s.mode === "ids" ? { leadIds: [...s.ids] } : { filterQuery: s.filterQuery };
}

/** `/api/leads/find-emails` eski alan adını (`filtersQuery`) kullanır. */
export function findEmailsTarget(
  s: Selection,
): { leadIds: number[] } | { filtersQuery: string } | null {
  const t = selectionTarget(s);
  if (!t) return null;
  return "leadIds" in t ? t : { filtersQuery: t.filterQuery };
}

/** Başlıktaki "tümünü seç" kutusunun durumu (saf; sınanır). */
export function headerCheckState(
  selection: Selection,
  loadedIds: readonly number[],
  filterQuery: string,
): boolean | "indeterminate" {
  if (isEmpty(selection)) return false;
  if (selection.mode === "query") return selection.basis === filterQuery ? true : "indeterminate";
  if (loadedIds.length > 0 && loadedIds.every((id) => selection.ids.has(id))) return true;
  return "indeterminate";
}
