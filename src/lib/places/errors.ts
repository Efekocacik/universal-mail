export type PlacesErrorKind =
  "auth" | "billing" | "disabled" | "quota" | "rate" | "invalid" | "network" | "server" | "unknown";

export class PlacesApiError extends Error {
  readonly kind: PlacesErrorKind;
  readonly status?: number;
  readonly googleStatus?: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;

  constructor(
    kind: PlacesErrorKind,
    message: string,
    extra: { status?: number; googleStatus?: string; reason?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "PlacesApiError";
    this.kind = kind;
    Object.assign(this, extra);
  }

  /** Taramayı duraklatıp daha sonra devam ettirmeyi gerektiren geçici durumlar. */
  get isPausable(): boolean {
    return (
      this.kind === "quota" ||
      this.kind === "rate" ||
      this.kind === "network" ||
      this.kind === "server"
    );
  }

  /** Yeniden denemenin anlamlı olduğu hatalar. */
  get isRetryable(): boolean {
    return this.kind === "rate" || this.kind === "network" || this.kind === "server";
  }
}

const MESSAGES_TR: Record<PlacesErrorKind, string> = {
  auth: "Google API anahtarı geçersiz ya da bu isteğe izin vermiyor. Anahtarın 'Places API (New)' ile kısıtlandığını ve doğru kopyalandığını kontrol edin.",
  billing:
    "Google Cloud projesinde faturalandırma kapalı. Faturalandırma hesabını projeye bağlayın.",
  disabled:
    "'Places API (New)' bu projede etkin değil. Google Cloud'da API kitaplığından etkinleştirin (eski 'Places API' değil, '(New)' olanı).",
  quota:
    "Google kota sınırına ulaşıldı. Tarama duraklatıldı; kota sıfırlandığında veya sınırı yükselttiğinizde devam edebilirsiniz.",
  rate: "Google isteklerimizi geçici olarak yavaşlattı (çok sık istek). Tarama duraklatıldı; biraz sonra devam edebilirsiniz.",
  invalid: "Google isteği reddetti.",
  network: "Google'a ulaşılamadı. İnternet bağlantınızı kontrol edin; tarama duraklatıldı.",
  server: "Google geçici bir sunucu hatası verdi; tarama duraklatıldı.",
  unknown: "Google'dan beklenmeyen bir yanıt alındı.",
};

export function userMessageFor(kind: PlacesErrorKind, detail?: string): string {
  const base = MESSAGES_TR[kind];
  return detail && (kind === "invalid" || kind === "unknown") ? `${base} (${detail})` : base;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; "@type"?: string }[];
  };
}

/** Google hata yanıtını anlaşılır bir hata türüne çevirir. */
export function classifyGoogleError(
  status: number,
  body: unknown,
  retryAfterMs?: number,
): PlacesApiError {
  const err = (body as GoogleErrorBody | undefined)?.error;
  const googleStatus = err?.status;
  const message = err?.message ?? `HTTP ${status}`;
  const reason = err?.details?.find((d) => typeof d.reason === "string")?.reason;
  const extra = { status, googleStatus, reason, retryAfterMs };

  const lower = message.toLowerCase();
  let kind: PlacesErrorKind;
  if (reason === "BILLING_DISABLED" || lower.includes("billing")) kind = "billing";
  else if (
    reason === "SERVICE_DISABLED" ||
    lower.includes("has not been used") ||
    lower.includes("is disabled")
  )
    kind = "disabled";
  else if (
    status === 401 ||
    status === 403 ||
    reason === "API_KEY_INVALID" ||
    reason?.startsWith("API_KEY")
  )
    kind = "auth";
  else if (status === 429)
    kind =
      lower.includes("quota") && (lower.includes("per day") || lower.includes("daily"))
        ? "quota"
        : "rate";
  else if (status === 400 && reason === "API_KEY_INVALID") kind = "auth";
  else if (status === 400 || status === 404) kind = "invalid";
  else if (status >= 500) kind = "server";
  else kind = "unknown";

  return new PlacesApiError(kind, userMessageFor(kind, message), extra);
}
