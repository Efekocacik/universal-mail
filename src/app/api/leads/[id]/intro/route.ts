import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import {
  generateLeadIntro,
  leadExists,
  listLeadIntros,
  type SiteFetchDeps,
} from "@/lib/ai/service";
import { AGENT_TOKEN, buildUserAgent } from "@/lib/email/deps";
import { safeFetch } from "@/lib/email/safe-fetch";
import { SUPPORTED_LANGUAGES } from "@/lib/mail/language";
import { getSetting } from "@/lib/settings";
import { introHttpError } from "./http";

export const dynamic = "force-dynamic";

const schema = z.object({ language: z.enum(SUPPORTED_LANGUAGES).optional() }).strict();

type Ctx = { params: Promise<{ id: string }> };

/** Lead'in son 20 kişisel girişi (taslak, onaylı, reddedilmiş), yeniden eskiye. */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  const leadId = intParam((await ctx.params).id);
  if (!(await leadExists(db, leadId))) throw new HttpError(404, "Lead bulunamadı.");
  return json({ intros: await listLeadIntros(db, leadId) });
});

/**
 * Yeni kişisel giriş TASLAĞI üretir (onaylanmadan hiçbir yerde kullanılmaz). Dil verilmezse ülkeye göre önerilen dil.
 * Canlı kipte işletmenin kendi ana sayfası güvenli istemci + robots.txt kurallarıyla okunur (yalnızca site_domain).
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const leadId = intParam((await ctx.params).id);
  const { language } = await body(req, schema);
  const profile = await getSetting(db, "company.profile");
  const site: SiteFetchDeps = {
    fetch: safeFetch,
    userAgent: buildUserAgent(profile?.website),
    agentToken: AGENT_TOKEN,
  };
  try {
    const intro = await generateLeadIntro(db, leadId, language, {
      site,
      log: (m) => console.warn(`[ai] ${m}`),
    });
    return json({ intro }, { status: 201 });
  } catch (e) {
    throw introHttpError(e);
  }
});
