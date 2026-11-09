import { z } from "zod";

/**
 * Şablon API'sinin giriş şemaları. Hepsi `.strict()`: `builtIn`, `version`, `archivedAt` gibi alanlar istemciden
 * atanamaz. İçerik doğrulaması (değişkenler, HTML temizleme, yanıltıcı ifade denetimi) sunucu servisindedir.
 */

const draftShape = {
  name: z.string().trim().min(1).max(200),
  language: z.string().min(2).max(5),
  kind: z.enum(["initial", "followup"]),
  categoryKey: z.string().trim().max(64).nullable().optional(),
  subject: z.string().max(500),
  bodyHtml: z.string().max(100_000),
};

export const templateDraftSchema = z.object(draftShape).strict();

export const updateTemplateSchema = z
  .object({
    /** İstemcinin ekranda gördüğü sürüm (iyimser kilit). */
    expectedVersion: z.number().int().positive(),
    name: draftShape.name.optional(),
    language: draftShape.language.optional(),
    kind: draftShape.kind.optional(),
    categoryKey: draftShape.categoryKey,
    subject: draftShape.subject.optional(),
    bodyHtml: draftShape.bodyHtml.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), {
    message: "Değiştirilecek en az bir alan gerekir.",
  });

export const archiveTemplateSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const emptyBodySchema = z.object({}).strict();

export const previewSchema = z
  .object({
    draft: templateDraftSchema,
    leadId: z.number().int().positive(),
  })
  .strict();
