import { RegistryProviderError } from "./types";

/**
 * Sicil servis hataları: kararlı API kodu + HTTP durumu (uç noktalar `HttpError`'a çevirir). Metinler Türkçe tanılama
 * metnidir; arayüz `apiError.<KOD>` sözlük metnini gösterir.
 */
export const REGISTRY_ERROR_STATUS = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  REGISTRY_DISABLED: 400,
  REGISTRY_KEY_MISSING: 400,
  REGISTRY_SCHEME_UNAVAILABLE: 400,
  REGISTRY_RUN_ACTIVE: 409,
  REGISTRY_MATCH_ACTIVE: 409,
  REGISTRY_ALREADY_LEAD: 409,
  REGISTRY_MATCHED: 409,
  REGISTRY_AUTH: 400,
  REGISTRY_RATE: 429,
  REGISTRY_UPSTREAM: 502,
} as const;
export type RegistryServiceCode = keyof typeof REGISTRY_ERROR_STATUS;

export class RegistryServiceError extends Error {
  readonly status: number;
  constructor(
    readonly code: RegistryServiceCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistryServiceError";
    this.status = REGISTRY_ERROR_STATUS[code];
  }
}

/**
 * Sağlayıcı hatası → API hatası (yalnızca "Sına" uç noktası; çalışma hataları `registry_runs.error_code`'a yazılır).
 * Yanıt biçimi bozuk / çok fazla sonuç gibi durumlar istemci için "hizmet şu an kullanılamıyor"dur.
 */
export function fromProviderError(e: RegistryProviderError): RegistryServiceError {
  const code: RegistryServiceCode =
    e.code === "REGISTRY_AUTH" || e.code === "REGISTRY_RATE" || e.code === "REGISTRY_KEY_MISSING"
      ? e.code
      : "REGISTRY_UPSTREAM";
  return new RegistryServiceError(code, e.message);
}

/** Çalışmayı kalıcı olarak düşüren (yeniden denemenin işe yaramadığı) sağlayıcı hataları. */
export const PERMANENT_RUN_ERRORS: ReadonlySet<string> = new Set([
  "REGISTRY_AUTH",
  "REGISTRY_KEY_MISSING",
  "REGISTRY_TOO_MANY",
  "REGISTRY_BAD_RESPONSE",
]);
