import { database, HttpError, json, route } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { audit } from "@/lib/db/audit";
import { setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const db = await database();
  const state = await getSetupState(db);
  if (state.missing.length > 0) {
    throw new HttpError(400, `Kurulum tamamlanamadı. Eksikler: ${state.missing.join(", ")}.`, {
      missing: state.missing,
    });
  }
  await setSetting(db, "setup.completed", true);
  await audit(db, "setup.completed");
  return json({ ok: true });
});
