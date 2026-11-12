import type { base as TrBase } from "../tr/base";
import type { EnFragment } from "../types";

/** Faz 4 öncesi temel sözlüğün İngilizcesi. Paket D çevirir; çevrilmeyen anahtar Türkçeye düşer ve testte raporlanır. */
export const base = {} as const satisfies EnFragment<typeof TrBase>;
