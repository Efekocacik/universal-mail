import { z } from "zod";
import { database, HttpError, json, route } from "@/lib/api/http";
import { defaultTimeZone, getDashboard, isValidTimeZone } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    /** Kullanıcının IANA saat dilimi ("bu hafta" sınırı için); yoksa sürecin saat dilimi. */
    tz: z.string().max(64).optional(),
    /** Bildirim metinlerinin dili. */
    locale: z.enum(["tr", "en"]).optional(),
  })
  .strict();

/**
 * Gösterge paneli verisi (yalnızca okuma). Yanıt bölümlüdür: bir bölüm hesaplanamazsa `null` olur ve adı `errors`
 * listesinde yer alır; istek yine 200 döner. Önbelleğe alınmaz (`no-store`); bölüm süreleri `Server-Timing` başlığında.
 * Hatalar: 400 `INVALID_QUERY` (bilinmeyen parametre veya geçersiz saat dilimi).
 */
export const GET = route(async (req: Request) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success || (parsed.data.tz !== undefined && !isValidTimeZone(parsed.data.tz))) {
    throw new HttpError(400, "Geçersiz gösterge paneli isteği.", { code: "INVALID_QUERY" });
  }
  const db = await database();
  const data = await getDashboard(db, {
    timeZone: parsed.data.tz ?? defaultTimeZone(),
    locale: parsed.data.locale ?? "tr",
  });
  const { timings, ...body } = data;
  const serverTiming = Object.entries(timings)
    .map(([k, v]) => `${k};dur=${v}`)
    .join(", ");
  return json(body, serverTiming ? { headers: { "Server-Timing": serverTiming } } : undefined);
});
