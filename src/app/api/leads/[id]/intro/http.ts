import { HttpError } from "@/lib/api/http";
import { IntroError } from "@/lib/ai/service";

/** Kişisel giriş servis hatası → HttpError (kararlı `code`, contract c.A durum kodları). */
export function introHttpError(e: unknown): unknown {
  if (e instanceof IntroError) return new HttpError(e.status, e.message, { code: e.code });
  return e;
}
