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

const identifierField = z
  .string()
  .trim()
  .max(40)
  .regex(/^[\p{L}\p{N} .\-/]*$/u)
  .optional();

const companySchema = z.object({
  legalName: z.string().min(2),
  address: z.string().min(5),
  taxId: z.string().min(2),
  phone: z.string().min(5),
  contactName: z.string().min(2),
  contactTitle: z.string().optional(),
  website: z.string().optional(),
  /**
   * Türkiye'ye özgü kurumsal tanımlayıcılar (Aşama 15.1): İSTEĞE BAĞLI. Yalnızca Türkiye'ye yönelik iletilerin alt
   * bilgisine eklenir; gerekliliği hukuki değerlendirmeye bağlıdır ve hiçbir gönderimi engellemez. Tek satır, kısa,
   * harf/rakam ve temel noktalama (başlık ve satır enjeksiyonuna karşı).
   */
  mersisNo: identifierField,
  tradeRegistryNo: identifierField,
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
  /**
   * Faz 3 (Aşama 13): demo otomatik durdurma eşikleri. Yalnızca içeride yazılır (ayarlar API'si değiştiremez);
   * kullanıcı eşikleri yalnızca `tightenAutoStop` ile SIKILAŞTIRABİLİR. Okurken varsayılandan gevşek değerler
   * varsayılana sıkıştırılır (bkz. campaigns/auto-stop).
   */
  "mail.autoStop": z.object({
    minRecipients: z.number().int(),
    minRateBp: z.number().int(),
  }),
  /**
   * Faz 3 (Aşama 14): posta kutusu düzeyi eşikler (SRS 5.6.1) ve durdurulmuş kutular. Yalnızca içeride yazılır;
   * eşikler yalnızca sıkılaştırılabilir, durdurma yalnızca açık onay ve gerekçeyle kaldırılır.
   */
  "mail.mailboxLimits": z.object({
    bounceBp: z.number().int(),
    minRecipients: z.number().int(),
    guardBounces: z.number().int(),
  }),
  /** Gmail OAuth istemci kimliği (gizli DEĞİL; sırrı gizli depodadır). Yalnızca posta kutusu servisi yazar. */
  "mail.gmailOAuth": z.object({ clientId: z.string() }),
  /** Kutu başına verilen Gmail izinleri (belirteç DEĞİL; yalnızca hangi işlevlerin açık olduğu). */
  "mail.gmailGrants": z.record(
    z.string(),
    z.object({ send: z.boolean(), read: z.boolean(), at: z.number().int() }),
  ),
  /**
   * Kutu düzeyi geçici gönderim beklemesi (Gmail kotası/429, yetki uç noktası veya ağ erişilemez): kutu kimliği →
   * bitiş anı ve neden kodu. Yalnızca gönderim servisi yazar (bkz. src/lib/mail/mailbox-backoff.ts).
   */
  "mail.mailboxSendBackoff": z.record(
    z.string(),
    z.object({ until: z.number().int(), code: z.string(), at: z.number().int() }),
  ),
  "mail.mailboxHalts": z.record(
    z.string(),
    z.object({
      at: z.number().int(),
      recipients: z.number().int(),
      bounced: z.number().int(),
      reason: z.string(),
    }),
  ),
  /**
   * Abonelikten çıkış imza anahtarı kaydı (Aşama 15.6): yalnızca GENEL anahtarlar ve durum; özel anahtar gizli depodadır.
   * Yalnızca anahtar servisi yazar.
   */
  "mail.unsubscribeKeys": z.object({
    current: z.string().nullable(),
    keys: z.array(
      z.object({
        kid: z.string().regex(/^[0-9a-f]{16}$/),
        x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        createdAt: z.number().int(),
        retiredAt: z.number().int().nullable(),
        revokedAt: z.number().int().nullable(),
      }),
    ),
  }),
  /** Aktarıcı kanalı imza anahtarları (Aşama 15.7): yalnızca GENEL anahtarlar ve durum. Yalnızca kanal servisi yazar. */
  "mail.unsubscribeChannel": z.object({
    current: z.string().nullable(),
    keys: z.array(
      z.object({
        kid: z.string().regex(/^[0-9a-f]{16}$/),
        x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        createdAt: z.number().int(),
        revokedAt: z.number().int().nullable(),
      }),
    ),
  }),
  /**
   * HTTPS çıkış uç noktası yapılandırması ve KANITLARI (Aşama 15.7). Yalnızca uç nokta servisi yazar; kullanıcı beyanı
   * kanıt DEĞİLDİR: `verified` yalnızca uçtan uca sınama (imzalı sınama belirteci → aktarıcı → kuyruk → uygulama)
   * başarılı olunca yazılır.
   */
  "mail.unsubscribeEndpoint": z.object({
    baseUrl: z.string().nullable(),
    pending: z
      .object({ jti: z.string(), baseUrl: z.string(), kid: z.string(), issuedAt: z.number().int() })
      .nullable(),
    verified: z
      .object({
        baseUrl: z.string(),
        kid: z.string(),
        jti: z.string(),
        verifiedAt: z.number().int(),
      })
      .nullable(),
    lastAttempt: z
      .object({
        at: z.number().int(),
        ok: z.boolean(),
        code: z.string(),
        /** Kanal hatasında güvenli ayrıntı (ör. `http_error_401`, `timeout`); kişisel veri veya adres içermez. */
        detail: z
          .string()
          .regex(/^[a-z0-9_]{1,40}$/)
          .optional(),
      })
      .nullable(),
    delivery: z
      .object({
        checkedAt: z.number().int(),
        ok: z.boolean(),
        depth: z.number().int(),
        oldestAgeMs: z.number().nullable(),
        corrupt: z.number().int(),
        code: z.string(),
      })
      .nullable(),
  }),
  /**
   * Posta kutusu başına SON DNS (SPF/DKIM/DMARC) denetim sonucu (Aşama 15.7): yalnızca durumlar ve neden kodları;
   * ham TXT kayıtları saklanmaz. Yalnızca DNS servisi yazar.
   */
  "mail.dnsReports": z.record(
    z.string(),
    z.object({
      domain: z.string(),
      checkedAt: z.number().int(),
      spf: z.enum(["pass", "warn", "fail"]).nullable(),
      dkim: z.enum(["pass", "warn", "fail"]).nullable(),
      dmarc: z.enum(["pass", "warn", "fail"]).nullable(),
      codes: z.array(z.string()).max(30),
    }),
  ),
  /** Gerçek gelen kutusu eşitlemesinin son sonucu (Aşama 15.7). Yalnızca eşitleme servisi yazar. */
  "mail.inboxSync": z.record(
    z.string(),
    z.object({ at: z.number().int(), ok: z.boolean(), code: z.string() }),
  ),
  /**
   * ARF şikâyet raporlarını bildirmesine güvenilen geri bildirim sağlayıcı alan adları (Aşama 15.8). Varsayılan BOŞ:
   * boşken hiçbir ARF şikâyeti doğrulanmaz (yalnızca inceleme kuyruğuna düşer). Yalnızca ARF servisi yazar.
   */
  "mail.arfReporters": z.array(z.string().regex(/^[a-z0-9.-]{3,253}$/)).max(50),
  /**
   * Çıkış olayı çekme işinin (`unsubscribe.drain`) kullanıcı anahtarı (TB-3/C4). Varsayılan KAPALI. Yalnızca çekme işi
   * servisi yazar (ayarlar API'si değiştiremez); ortam bayrağı `UM_UNSUBSCRIBE_DRAIN_ENABLED` ile VEYA birleşir ve
   * iş her turda yeniden okur. Gönderimi açmaz; yalnızca aktarıcıdaki çıkış olaylarının uygulamaya çekilmesini sağlar.
   */
  "mail.unsubscribeDrain": z.object({ enabled: z.boolean() }),
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
  "mail.autoStop": { minRecipients: 20, minRateBp: 500 },
  "mail.mailboxLimits": { bounceBp: 300, minRecipients: 50, guardBounces: 3 },
  "mail.mailboxHalts": {},
  "mail.mailboxSendBackoff": {},
  "mail.gmailOAuth": { clientId: "" },
  "mail.gmailGrants": {},
  "mail.unsubscribeKeys": { current: null, keys: [] },
  "mail.unsubscribeChannel": { current: null, keys: [] },
  "mail.dnsReports": {},
  "mail.inboxSync": {},
  "mail.arfReporters": [],
  "mail.unsubscribeDrain": { enabled: false },
  "mail.unsubscribeEndpoint": {
    baseUrl: null,
    pending: null,
    verified: null,
    lastAttempt: null,
    delivery: null,
  },
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
