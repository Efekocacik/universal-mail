import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { purgeDemoData } from "@/lib/leads/mutations";
import { getSetting, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Demo modu araçları: "zamanı ilerlet" (14 gün sonraki tarama simülasyonu) ve demo verileri temizle. */
export const POST = route(async (req: Request) => {
  const db = await database();
  const { action } = await body(req, z.object({ action: z.enum(["advance", "reset", "purge"]) }));
  if (action === "purge") {
    const res = await purgeDemoData(db);
    await setSetting(db, "mock.epoch", 0);
    return json({ ok: true, ...res });
  }
  if ((await getSetting(db, "places.provider")) !== "mock")
    throw new HttpError(409, "Bu işlem yalnızca demo modunda kullanılabilir.");
  const epoch = await getSetting(db, "mock.epoch");
  const next = action === "advance" ? Math.min(epoch + 1, 50) : 0;
  await setSetting(db, "mock.epoch", next);
  await audit(db, "demo.epoch", undefined, undefined, { epoch: next });
  return json({ ok: true, epoch: next });
});
