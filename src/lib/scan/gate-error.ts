/** Tarama kapısı kodları ve hata türü (gates.ts ve service.ts ortak; döngüsel içe aktarmayı önlemek için ayrı). */
export const GATE_CODES = [
  "SETUP_REQUIRED",
  "PLACES_KEY_MISSING",
  "BUDGET_BLOCKED",
  "NEEDS_ACK",
  "COUNTRY_NOT_TARGETED",
  "ACTIVE_SCAN",
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export const GATE_HTTP_STATUS: Record<GateCode, number> = {
  SETUP_REQUIRED: 403,
  PLACES_KEY_MISSING: 400,
  BUDGET_BLOCKED: 409,
  NEEDS_ACK: 409,
  COUNTRY_NOT_TARGETED: 400,
  ACTIVE_SCAN: 409,
};

/**
 * `fields`: yanıt gövdesine eklenen yapılandırılmış sayılar (ör. NEEDS_ACK `highUsd`/`remainingUsd`); istemci yerelleştirilmiş
 * metni bunlarla kurar (apiError.NEEDS_ACK.detail). Yalnızca o metnin tüm yer tutucuları varsa doldurulur.
 */
export type GateFailure = {
  ok: false;
  code: GateCode;
  message: string;
  fields?: Record<string, number>;
};
export type GateResult<T = object> = ({ ok: true } & T) | GateFailure;

/** Kapı hatası; kütüphane içinde fırlatılır (ör. işlem içindeki ACTIVE_SCAN), uçta HttpError'a çevrilir. */
export class ScanGateError extends Error {
  constructor(
    readonly code: GateCode,
    message: string,
  ) {
    super(message);
    this.name = "ScanGateError";
  }
}

export const ACTIVE_SCAN_MESSAGE =
  "Aynı bölge ve kategoriler için sürmekte olan veya duraklatılmış bir tarama var. Önce onu sürdürün ya da iptal edin.";
