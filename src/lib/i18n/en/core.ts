import type { core as TrCore } from "../tr/core";
import type { EnFragment } from "../types";

/** Paket D anahtarlarının İngilizcesi. */
export const core = {} as const satisfies EnFragment<typeof TrCore>;
