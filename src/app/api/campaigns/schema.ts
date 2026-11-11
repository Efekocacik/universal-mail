import { z } from "zod";
import { CampaignError } from "@/lib/campaigns/errors";
import type { Db } from "@/lib/db/client";
import { getSetting } from "@/lib/settings";

/**
 * Kampanya API'sinin giriş şemaları. Hepsi `.strict()`: bilinmeyen alanlar (ör. `status`, `startConfirmedAt`)
 * reddedilir; durum yalnızca `control` ucundaki geçişlerle değişir.
 */

const id = z.number().int().positive();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const sendWindowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: hhmm,
    end: hhmm,
  })
  .strict();

const settingsShape = {
  name: z.string().trim().min(1).max(120),
  mailboxId: id.nullable(),
  sendWindow: sendWindowSchema,
  dailyCap: z.number().int().min(1).max(80),
  minGapS: z.number().int().min(90).max(3600),
  maxGapS: z.number().int().min(90).max(3600),
};

export const createCampaignSchema = z
  .object({
    name: settingsShape.name,
    mailboxId: settingsShape.mailboxId.optional(),
    sendWindow: settingsShape.sendWindow.optional(),
    dailyCap: settingsShape.dailyCap.optional(),
    minGapS: settingsShape.minGapS.optional(),
    maxGapS: settingsShape.maxGapS.optional(),
  })
  .strict();

export const updateCampaignSchema = z
  .object({
    expectedUpdatedAt: z.number().int().nonnegative(),
    name: settingsShape.name.optional(),
    mailboxId: settingsShape.mailboxId.optional(),
    sendWindow: settingsShape.sendWindow.optional(),
    dailyCap: settingsShape.dailyCap.optional(),
    minGapS: settingsShape.minGapS.optional(),
    maxGapS: settingsShape.maxGapS.optional(),
  })
  .strict();

export const stepsSchema = z
  .object({
    expectedUpdatedAt: z.number().int().nonnegative(),
    steps: z
      .array(
        z
          .object({
            stepIndex: z.number().int().min(0).max(2),
            language: z.string().min(2).max(5),
            templateId: id,
            delayDays: z.number().int().min(0).max(90),
          })
          .strict(),
      )
      .min(1)
      .max(27),
  })
  .strict();

export const addLeadsSchema = z.union([
  z.object({ leadIds: z.array(id).min(1).max(500) }).strict(),
  /** Leads ekranının filtre sorgusu (`/api/leads` ile aynı biçim); eklendiği andaki görüntü alınır. */
  z.object({ filterQuery: z.string().max(4000) }).strict(),
]);

export const controlSchema = z
  .object({
    action: z.enum(["ready", "draft", "start", "pause", "resume", "cancel"]),
    confirmToken: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .strict();

export const campaignStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "cancelled",
  "stopped",
]);

export const queueStatusSchema = z.enum([
  "pending",
  "excluded",
  "scheduled",
  "in_flight",
  "waiting_next",
  "completed",
  "replied",
  "bounced",
  "unsubscribed",
  "removed",
  "cancelled",
  "failed",
]);

/** Sorgu parametresi tamsayısı (yoksa varsayılan). */
export function queryInt(sp: URLSearchParams, key: string, fallback: number): number {
  const raw = sp.get(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new CampaignError("invalid_input", `Geçersiz ${key}.`);
  return n;
}

/** Kampanya üzerinde değişiklik yapan istekler kullanım onayı olmadan çalışmaz (FR-SET-08). */
export async function requireConsent(db: Db): Promise<void> {
  if (!(await getSetting(db, "consent"))) {
    throw new CampaignError("setup_required", "Önce kurulum sihirbazında kullanım onayını verin.");
  }
}
