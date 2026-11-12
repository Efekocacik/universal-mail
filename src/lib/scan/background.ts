import type { Db } from "@/lib/db/client";
import { getSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { budgetSummary } from "./gates";
import { dayKey } from "./schedule";
import { safeNotify } from "./scan-notifications";

/**
 * Ücretli arka plan Google işleri (açılış izleme, yer kimliği yenileme) için ön kontrol. Kullanıcı başlatmadığı için
 * engelde iş sessizce düşmez: gün başına tek bir `background.skipped` bildirimi yazılır ve iş ağ çağrısı yapmadan biter.
 * Demo sağlayıcıda anahtar gerekmez ve ağ çağrısı yoktur.
 */
export type BackgroundSkipCode = "CONSENT_REQUIRED" | "PLACES_KEY_MISSING" | "BUDGET_BLOCKED";

export async function backgroundPrecheck(
  db: Db,
  job: "watch_future" | "refresh_ids",
  opts: { now: number; log?: (m: string) => void },
): Promise<{ ok: true } | { ok: false; code: BackgroundSkipCode }> {
  let code: BackgroundSkipCode | null = null;
  if (!(await getSetting(db, "consent"))) code = "CONSENT_REQUIRED";
  else if (
    (await getSetting(db, "places.provider")) === "google" &&
    !(await getSecret("google.placesKey"))
  )
    code = "PLACES_KEY_MISSING";
  else if ((await budgetSummary(db)).level === "blocked") code = "BUDGET_BLOCKED";
  if (!code) return { ok: true };
  await safeNotify(
    db,
    {
      kind: "background.skipped",
      dedupeKey: `background.skipped:${job}:${code}:${dayKey(opts.now)}`,
      params: { code },
      url: "/settings",
      entity: "background",
      entityId: job,
    },
    opts.now,
    opts.log,
  );
  opts.log?.(`${job} atlandı (${code})`);
  return { ok: false, code };
}
