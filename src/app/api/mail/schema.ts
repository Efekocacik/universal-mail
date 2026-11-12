import { z } from "zod";
import { HttpError } from "@/lib/api/http";

/** Gönderim günlüğü, işlem günlüğü ve gelen kutusu uçlarının giriş şemaları (hepsi `.strict()`). */

export const autoStopSchema = z
  .object({
    minRecipients: z.number().optional(),
    minBounces: z.number().optional(),
    minRateBp: z.number().optional(),
  })
  .strict();

export const mailboxLimitsSchema = z
  .object({
    bounceBp: z.number().optional(),
    minRecipients: z.number().optional(),
    guardBounces: z.number().optional(),
  })
  .strict();

export const reenableSchema = z
  .object({ confirm: z.boolean(), justification: z.string().max(500) })
  .strict();

export const erasurePreviewSchema = z.object({ email: z.string().trim().min(3).max(254) }).strict();

export const erasureSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    requestedAt: z.number().int(),
    justification: z.string().max(500),
    confirm: z.boolean(),
    clearNotes: z.boolean().optional(),
  })
  .strict();

export const createMailboxSchema = z
  .object({ label: z.string().max(200), address: z.string().trim().min(3).max(254) })
  .strict();

export const updateMailboxSchema = z
  .object({
    label: z.string().max(200).optional(),
    status: z.enum(["not_configured", "disabled"]).optional(),
  })
  .strict();

/** `PATCH /api/mailboxes/[id]/limits`: profil üst sınırı serviste denetlenir (kişisel Gmail 50/5, diğerleri 80/10). */
export const mailboxDailyLimitsSchema = z
  .object({
    dailyCap: z.number().int().min(1).max(80).optional(),
    warmupStep: z.number().int().min(0).max(10).optional(),
    /** İstemcinin okuduğu sınır değerleri (iyimser eşzamanlılık; `updated_at` değil). */
    expected: z
      .object({
        dailyCap: z.number().int().min(1).max(80),
        warmupStep: z.number().int().min(0).max(10),
      })
      .strict(),
  })
  .strict()
  .refine((v) => v.dailyCap !== undefined || v.warmupStep !== undefined, {
    message: "Değiştirilecek bir sınır belirtilmedi.",
  });

export const gmailClientSchema = z
  .object({ clientId: z.string().max(200), clientSecret: z.string().max(200).optional() })
  .strict();

export const oauthStartSchema = z.object({ level: z.enum(["send", "send_read"]) }).strict();

export const oauthDisconnectSchema = z.object({ confirm: z.boolean() }).strict();

export const reviewDecisionSchema = z.object({ decision: z.enum(["apply", "ignore"]) }).strict();

export const testSendSchema = z
  .object({ templateId: z.number().int().min(1), leadId: z.number().int().min(1) })
  .strict();

export const dnsCheckSchema = z
  .object({
    selector: z.string().trim().max(63).optional(),
  })
  .strict();

export const devInboxSchema = z
  .object({
    campaignLeadId: z.number().int().min(1),
    scenario: z.enum([
      "hard_bounce",
      "hard_bounce_unattested",
      "soft_bounce",
      "reply",
      "reply_unattested",
      "unsubscribe",
      "negative",
      "auto_reply",
      "unsubscribe_link",
    ]),
  })
  .strict();

/** Bilinmeyen sorgu parametresini REDDEDER (ör. tam adres isteyen `full=1` sessizce yok sayılmaz). */
export function strictParams(sp: URLSearchParams, allowed: readonly string[]): void {
  for (const k of sp.keys()) {
    if (!allowed.includes(k))
      throw new HttpError(400, "Geçersiz sorgu parametresi.", { code: "INVALID_PARAM" });
  }
}

const intOpt = z.coerce.number().int().min(0);

export const mailLogQuerySchema = z
  .object({
    direction: z.enum(["out", "in"]).optional(),
    purpose: z.enum(["campaign", "test", "inbound"]).optional(),
    campaignId: intOpt.optional(),
    status: z
      .enum([
        "queued",
        "sending",
        "sent",
        "failed",
        "unknown",
        "received",
        "matched",
        "unmatched",
        "ignored",
      ])
      .optional(),
    from: intOpt.optional(),
    to: intOpt.optional(),
    beforeId: intOpt.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const MAIL_LOG_PARAMS = [
  "direction",
  "purpose",
  "campaignId",
  "status",
  "from",
  "to",
  "beforeId",
  "limit",
] as const;
export const AUDIT_PARAMS = ["prefix", "beforeId", "limit"] as const;

export const auditQuerySchema = z
  .object({
    prefix: z.string().max(40).optional(),
    beforeId: intOpt.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export function paramsObject(sp: URLSearchParams): Record<string, string> {
  return Object.fromEntries(sp.entries());
}
