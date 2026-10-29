import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { countryPolicies, type PolicyMode, type PolicyScope } from "@/lib/db/schema";
import { COUNTRY_CODES } from "@/lib/geo/countries";

/**
 * Ülke bazlı gönderim politikası (SRS 8.2, FR-CMPL-01).
 *
 * `live` (gerçek gönderim) ve `demo` kapsamları ayrıdır; hangisinin uygulanacağını kampanyanın posta kutusu
 * belirler. Şirketten hukuki onay ve hedef ülke bilgisi gelene kadar gerçek gönderim KAPALIDIR:
 *  - `live` satırlarının hepsi `blocked` ve kilitli eklenir (veritabanı kısıtları kilitliyken gevşetmeyi reddeder),
 *  - `LIVE_SENDING_ENABLED` false olduğu sürece `live` kapsamı satırdan bağımsız olarak her zaman `blocked` döner.
 * Kaydı olmayan veya bilinmeyen ülke her iki kapsamda da `blocked` sayılır.
 */

/** Bu sürümde gerçek gönderim yoktur. Yalnızca hukuki onaydan sonra çıkacak yeni bir sürümde değişebilir. */
export const LIVE_SENDING_ENABLED = false;

/** Varsayılanların sürümü. Seed mevcut satırların ÜZERİNE YAZMAZ; yalnızca eksik ülkeleri ekler. */
export const POLICY_SEED_VERSION = 1;

/**
 * Demo kapsamının başlangıç ayarı: uygunluk akışını (ör. kabul ölçütü 6'daki "Almanya hariç tutulur") hesapsız
 * denemek içindir. GERÇEK GÖNDERİM İZNİ DEĞİLDİR. Listede olmayan ülkeler demo'da da `blocked` başlar; Türkiye
 * SRS 8.2 gereği varsayılan kapalıdır.
 */
export const DEMO_POLICY_PRESET: Readonly<Record<string, PolicyMode>> = {
  GB: "allowed",
  FR: "allowed",
  NL: "allowed",
  ES: "generic_only",
  IT: "generic_only",
  DE: "blocked",
  AT: "blocked",
};

/**
 * Eksik ülke politikalarını ekler (her iki kapsam, tüm desteklenen ülkeler). Var olan satırlara dokunmaz:
 * kullanıcının demo ayarları ve (ileride) onaylı live kayıtları korunur. Eklenen satır sayısını döndürür.
 */
export async function seedCountryPolicies(db: Db, now = Date.now()): Promise<number> {
  const rows: (typeof countryPolicies.$inferInsert)[] = [];
  for (const code of COUNTRY_CODES) {
    rows.push({
      scope: "live",
      countryCode: code,
      mode: "blocked",
      locked: true,
      seedVersion: POLICY_SEED_VERSION,
      updatedAt: now,
    });
    rows.push({
      scope: "demo",
      countryCode: code,
      mode: DEMO_POLICY_PRESET[code] ?? "blocked",
      locked: false,
      note: "Demo: gerçek gönderim izni değildir.",
      seedVersion: POLICY_SEED_VERSION,
      updatedAt: now,
    });
  }
  const inserted = await db
    .insert(countryPolicies)
    .values(rows)
    .onConflictDoNothing()
    .returning({ code: countryPolicies.countryCode });
  return inserted.length;
}

export type PolicyBlockReason = "unknown_country" | "live_disabled" | "no_policy" | "locked" | null;

export interface ResolvedPolicy {
  mode: PolicyMode;
  /** `blocked` sonucunun politika satırından başka bir nedenden kaynaklandığı durumlar. */
  reason: PolicyBlockReason;
}

/** Bir ülkenin geçerli gönderim modu. Belirsiz her durumda `blocked` döner (güvenli varsayılan). */
export async function resolveCountryPolicy(
  db: Db,
  scope: PolicyScope,
  countryCode: string | null | undefined,
): Promise<ResolvedPolicy> {
  const code = countryCode?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(code)) return { mode: "blocked", reason: "unknown_country" };
  if (scope === "live" && !LIVE_SENDING_ENABLED)
    return { mode: "blocked", reason: "live_disabled" };

  const [row] = await db
    .select({ mode: countryPolicies.mode, locked: countryPolicies.locked })
    .from(countryPolicies)
    .where(and(eq(countryPolicies.scope, scope), eq(countryPolicies.countryCode, code)))
    .limit(1);
  if (!row) return { mode: "blocked", reason: "no_policy" };
  if (scope === "live" && row.locked) return { mode: "blocked", reason: "locked" };
  return { mode: row.mode, reason: null };
}
