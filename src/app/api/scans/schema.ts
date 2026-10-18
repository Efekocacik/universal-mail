import { z } from "zod";

const num = z.number().finite();

export const bboxSchema = z.object({
  south: num.min(-90).max(90),
  west: num.min(-180).max(180),
  north: num.min(-90).max(90),
  east: num.min(-180).max(180),
});

export const regionSchema = z.object({
  kind: z.enum(["city", "bbox", "circle"]),
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().length(2).nullish(),
  bbox: bboxSchema,
  circle: z
    .object({
      lat: num.min(-90).max(90),
      lng: num.min(-180).max(180),
      radiusM: num.min(50).max(60_000),
    })
    .optional(),
  cityId: z.number().int().optional(),
});

export const scanRequestSchema = z.object({
  region: regionSchema,
  categoryIds: z.array(z.number().int()).max(30),
  customKeywords: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  strategy: z.enum(["text", "nearby"]).optional(),
  fieldProfile: z.enum(["discovery", "enrich"]).optional(),
});

export type ScanRequestBody = z.infer<typeof scanRequestSchema>;
