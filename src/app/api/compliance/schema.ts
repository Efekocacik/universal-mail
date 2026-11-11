import { z } from "zod";
import { CampaignError } from "@/lib/campaigns/errors";

/**
 * Uyum API'sinin giriş şemaları (`.strict()`). Önemli: politika isteği `scope` ALMAZ — kapsam sunucuda her zaman
 * `demo`dur, yani gerçek (live) politikalar hiçbir istekle değiştirilemez. Silme talebi (`erasure`) nedeni arayüzden
 * eklenemez; korumalı nedenlerin kaldırılması için hiçbir uç yoktur.
 */

export const policyChangeSchema = z
  .object({
    countryCode: z.string().trim().min(2).max(2),
    mode: z.enum(["allowed", "generic_only", "blocked"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/** Arayüzden elle eklenebilen nedenler. Çıkış ve şikâyet kayıtları sonradan KALDIRILAMAZ. */
export const MANUAL_ADD_REASONS = ["manual", "negative_reply", "unsubscribe", "complaint"] as const;

export const addSuppressionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("email"),
      value: z.string().trim().min(3).max(254),
      reason: z.enum(MANUAL_ADD_REASONS).default("manual"),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("domain"),
      value: z.string().trim().min(3).max(253),
      reason: z.enum(MANUAL_ADD_REASONS).default("manual"),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
]);

export const importSchema = z
  .object({
    /** CSV metni (en fazla 2 MB; başlık satırı zorunlu: email veya domain, isteğe bağlı reason, note). */
    csv: z.string().min(1).max(2_200_000),
  })
  .strict();

export const liftSchema = z
  .object({
    confirm: z.literal(true),
    justification: z.string().trim().min(10).max(500),
  })
  .strict();

export const listQuerySchema = z.object({
  state: z.enum(["active", "lifted", "all"]).default("active"),
  reason: z
    .enum(["unsubscribe", "bounce_hard", "complaint", "manual", "negative_reply", "erasure"])
    .optional(),
  scope: z.enum(["email", "domain"]).optional(),
  q: z.string().max(100).optional(),
});

export function queryInt(sp: URLSearchParams, key: string, fallback: number): number {
  const raw = sp.get(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new CampaignError("invalid_input", `Geçersiz ${key}.`);
  return n;
}
