import { z } from "zod";
import { database, HttpError, intParam, json, route } from "@/lib/api/http";
import { runSchedule } from "@/lib/scan/schedule";
import { getSchedule } from "@/lib/scan/schedule-service";
import { GATE_HTTP_STATUS, type GateCode } from "@/lib/scan/gates";
import { scheduleErrors } from "../../errors";

export const dynamic = "force-dynamic";

const runNowSchema = z.object({ acknowledgeRisk: z.boolean().optional() }).strict();

async function optionalBody(req: Request): Promise<z.infer<typeof runNowSchema>> {
  const text = await req.text().catch(() => "");
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Bilgiler gönderilemedi. Sayfayı yenileyip yeniden deneyin.");
  }
  return runNowSchema.parse(raw);
}

/**
 * "Şimdi çalıştır": etkileşimli olduğu için yüksek maliyet onayı (`acknowledgeRisk`) verilebilir. Kapılar "Yeniden
 * tara" ile aynıdır. Çalışma anı = şimdi; sonraki çalışma `şimdi + aralık`.
 * 201 `{scanId}`; 403 SETUP_REQUIRED; 400 PLACES_KEY_MISSING / COUNTRY_NOT_TARGETED / CATEGORY_SET_MISSING / PLAN_INVALID;
 * 409 BUDGET_BLOCKED / NEEDS_ACK / ACTIVE_SCAN / RACE (başka bir çalışma aynı anda başladı); 404 SCHEDULE_NOT_FOUND.
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { acknowledgeRisk } = await optionalBody(req);
  const s = await scheduleErrors(() => getSchedule(db, id));
  const r = await runSchedule(db, s, Date.now(), { interactive: true, acknowledgeRisk });
  if (r.outcome === "started") return json({ scanId: r.scanId }, { status: 201 });
  if (r.outcome === "gate") {
    const status = (GATE_HTTP_STATUS as Record<string, number>)[r.code] ?? 400;
    throw new HttpError(status, r.message, { code: r.code as GateCode | string });
  }
  throw new HttpError(
    409,
    "Zamanlama şu anda başka bir çalışma tarafından güncellendi. Yeniden deneyin.",
    {
      code: "RACE",
    },
  );
});
