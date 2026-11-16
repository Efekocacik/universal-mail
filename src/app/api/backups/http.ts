import { HttpError, route } from "@/lib/api/http";
import { LifecycleError } from "@/lib/backup/errors";
import { BackupNotFoundError } from "@/lib/backup/service";

/**
 * Faz 6 (paket Y): yedek ve veri yaşam döngüsü uçlarının ortak katmanı. `LifecycleError` → kodlu HTTP yanıtı
 * (`LIFECYCLE_ERROR_STATUS`), `BackupNotFoundError` → 404 `NOT_FOUND`. İletiler Türkçe kullanıcı metnidir
 * (`apiError.<KOD>`); yol, parola veya kişisel veri içermez.
 */
type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

export function lifecycleRoute<C = unknown>(handler: Handler<C>): Handler<C> {
  return route<C>(async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof LifecycleError) throw new HttpError(e.status, e.message, { code: e.code });
      if (e instanceof BackupNotFoundError)
        throw new HttpError(404, e.message, { code: "NOT_FOUND" });
      throw e;
    }
  });
}
