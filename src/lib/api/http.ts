import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getDb, type Db } from "@/lib/db/client";
import { PlacesApiError } from "@/lib/places/errors";
import { PlanError } from "@/lib/scan/planner";
import { errorMessage } from "@/lib/util";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
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
        return json({ error: e.message, ...e.extra }, { status: e.status });
      if (e instanceof ZodError) {
        return json(
          {
            error: "Geçersiz istek.",
            issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          { status: 400 },
        );
      }
      if (e instanceof PlanError) return json({ error: e.message }, { status: 400 });
      if (e instanceof PlacesApiError)
        return json({ error: e.message, kind: e.kind }, { status: 502 });
      const message = errorMessage(e);
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
      return json({ error: "Beklenmeyen bir hata oluştu." }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "İstek gövdesi geçerli JSON değil.");
  }
  return schema.parse(raw);
}

export async function database(): Promise<Db> {
  return getDb();
}

export function intParam(value: string | undefined, name = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Geçersiz ${name}.`);
  return n;
}
