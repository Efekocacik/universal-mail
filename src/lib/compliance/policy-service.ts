import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { auditLog, countryPolicies, type PolicyMode, type PolicyScope } from "@/lib/db/schema";
import { COUNTRY_CODES, isKnownCountry } from "@/lib/geo/countries";
import {
  isPolicyMode,
  LIVE_SENDING_ENABLED,
  normalizeCountryCode,
  policyStrictness,
} from "./policies";

/**
 * Ülke politikalarının görüntülenmesi ve değiştirilmesi (FR-CMPL-01).
 *
 * Kurallar:
 *  - `live` politikaları uygulama üzerinden HİÇBİR ŞEKİLDE değiştirilemez (gerçek gönderim kapalı).
 *  - `demo` politikalarında yalnızca daha sıkı moda geçilebilir (allowed → generic_only → blocked); gevşetme yok.
 *  - Her başarılı değişiklik aynı işlem içinde `audit_log`'a yazılır; değişiklik ile kaydı birlikte olur ya da hiç
 *    olmaz.
 */

export type PolicyChangeErrorKind =
  | "invalid_input"
  | "live_locked"
  | "unknown_country"
  | "invalid_mode"
  | "no_policy"
  | "loosening_forbidden"
  | "conflict";

export class PolicyChangeError extends Error {
  constructor(
    readonly kind: PolicyChangeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface CountryPolicyView {
  countryCode: string;
  /** Uygulanan (etkin) mod. Kaydı olmayan, geçersiz veya live kapsamındaki satırlar `blocked`'dır. */
  mode: PolicyMode;
  /** Veritabanında yazan mod; kayıt yoksa null. */
  storedMode: string | null;
  locked: boolean;
  /** Kullanıcı bu satırı (sıkılaştırarak) değiştirebilir mi? */
  editable: boolean;
  note: string | null;
  updatedAt: number | null;
}

/** Bir kapsamdaki tüm desteklenen ülkelerin politikası. Eksik kayıtlar `blocked` olarak listelenir. */
export async function listCountryPolicies(
  db: Db,
  scope: PolicyScope,
): Promise<CountryPolicyView[]> {
  if (scope !== "live" && scope !== "demo") {
    throw new PolicyChangeError("invalid_input", "Geçersiz politika kapsamı.");
  }
  const rows = await db.select().from(countryPolicies).where(eq(countryPolicies.scope, scope));
  const byCode = new Map(rows.map((r) => [r.countryCode, r]));
  return COUNTRY_CODES.map((code) => {
    const row = byCode.get(code);
    const stored = row?.mode ?? null;
    const usable =
      row && isPolicyMode(stored) && (scope === "demo" || (LIVE_SENDING_ENABLED && !row.locked));
    const mode: PolicyMode = usable ? (stored as PolicyMode) : "blocked";
    return {
      countryCode: code,
      mode,
      storedMode: stored,
      locked: scope === "live" ? true : (row?.locked ?? false),
      editable: scope === "demo" && !!row && mode !== "blocked",
      note: row?.note ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

const changeSchema = z
  .object({
    scope: z.string(),
    countryCode: z.string().max(8),
    mode: z.string().max(32),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export interface PolicyChangeResult {
  changed: boolean;
  countryCode: string;
  from: PolicyMode;
  to: PolicyMode;
}

/**
 * Bir demo politikasını SIKILAŞTIRIR. Girdi güvenilmez kabul edilir (API gövdesi doğrudan verilebilir).
 * Aynı moda geçiş değişiklik sayılmaz ve denetim kaydı oluşturmaz.
 */
export async function tightenDemoPolicy(
  db: Db,
  input: unknown,
  now = Date.now(),
): Promise<PolicyChangeResult> {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new PolicyChangeError("invalid_input", "Geçersiz politika isteği.");
  const { scope, note } = parsed.data;

  if (scope !== "demo") {
    throw new PolicyChangeError(
      "live_locked",
      "Yalnızca demo politikaları değiştirilebilir; gerçek gönderim politikaları kilitlidir.",
    );
  }
  const code = normalizeCountryCode(parsed.data.countryCode);
  if (!code || !isKnownCountry(code)) {
    throw new PolicyChangeError("unknown_country", "Desteklenmeyen ülke kodu.");
  }
  if (!isPolicyMode(parsed.data.mode)) {
    throw new PolicyChangeError("invalid_mode", "Geçersiz politika modu.");
  }
  const to = parsed.data.mode;

  return db.transaction(async (tx) => {
    const where = and(eq(countryPolicies.scope, "demo"), eq(countryPolicies.countryCode, code));
    const [row] = await tx.select().from(countryPolicies).where(where).limit(1);
    if (!row) {
      // Kaydı olmayan ülke zaten `blocked` sayılır; daha sıkı bir mod yoktur.
      throw new PolicyChangeError(
        "no_policy",
        "Bu ülke için politika kaydı yok (engelli sayılır).",
      );
    }
    const from: PolicyMode = isPolicyMode(row.mode) ? row.mode : "blocked";
    if (from === to) return { changed: false, countryCode: code, from, to };
    if (policyStrictness(to) < policyStrictness(from)) {
      throw new PolicyChangeError(
        "loosening_forbidden",
        "Politika yalnızca daha kısıtlayıcı hâle getirilebilir.",
      );
    }

    // Okunan değer hâlâ geçerliyse güncelle (araya başka bir değişiklik girdiyse hiçbir şey yazılmaz).
    const updated = await tx
      .update(countryPolicies)
      .set({ mode: to, note: note ?? row.note, updatedAt: now })
      .where(and(where, eq(countryPolicies.mode, row.mode)))
      .returning({ code: countryPolicies.countryCode });
    if (updated.length !== 1) {
      throw new PolicyChangeError("conflict", "Politika aynı anda değiştirildi; yeniden deneyin.");
    }
    await tx.insert(auditLog).values({
      at: now,
      action: "country_policy.tightened",
      entity: "country_policy",
      entityId: `demo:${code}`,
      detail: { scope: "demo", countryCode: code, from, to, note: note ?? null },
    });
    return { changed: true, countryCode: code, from, to };
  });
}
