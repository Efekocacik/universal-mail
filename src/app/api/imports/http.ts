import { HttpError, route } from "@/lib/api/http";
import { ImportBatchNotFoundError, type UploadedFile } from "@/lib/import/service";
import { IMPORT_ERROR_STATUS, IMPORT_LIMITS, ImportError } from "@/lib/import/types";

/**
 * İçe aktarma uçlarının ortak HTTP katmanı: boyut sınırlı çok parçalı okuma ve `ImportError` → HTTP eşlemesi.
 *
 * Gövde, `Content-Length`'e güvenilmeden akış hâlinde okunur ve `maxBytes + MULTIPART_OVERHEAD`'i aşınca kesilir:
 * böylece 1 GB'lık bir yükleme belleğe alınmaz (413 `IMPORT_TOO_LARGE`).
 */

const MULTIPART_OVERHEAD = 64 * 1024;
const BODY_MAX = IMPORT_LIMITS.maxBytes + MULTIPART_OVERHEAD;

const tooLarge = () =>
  new HttpError(413, "Dosya 5 MB sınırını aşıyor.", { code: "IMPORT_TOO_LARGE" });

async function readCapped(req: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX) throw tooLarge();
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const badForm = () =>
  new HttpError(400, "Dosya gönderilemedi. Sayfayı yenileyip yeniden deneyin.", {
    code: "VALIDATION",
  });

/** `multipart/form-data` → dosya + (varsa) `meta` metni. */
export async function readUpload(
  req: Request,
): Promise<{ file: UploadedFile; meta: string | null }> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(type))
    throw new HttpError(415, "Dosya çok parçalı form olarak gönderilmeli.", {
      code: "IMPORT_UNSUPPORTED",
    });
  const raw = await readCapped(req);
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { "content-type": type } }).formData();
  } catch {
    throw badForm();
  }
  const f = form.get("file");
  if (!f || typeof f === "string") throw badForm();
  if (f.size > IMPORT_LIMITS.maxBytes) throw tooLarge();
  const bytes = new Uint8Array(await f.arrayBuffer());
  const meta = form.get("meta");
  return {
    file: { filename: f.name || "import", bytes },
    meta: typeof meta === "string" ? meta : null,
  };
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** `route()` + içe aktarma hatalarının kodlu HTTP yanıtına çevrilmesi. */
export function importRoute<C = unknown>(handler: Handler<C>): Handler<C> {
  return route<C>(async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof ImportError)
        throw new HttpError(IMPORT_ERROR_STATUS[e.code], e.message, { code: e.code });
      if (e instanceof ImportBatchNotFoundError)
        throw new HttpError(404, e.message, { code: "NOT_FOUND" });
      throw e;
    }
  });
}
