import { sql } from "drizzle-orm";
import { campaigns } from "@/lib/db/schema";

/** Kampanya yönetimi hataları. API katmanı (`route()`) bunları HTTP durum kodlarına çevirir. */
export type CampaignErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_steps"
  | "invalid_transition"
  | "not_editable"
  | "conflict"
  | "in_flight"
  | "live_disabled"
  | "scheduler_disabled"
  | "setup_required"
  | "preflight_failed"
  | "preflight_stale";

export const CAMPAIGN_ERROR_STATUS: Readonly<Record<CampaignErrorCode, number>> = Object.freeze({
  not_found: 404,
  invalid_input: 400,
  invalid_steps: 400,
  invalid_transition: 409,
  not_editable: 409,
  conflict: 409,
  in_flight: 409,
  live_disabled: 409,
  scheduler_disabled: 409,
  setup_required: 403,
  preflight_failed: 409,
  preflight_stale: 409,
});

export class CampaignError extends Error {
  constructor(
    readonly code: CampaignErrorCode,
    message: string,
    /** Yanıta eklenecek, kişisel veri İÇERMEYEN makine bilgisi (ör. engel kodları). */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Kampanyanın iyimser kilit belirteci `updated_at`'tir. Her yazma onu satır başına KESİN artırır
 * (`MAX(now, updated_at + 1)`): aynı milisaniyedeki iki güncelleme veya geri giden saat eski belirtecin yeniden
 * eşleşmesine yol açamaz. Kampanya satırına yazan her işlem (API, dağıtıcı) bunu kullanmalıdır.
 */
export function bumpUpdatedAt(now: number) {
  return sql<number>`max(${now}, ${campaigns.updatedAt} + 1)`;
}
