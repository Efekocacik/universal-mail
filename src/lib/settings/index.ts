import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { DEFAULT_EXCLUDED_COUNTRIES } from "@/lib/geo/countries";

/** Uygulama sürümü ile birlikte onaylanan kullanım koşulları metninin sürümü. */
export const CONSENT_VERSION = "2026-10-1";

const consentSchema = z.object({
  version: z.string(),
  acceptedAt: z.number(),
  name: z.string().min(2),
  title: z.string().optional(),
});

const companySchema = z.object({
  legalName: z.string().min(2),
  address: z.string().min(5),
  taxId: z.string().min(2),
  phone: z.string().min(5),
  contactName: z.string().min(2),
  contactTitle: z.string().optional(),
  website: z.string().optional(),
});

const noveltySchema = z.object({
  highAt: z.number().min(1).max(100),
  likelyAt: z.number().min(1).max(100),
  newWindowDays: z.number().min(1).max(365),
});

const externalEmailSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal("hunter"),
});

export const settingSchemas = {
  "setup.completed": z.boolean(),
  consent: consentSchema.nullable(),
  "company.profile": companySchema.nullable(),
  "targets.countries": z.array(z.string().length(2)),
  "budget.monthlyUsd": z.number().min(0).max(100_000),
  "places.provider": z.enum(["google", "mock"]),
  "maps.mapId": z.string(),
  "novelty.thresholds": noveltySchema,
  "google.cacheDays": z.number().min(1).max(30),
  "mock.epoch": z.number().int().min(0).max(50),
  "ui.language": z.enum(["tr", "en"]),
  /** Faz 2: harici e-posta bulma servisi (varsayılan kapalı; yalnızca yerel taramada bulunamayanlar için). */
  "enrichment.external": externalEmailSchema,
  /** Aynı anda taranan web sitesi sayısı (en çok 4; FR-ENR-05). */
  "enrichment.concurrency": z.number().int().min(1).max(4),
  /**
   * Faz 3: uygulanmış seed sürümleri (yalnızca içeride yazılır, ayarlar API'si değiştiremez). Bir kez eklenen hazır
   * şablon ve demo posta kutusu, kullanıcı düzenlese, arşivlese veya silse de yeniden eklenmez.
   */
  "seed.faz3": z.object({
    templates: z.number().int().min(0),
    demoMailbox: z.number().int().min(0),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  "setup.completed": false,
  consent: null,
  "company.profile": null,
  "targets.countries": [],
  "budget.monthlyUsd": 30,
  "places.provider": "google",
  "maps.mapId": "",
  "novelty.thresholds": { highAt: 60, likelyAt: 30, newWindowDays: 60 },
  "google.cacheDays": 30,
  "mock.epoch": 0,
  "ui.language": "tr",
  "enrichment.external": { enabled: false, provider: "hunter" },
  "enrichment.concurrency": 4,
  "seed.faz3": { templates: 0, demoMailbox: 0 },
};

export async function getSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
): Promise<SettingValue<K>> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const row = rows[0];
  if (!row) return SETTING_DEFAULTS[key];
  const parsed = settingSchemas[key].safeParse(row.value);
  return parsed.success ? (parsed.data as SettingValue<K>) : SETTING_DEFAULTS[key];
}

export async function getSettings<K extends SettingKey>(
  db: DbExecutor,
  keys: readonly K[],
): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [...keys]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys) {
    const raw = byKey.get(key);
    const parsed = raw === undefined ? undefined : settingSchemas[key].safeParse(raw);
    out[key] = (parsed?.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<typeof key>;
  }
  return out;
}

export async function setSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const parsed = settingSchemas[key].parse(value);
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key, value: parsed, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed, updatedAt: now } });
}

/** Hedef ülke listesi boşsa tüm desteklenen ülkeler (Türkiye hariç) varsayılan kabul edilir. */
export function effectiveTargetCountries(
  selected: string[],
  allCodes: readonly string[],
): string[] {
  if (selected.length > 0) return selected;
  return allCodes.filter((c) => !DEFAULT_EXCLUDED_COUNTRIES.includes(c));
}
