import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { enqueueRdap, syncDomainQueue } from "@/lib/novelty/rdap-job";
import { getSetting } from "@/lib/settings";
import { requireCollectionReady } from "../../scans/guard";

export const dynamic = "force-dynamic";

const schema = z
  .object({ leadIds: z.array(z.number().int().positive()).min(1).max(500).optional() })
  .strict();

/**
 * "Alan adı yaşını denetle": seçili (veya tüm) lead'lerin web sitesi alan adları RDAP kuyruğuna eklenir ve tekil RDAP işi
 * başlatılır. Daha önce denetlenmiş alan adı yeniden sorulmaz (sonraki denetim zamanı gelmeden).
 * 202 `{added, queued}`; 403 SETUP_REQUIRED; 409 RDAP_DISABLED (Ayarlar'da kapalı).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  if (!(await getSetting(db, "novelty.rdap")).enabled)
    throw new HttpError(409, "Alan adı yaşı denetimi Ayarlar'da kapalı.", {
      code: "RDAP_DISABLED",
    });
  const text = await req
    .clone()
    .text()
    .catch(() => "");
  const { leadIds } = text.trim() ? await body(req, schema) : { leadIds: undefined };
  const now = Date.now();
  const added = await syncDomainQueue(db, now, leadIds);
  const jobId = await enqueueRdap(db, { runAt: now, now });
  if (added > 0 || jobId !== null)
    await audit(db, "novelty.rdap_requested", "domains", undefined, {
      added,
      leads: leadIds?.length ?? null,
    });
  return json({ added, queued: jobId !== null }, { status: 202 });
});
