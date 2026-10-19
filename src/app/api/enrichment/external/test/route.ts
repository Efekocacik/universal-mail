import { database, HttpError, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { createHunterProvider, ExternalProviderError } from "@/lib/email/external";
import { getSecret } from "@/lib/secrets/store";

export const dynamic = "force-dynamic";

/** Hunter API anahtarını dener ve kalan arama hakkını döndürür (FR-ENR-04: kota gösterilir). */
export const POST = route(async () => {
  const db = await database();
  const key = await getSecret("hunter.apiKey");
  if (!key) throw new HttpError(400, "Önce Hunter API anahtarını kaydedin.");
  try {
    const quota = await createHunterProvider(key).quota();
    await audit(db, "enrichment.external.tested", "settings", undefined, { ok: true });
    return json({ ok: true, ...quota });
  } catch (e) {
    if (e instanceof ExternalProviderError) {
      const status = e.kind === "auth" ? 400 : e.kind === "network" ? 502 : 429;
      throw new HttpError(status, e.message, { kind: e.kind });
    }
    throw e;
  }
});
