/**
 * Canlı ülke aktivasyonu/geri alma hatası (saf modül: `domain-route.ts` HTTP eşlemesi için bunu içe aktarır; asıl
 * hizmet `live-country-activation.ts` yalnızca ilgili rota tarafından içe aktarılabilir).
 */
export type ActivationErrorKind =
  | "activation_invalid"
  | "activation_legal"
  | "activation_prerequisites"
  | "activation_test_mode"
  | "activation_refused"
  | "confirm_unavailable"
  | "confirm_declined"
  | "confirm_timeout";

export class ActivationError extends Error {
  constructor(
    readonly kind: ActivationErrorKind,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ActivationError";
  }
}
