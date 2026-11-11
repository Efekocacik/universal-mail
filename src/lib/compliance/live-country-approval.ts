import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbExecutor } from "@/lib/db/client";
import { auditLog, countryPolicies, type PolicyMode } from "@/lib/db/schema";
import { isKnownCountry } from "@/lib/geo/countries";
import { LEGAL_APPROVALS } from "./legal-status";
import { isPolicyMode, normalizeCountryCode, POLICY_MODES } from "./policies";

/**
 * Canlı ülke politikası kilidinin SÜRÜM sırasında açılması (go-live C10-a).
 *
 * Yalnızca `scripts/approve-live-country.ts` ve testler kullanır; uygulamanın normal çalışma yolu (web, çalışan,
 * Electron) bu modülü ASLA içe aktarmaz (testle doğrulanır). Uygulama içinde canlı satırları değiştiren bir yol yoktur
 * (`policy-service.ts` canlı satırları reddeder); kilit yalnızca kaydı tutulan bir sürüm adımıyla açılır.
 *
 * GÜVENLİK:
 * - Varsayılan işlem PLAN'dır: hiçbir şeyi değiştirmez.
 * - Uygulama, `LEGAL_APPROVALS.liveCountryPolicies` (yazılı hukuki onay; kodda sabit) `true` değilse REDDEDİLİR. Bu
 *   sürümde `false` olduğundan betik hiçbir canlı satırı açamaz.
 * - Hedef değerler veritabanı CHECK kısıtlarına (`country_policies_*_ck`) uymuyorsa yazmadan reddedilir; uysa bile
 *   veritabanı aynı kısıtları yeniden uygular.
 * - Yalnızca KİLİTLİ ve `blocked` canlı satırlar açılır; zaten açılmış bir satırın onayı sessizce ÜZERİNE YAZILMAZ.
 * - Bütün ülkeler ve denetim kayıtları TEK işlemde yazılır: ya hepsi kalıcı olur ya da hiçbiri.
 * - Satırların açılması tek başına gerçek gönderim DEĞİLDİR: `LIVE_SENDING_ENABLED` kapalıyken çözümleyici canlı
 *   kapsamı yine `blocked` döndürür (`resolveCountryPolicy`) ve gönderim yolu `isLiveSendingPermitted()` ister.
 */

export class LiveCountryApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCountryApprovalError";
  }
}

export const AUDIT_ACTION = "country_policy.live_approved";

/** Açılabilir modlar: `blocked` kilidi açmak anlamsızdır (kısıt gereği zaten onaysız durabilir). */
export type ApprovableMode = Exclude<PolicyMode, "blocked">;

export interface ApprovalInput {
  countries: string[];
  mode: ApprovableMode;
  approvalRef: string;
  approvedBy: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= min && s.length <= max, `${label} ${min}–${max} karakter olmalı.`)
    .refine((s) => !CONTROL.test(s), `${label} kontrol karakteri içeremez.`);

const inputSchema = z.object({
  countries: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .refine(
      (l) => l.length >= 1 && l.length <= 60,
      "1–60 ülke kodu verilmeli (virgülle ayrılmış).",
    ),
  mode: z.string(),
  approvalRef: text(3, 200, "Onay referansı (--approval-ref)"),
  approvedBy: text(2, 120, "Onaylayan (--approved-by)"),
});

