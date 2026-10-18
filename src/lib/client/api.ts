/** Tarayıcı tarafı API istemcisi. Hata gövdesindeki Türkçe mesajı `ApiError.message` olarak taşır. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* gövde yok */
  }
  if (!res.ok) {
    const body = (data ?? {}) as Record<string, unknown>;
    throw new ApiError(
      typeof body.error === "string" ? body.error : `İstek başarısız (${res.status}).`,
      res.status,
      typeof body.code === "string" ? body.code : undefined,
      body,
    );
  }
  return data as T;
}

/** Süzgeç nesnesini URL parametrelerine çevirir. */
export function toSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else if (typeof v === "boolean") {
      sp.set(k, v ? "1" : "0");
    } else {
      sp.set(k, String(v));
    }
  }
  return sp;
}
