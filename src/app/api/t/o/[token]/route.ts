import { database } from "@/lib/api/http";
import { pixelRateLimited, recordPixelOpen, TRANSPARENT_GIF } from "@/lib/mail/open-tracking";

export const dynamic = "force-dynamic";

/**
 * Açılma pikseli (Faz 5, yalnızca yerel/demo). HER durumda aynı 43 baytlık saydam GIF'i `200` ve `no-store` ile
 * döndürür: belirtecin geçerli olup olmadığı, izlemenin açık olup olmadığı veya bir hata olduğu dışarıdan
 * anlaşılmaz. Açılma yalnızca `tracking.opens` açık ve HMAC geçerliyse yazılır. Hata yutulmaz, sunucu günlüğüne
 * (kişisel veri ve belirteç İÇERMEDEN) yazılır.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    if (!pixelRateLimited()) {
      const { token } = await ctx.params;
      await recordPixelOpen(await database(), token);
    }
  } catch (e) {
    console.error("[open-pixel] açılma kaydedilemedi:", e instanceof Error ? e.name : "unknown");
  }
  return new Response(new Uint8Array(TRANSPARENT_GIF), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
