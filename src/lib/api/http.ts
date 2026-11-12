import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { CAMPAIGN_ERROR_STATUS, CampaignError } from "@/lib/campaigns/errors";
import { getDb, type Db } from "@/lib/db/client";
import { PlacesApiError } from "@/lib/places/errors";
import { PlanError } from "@/lib/scan/planner";
import { errorMessage } from "@/lib/util";
import { codeForStatus, toErrorCode } from "./error-codes";

/**
 * Uç noktadan fırlatılan, istemciye gösterilecek hata. `extra.code` kararlı makine kodudur (ör. `BUDGET_BLOCKED`);
 * verilmezse `route()` HTTP durumundan genel bir kod türetir (`NOT_FOUND`, `CONFLICT`…). Arayüz metni koddan
 * yerelleştirir; `message` (Türkçe) geriye uyumluluk ve tanılama için yanıtta kalır.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get code(): string {
    return typeof this.extra.code === "string" ? this.extra.code : codeForStatus(this.status);
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) },
  });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Uç nokta sarmalayıcı: hataları tutarlı JSON'a çevirir; iç ayrıntıları (yığın izi) istemciye sızdırmaz. */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof HttpError)
        return json({ error: e.message, ...e.extra, code: e.code }, { status: e.status });
      if (e instanceof ZodError) {
        return json(
          {
            error: "Girilen bilgilerde bir sorun var. Alanları kontrol edip yeniden deneyin.",
            code: "VALIDATION",
            issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          { status: 400 },
        );
      }
      if (e instanceof CampaignError) {
        return json(
          { error: e.message, code: e.code.toUpperCase(), ...e.detail },
          { status: CAMPAIGN_ERROR_STATUS[e.code] },
        );
      }
      if (e instanceof PlanError)
        return json({ error: e.message, code: "PLAN_INVALID" }, { status: 400 });
      if (e instanceof PlacesApiError)
        return json(
          { error: e.message, kind: e.kind, code: toErrorCode(e.kind, "PLACES_") },
          { status: 502 },
        );
      const message = errorMessage(e);
      // Veritabanı başka bir işlemle meşgul (aynı bağlantıda açık işlem veya başka süreç): güvenle yeniden denenebilir.
      const cause = (e as { cause?: unknown })?.cause;
      if (
        /TRANSACTION_ACTIVE|SQLITE_BUSY|database is locked/i.test(
          `${message} ${cause ? errorMessage(cause) : ""}`,
        )
      ) {
        return json(
          {
            error: "Veritabanı şu an meşgul. Birkaç saniye sonra yeniden deneyin.",
            code: "DB_BUSY",
          },
          { status: 503 },
        );
      }
      if (/no such table|SQLITE_ERROR.*no such/i.test(message)) {
        return json(
          {
            error: "Veritabanı hazırlanıyor. Birkaç saniye sonra yeniden deneyin.",
            code: "DB_NOT_READY",
          },
          { status: 503 },
        );
      }
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}:`, e);
      return json(
        {
          error: "Beklenmeyen bir hata oluştu. Yeniden deneyin; sürerse uygulamayı kapatıp açın.",
          code: "INTERNAL",
        },
        { status: 500 },
      );
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Bilgiler gönderilemedi. Sayfayı yenileyip yeniden deneyin.", {
      code: "BAD_JSON",
    });
  }
  return schema.parse(raw);
}

export async function database(): Promise<Db> {
  return getDb();
}

export function intParam(value: string | undefined, name = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new HttpError(400, `Geçersiz ${name}.`, { code: "INVALID_ID" });
  return n;
}
