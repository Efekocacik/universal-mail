import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { CONSENT_VERSION, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** İlk açılış kullanım onayı (FR-SET-08): sürüm, tarih ve onaylayan kişi denetim kaydına yazılır. */
export const POST = route(async (req: Request) => {
  const db = await database();
  const { name, title, accept } = await body(
    req,
    z.object({
      name: z.string().trim().min(2).max(120),
      title: z.string().trim().max(120).optional(),
      accept: z.literal(true),
    }),
  );
  void accept;
  const acceptedAt = Date.now();
  await setSetting(db, "consent", { version: CONSENT_VERSION, acceptedAt, name, title });
  await audit(db, "consent.accepted", "consent", CONSENT_VERSION, { name, title, acceptedAt });
  return json({ ok: true, version: CONSENT_VERSION, acceptedAt });
});
