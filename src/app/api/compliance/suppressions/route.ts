import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { suppressDomain, suppressEmail } from "@/lib/compliance/suppression";
import { listSuppressions } from "@/lib/compliance/suppression-list";
import { requireConsent } from "../../campaigns/schema";
import { addSuppressionSchema, listQuerySchema, queryInt } from "../schema";

export const dynamic = "force-dynamic";

/**
 * Suppression listesi (salt okunur). Tam adres saklanmadığı için yalnızca ekleme anında üretilmiş maskeli görünüm
 * veya alan adı gösterilir; silme talebi kayıtlarında hiçbir tanımlayıcı dönmez (bkz. suppression-list.ts).
 */
export const GET = domainRoute(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  const f = listQuerySchema.parse({
    state: sp.get("state") ?? undefined,
    reason: sp.get("reason") ?? undefined,
    scope: sp.get("scope") ?? undefined,
    q: sp.get("q") ?? undefined,
  });
  return json(
    await listSuppressions(db, {
      ...f,
      beforeId: queryInt(sp, "beforeId", 0) || undefined,
      limit: Math.min(Math.max(queryInt(sp, "limit", 50), 1), 200),
    }),
  );
});

/** Elle ekleme: e-posta veya alan adı. Yanıt yalnızca sonucu (eklendi/güçlendirildi/zaten var) döndürür. */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, addSuppressionSchema);
  await requireConsent(db);
  const result =
    input.kind === "email"
      ? await suppressEmail(db, {
          email: input.value,
          reason: input.reason,
          source: "manual",
          note: input.note ?? null,
        })
      : await suppressDomain(db, {
          domain: input.value,
          reason: input.reason,
          source: "manual",
          note: input.note ?? null,
        });
  return json(
    { outcome: result.outcome, id: result.id, scope: result.scope, reason: result.reason },
    { status: result.outcome === "added" ? 201 : 200 },
  );
});
