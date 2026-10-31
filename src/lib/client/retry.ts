import { ApiError } from "./api";

/**
 * İstemci yeniden deneme politikası.
 *
 * - Okuma (GET): yalnızca 503 `DB_BUSY` için en fazla 3 kez, artan beklemeyle (0,5 sn → 1 sn → 2 sn) otomatik.
 * - Değişiklik (POST/PATCH/PUT/DELETE, kampanya kontrolü): ASLA otomatik yeniden gönderilmez.
 *   503 veya ağ hatasında işlemin uygulanıp uygulanmadığı kesin değildir ("uncertain"): önce sunucudaki güncel durum
 *   yeniden sorgulanır ve kullanıcıya açıkça bildirilir. Kullanıcı yeniden denerse istek güncel durum ve güncel
 *   iyimser kilit belirteciyle (`updatedAt`) yeniden kurulur.
 */

export const MAX_QUERY_RETRIES = 3;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === "DB_BUSY" &&
    failureCount < MAX_QUERY_RETRIES
  );
}

export function queryRetryDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4000);
}

export type MutationErrorKind =
  /** Sonuç belirsiz: işlem uygulanmış olabilir. Güncel durum sorgulanır; otomatik tekrar yok. */
  | "uncertain"
  /** Başka bir işlem kaydı değiştirmiş: güncel veri yüklenir, kullanıcı yeniden karar verir. */
  | "conflict"
  /** Başlatma özeti eskimiş: özet yenilenir, onay sıfırlanır. */
  | "stale"
  /** Kurallar gereği engellendi (bayrak, gerçek posta kutusu, kurulum, durum): değişiklik yok. */
  | "blocked"
  /** Giriş doğrulama hatası. */
  | "validation"
  | "error";

export interface MutationErrorInfo {
  kind: MutationErrorKind;
  /** Sunucudan güncel durum yeniden sorgulanmalı mı? */
  refresh: boolean;
  code?: string;
  message: string;
  issues?: { path: string; message: string }[];
}

const BLOCKED_CODES = new Set([
  "SCHEDULER_DISABLED",
  "LIVE_DISABLED",
  "SETUP_REQUIRED",
  "NOT_EDITABLE",
  "IN_FLIGHT",
  "INVALID_TRANSITION",
  "PREFLIGHT_FAILED",
  "NOT_FOUND",
  "INVALID_STEPS",
  "INVALID_INPUT",
]);

export function classifyMutationError(error: unknown): MutationErrorInfo {
  if (!(error instanceof ApiError)) {
    // fetch ağ hatası (TypeError) veya yanıt alınamadı: istek sunucuya ulaşmış olabilir.
    return {
      kind: "uncertain",
      refresh: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (error.status === 503 || error.status >= 500) {
    return { kind: "uncertain", refresh: true, code: error.code, message: error.message };
  }
  if (error.code === "CONFLICT") {
    return { kind: "conflict", refresh: true, code: error.code, message: error.message };
  }
  if (error.code === "PREFLIGHT_STALE") {
    return { kind: "stale", refresh: true, code: error.code, message: error.message };
  }
  if (error.status === 400 && Array.isArray(error.body?.issues)) {
    return {
      kind: "validation",
      refresh: false,
      code: error.code,
      message: error.message,
      issues: error.body.issues as { path: string; message: string }[],
    };
  }
  if (error.code && BLOCKED_CODES.has(error.code)) {
    return { kind: "blocked", refresh: true, code: error.code, message: error.message };
  }
  return { kind: "error", refresh: error.status === 409, code: error.code, message: error.message };
}
