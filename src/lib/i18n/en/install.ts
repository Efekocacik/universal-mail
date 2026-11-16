import type { install as TrInstall } from "../tr/install";
import type { EnFragment } from "../types";

/** Package K (Faz 6): "Finish setting up" card, migration-recovery dialogs used by Electron, menu additions. */
export const install = {
  "onboarding.title": "Finish setting up",
  "onboarding.progress": "{done}/{total} done",
  "electron.migrate.title": "The database could not be updated",
} as const satisfies EnFragment<typeof TrInstall>;
