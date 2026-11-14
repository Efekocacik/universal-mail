import { database, HttpError, json, route } from "@/lib/api/http";
import { testClaudeKey } from "@/lib/ai/claude";
import { aiMode } from "@/lib/ai/service";
import { AiError } from "@/lib/ai/types";
import { audit } from "@/lib/db/audit";
import { getSecret } from "@/lib/secrets/store";

export const dynamic = "force-dynamic";

const STATUS = { AI_AUTH: 400, AI_RATE_LIMITED: 429 } as Record<string, number>;

/**
 * Claude anahtarını ve seçili modele erişimi dener: `GET /v1/models/{model}` (belirteç harcamaz). Demo kipinde ağa
 * çıkılmaz. Anahtar hiçbir yanıtta yer almaz.
 */
export const POST = route(async () => {
  const db = await database();
  const mode = await aiMode(db);
  if (mode.demo) return json({ ok: true, model: mode.model, demo: true });
  const apiKey = await getSecret("anthropic.apiKey");
  if (!apiKey)
    throw new HttpError(400, "Claude API anahtarı girilmemiş.", { code: "AI_KEY_MISSING" });
  try {
    const r = await testClaudeKey({
      apiKey,
      model: mode.model,
      log: (m) => console.warn(`[ai] ${m}`),
    });
    await audit(db, "ai.key.tested", "settings", undefined, { ok: true, model: mode.model });
    return json({ ok: true, model: r.model, demo: false });
  } catch (e) {
    if (e instanceof AiError) {
      await audit(db, "ai.key.tested", "settings", undefined, { ok: false, code: e.code });
      throw new HttpError(STATUS[e.code] ?? 502, e.message, { code: e.code });
    }
    throw e;
  }
});
