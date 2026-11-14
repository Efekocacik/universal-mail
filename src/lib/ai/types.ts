import type { IntroModel } from "@/lib/db/schema";
import type { TemplateLanguage } from "@/lib/mail/language";

/**
 * Faz 5 (P0 sözleşmesi, sahibi: paket A): kişisel giriş üretici arayüzü. Canlı üretici Claude Messages API'sini ham
 * `fetch` ile çağırır (yeni bağımlılık yok); demo üretici (`places.provider = "mock"`) ağsız, belirlenimci ve ücretsizdir.
 * Bağlam YALNIZCA bizim verimizdir: Google önbellek alanları, e-posta, telefon veya notlar ASLA gönderilmez.
 */

export type { IntroModel } from "@/lib/db/schema";
export type IntroLanguage = TemplateLanguage;

export interface IntroContext {
  /** Lead'in KENDİ görünen adı (Google adı değil); yoksa null. */
  displayName: string | null;
  city: string | null;
  /** Kategori etiketinin şablon dilindeki karşılığı; yoksa null. */
  categoryLabel: string | null;
  language: IntroLanguage;
  /** İşletmenin kendi sitesinden en çok 3000 karakter görünür metin (güvenilmeyen veri); yoksa null. */
  siteExcerpt: string | null;
  /** `siteExcerpt` kaynağının alan adı (küçük harf); yoksa null. */
  sourceDomain: string | null;
}

export interface IntroResult {
  text: string;
  model: IntroModel;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  sourceDomain: string | null;
}

export interface IntroGenerator {
  readonly model: IntroModel;
  readonly isDemo: boolean;
  generate(ctx: IntroContext, opts?: { signal?: AbortSignal }): Promise<IntroResult>;
}

/** Üretim hata kodları (API kodlarıyla aynı; `apiError.<KOD>` metinleri `i18n/{tr,en}/ai.ts`). */
export const AI_ERROR_CODES = [
  "AI_AUTH",
  "AI_RATE_LIMITED",
  "AI_UPSTREAM",
  "AI_REFUSED",
  "AI_TRUNCATED",
  "AI_OUTPUT_INVALID",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
