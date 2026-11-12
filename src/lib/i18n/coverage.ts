import { EN_FRAGMENTS } from "./en";
import { TR_FRAGMENTS, type FragmentName, type TrKey } from "./tr";

/**
 * İngilizce kapsam raporu (yalnızca testler ve geliştirici araçları; arayüz paketine girmez). Her Türkçe parça için
 * İngilizcesi olmayan anahtarları ve yer tutucusu ({n}, {region}…) Türkçeyle uyuşmayan çevirileri listeler.
 */
export interface FragmentCoverage {
  fragment: FragmentName;
  total: number;
  translated: number;
  missing: TrKey[];
  /** Türkçede olup İngilizcede olmayan (veya tersi) yer tutucular. */
  placeholderMismatch: TrKey[];
}

const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

export function enCoverage(): FragmentCoverage[] {
  return (Object.keys(TR_FRAGMENTS) as FragmentName[]).map((fragment) => {
    const trFrag = TR_FRAGMENTS[fragment] as Record<string, string>;
    const enFrag = EN_FRAGMENTS[fragment] as Record<string, string | undefined>;
    const keys = Object.keys(trFrag) as TrKey[];
    const missing = keys.filter((k) => enFrag[k] === undefined);
    const placeholderMismatch = keys.filter((k) => {
      const e = enFrag[k];
      return e !== undefined && placeholders(e).join() !== placeholders(trFrag[k]!).join();
    });
    return {
      fragment,
      total: keys.length,
      translated: keys.length - missing.length,
      missing,
      placeholderMismatch,
    };
  });
}

/** Tek satırlık özet: "base 0/1673, notifications 31/31, …". */
export function formatCoverage(rows: FragmentCoverage[]): string {
  return rows.map((r) => `${r.fragment} ${r.translated}/${r.total}`).join(", ");
}