/** Komut satırı değerlerini doğrular. Geçersizse ayrıntılı `LiveCountryApprovalError`. */
export function parseApprovalInput(raw: {
  countries?: string;
  mode?: string;
  approvalRef?: string;
  approvedBy?: string;
}): ApprovalInput {
  const missing = (
    [
      ["countries", "--countries"],
      ["mode", "--mode"],
      ["approvalRef", "--approval-ref"],
      ["approvedBy", "--approved-by"],
    ] as const
  ).filter(([k]) => raw[k] === undefined || raw[k]!.startsWith("--"));
  if (missing.length > 0) {
    throw new LiveCountryApprovalError(`Eksik değer: ${missing.map(([, f]) => f).join(", ")}.`);
  }
  const p = inputSchema.safeParse(raw);
  if (!p.success) {
    throw new LiveCountryApprovalError(p.error.issues.map((i) => i.message).join(" "));
  }
  const mode = p.data.mode.trim();
  if (!isPolicyMode(mode) || mode === "blocked") {
    throw new LiveCountryApprovalError(
      `Geçersiz mod: yalnızca ${POLICY_MODES.filter((m) => m !== "blocked").join(" | ")}.`,
    );
  }
  const codes: string[] = [];
  for (const c of p.data.countries) {
    const code = normalizeCountryCode(c);
    if (!code || !isKnownCountry(code)) {
      throw new LiveCountryApprovalError(`Desteklenmeyen ülke kodu: ${c.slice(0, 8)}.`);
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return {
    countries: codes,
    mode,
    approvalRef: p.data.approvalRef,
    approvedBy: p.data.approvedBy,
  };
}

export interface TargetRow {
  scope: string;
  countryCode: string;
  mode: string;
  locked: boolean;
  approvalRef: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
}

/**
 * `country_policies` CHECK kısıtlarının (db/schema.ts) birebir karşılığı. Yazmadan ÖNCE hedef satır için çalıştırılır;
 * ihlal edilen kısıt adlarını döndürür (boşsa uygun).
 */
export function violatedChecks(r: TargetRow): string[] {
  const out: string[] = [];
  const blocked = r.mode === "blocked";
  if (r.scope !== "live" && r.scope !== "demo") out.push("country_policies_scope_ck");
  if (!isPolicyMode(r.mode)) out.push("country_policies_mode_ck");
  if (r.countryCode.length !== 2) out.push("country_policies_code_ck");
  if (!(r.scope === "demo" || !r.locked || blocked)) out.push("country_policies_lock_ck");
  if (!(
    r.scope === "demo" ||
    blocked ||
    (r.approvalRef !== null && r.approvedBy !== null && r.approvedAt !== null)
  )) {
    out.push("country_policies_approval_ck");
  }
  return out;
}

export interface CountryPlan {
  countryCode: string;
  from: { mode: string; locked: boolean } | null;
  to: { mode: ApprovableMode; locked: false };
  /** Bu ülkeyi engelleyen nedenler (boşsa açılabilir). */
  problems: string[];
}

export interface ApprovalPlan {
  countries: CountryPlan[];
  /** Genel engeller (hukuki onay vb.). */
  blockers: string[];
  /** Uygulanabilir mi (genel engel ve ülke sorunu yok)? */
  ready: boolean;
}

/** Hiçbir şeyi değiştirmeden planı çıkarır. */
export async function planLiveCountryApproval(
  db: DbExecutor,
  input: ApprovalInput,
  now: number,
): Promise<ApprovalPlan> {
  const blockers: string[] = [];
  if ((LEGAL_APPROVALS.liveCountryPolicies as boolean) !== true) {
    blockers.push(
      "LEGAL_APPROVALS.liveCountryPolicies false: canlı ülke politikası kilidinin açılmasına yazılı hukuki onay " +
        "bu sürümde kayıtlı değil (legal-status.ts). Önce onayın kaydedildiği sürüm çıkmalı.",
    );
  }
  const countries: CountryPlan[] = [];
  for (const code of input.countries) {
    const [row] = await db
      .select()
      .from(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, code)))
      .limit(1);
    const to = { mode: input.mode, locked: false as const };
    const problems: string[] = [];
    if (!row) {
      problems.push("canlı politika satırı yok (uygulama bu veritabanıyla en az bir kez açılmalı)");
    } else {
      if (!row.locked || row.mode !== "blocked") {
        problems.push(
          `satır zaten kilitli/engelli değil (mod ${row.mode}, kilit ${row.locked ? "var" : "yok"}); mevcut onay ` +
            "üzerine yazılmaz",
        );
      }
      const v = violatedChecks({
        scope: "live",
        countryCode: code,
        mode: input.mode,
        locked: false,
        approvalRef: input.approvalRef,
        approvedBy: input.approvedBy,
        approvedAt: now,
      });
      if (v.length > 0) problems.push(`veritabanı kısıtı ihlali: ${v.join(", ")}`);
    }
    countries.push({
      countryCode: code,
      from: row ? { mode: row.mode, locked: row.locked } : null,
      to,
      problems,
    });
  }
  return {
    countries,
    blockers,
    ready: blockers.length === 0 && countries.every((c) => c.problems.length === 0),
  };
}

export interface ApprovalResult {
  approved: string[];
  approvedAt: number;
}

/**
 * Planı TEK işlemde uygular: her ülke için `locked=0`, mod ve onay alanları + bir denetim kaydı. Plan işlem İÇİNDE
 * yeniden çıkarılır; herhangi bir engel veya eşzamanlı değişiklik varsa hiçbir şey yazılmaz.
 */
export async function applyLiveCountryApproval(
  db: Db,
  input: ApprovalInput,
  opts: { now?: number } = {},
): Promise<ApprovalResult> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const plan = await planLiveCountryApproval(tx, input, now);
    if (!plan.ready) {
      const lines = [
        ...plan.blockers,
        ...plan.countries.flatMap((c) => c.problems.map((p) => `${c.countryCode}: ${p}`)),
      ];
      throw new LiveCountryApprovalError(`Uygulanmadı. ${lines.join(" | ")}`);
    }
    for (const c of plan.countries) {
      const updated = await tx
        .update(countryPolicies)
        .set({
          mode: input.mode,
          locked: false,
          approvalRef: input.approvalRef,
          approvedBy: input.approvedBy,
          approvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(countryPolicies.scope, "live"),
            eq(countryPolicies.countryCode, c.countryCode),
            eq(countryPolicies.locked, true),
            eq(countryPolicies.mode, "blocked"),
          ),
        )
        .returning({ code: countryPolicies.countryCode });
      if (updated.length !== 1) {
        throw new LiveCountryApprovalError(
          `${c.countryCode}: satır aynı anda değişti; hiçbir şey uygulanmadı.`,
        );
      }
      await tx.insert(auditLog).values({
        at: now,
        action: AUDIT_ACTION,
        entity: "country_policy",
        entityId: `live:${c.countryCode}`,
        detail: {
          scope: "live",
          countryCode: c.countryCode,
          from: c.from,
          to: c.to,
          approvalRef: input.approvalRef,
          approvedBy: input.approvedBy,
          approvedAt: now,
          via: "scripts/approve-live-country.ts",
        },
      });
    }
    return { approved: plan.countries.map((c) => c.countryCode), approvedAt: now };
  });
}
