import { z } from "zod";
import { database, HttpError, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { createExternalProvider, externalStatus } from "@/lib/email/deps";
import { ExternalProviderError, type ExternalErrorKind } from "@/lib/email/external";
import { EXTERNAL_EMAIL_PROVIDERS } from "@/lib/settings";

export const dynamic = "force-dynamic";

const schema = z.object({ provider: z.enum(EXTERNAL_EMAIL_PROVIDERS).optional() }).strict();

const ERROR: Record<ExternalErrorKind, { status: number; code: string }> = {
  auth: { status: 400, code: "EXTERNAL_AUTH" },
  quota: { status: 429, code: "EXTERNAL_QUOTA" },
  rate_limit: { status: 429, code: "EXTERNAL_RATE" },
  network: { status: 502, code: "EXTERNAL_NETWORK" },
  bad_response: { status: 502, code: "UPSTREAM" },
  // Yalnızca arama yoklamasında oluşur (kota denemesinde değil); yine de eşlenir.
  pending: { status: 502, code: "EXTERNAL_NETWORK" },
};

/**
 * Harici e-posta servisinin (Hunter veya Snov) anahtarlarını dener ve kalan hakkı döndürür (FR-ENR-04: kota gösterilir).
 * Gövde boş olabilir (eski istemci); sağlayıcı verilmezse ayardaki sağlayıcı. Demo kipinde ağa çıkılmaz: sabit kota.
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  const raw = await req.text();
  let parsed: unknown = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Bilgiler gönderilemedi. Sayfayı yenileyip yeniden deneyin.", {
        code: "BAD_JSON",
      });
    }
  }
  const input = schema.parse(parsed);
  const st = await externalStatus(db);
  const provider = input.provider ?? st.provider;
  const client = await createExternalProvider(provider, st.demo);
  if (!client)
    throw new HttpError(
      400,
      provider === "snov"
        ? "Önce Snov istemci kimliğini ve sırrını kaydedin."
        : "Önce Hunter API anahtarını kaydedin.",
      { code: "EXTERNAL_KEY_MISSING", provider },
    );
  try {
    const quota = await client.quota();
    await audit(db, "enrichment.external.tested", "settings", undefined, {
      ok: true,
      provider,
      demo: st.demo,
    });
    return json({ ok: true, provider, demo: st.demo, ...quota });
  } catch (e) {
    if (e instanceof ExternalProviderError) {
      const m = ERROR[e.kind];
      await audit(db, "enrichment.external.tested", "settings", undefined, {
        ok: false,
        provider,
        kind: e.kind,
      });
      throw new HttpError(m.status, e.message, { kind: e.kind, code: m.code, provider });
    }
    throw e;
  }
});
