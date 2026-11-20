import { and, count, eq, inArray, ne } from "drizzle-orm";
import { bumpUpdatedAt } from "@/lib/campaigns/errors";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaigns, countryPolicies, mailboxes, messages } from "@/lib/db/schema";
import { isKnownCountry } from "@/lib/geo/countries";
import type { CountryActivationSummary } from "@/lib/native-confirm-protocol";
import {
  isNativeConfirmChannelAvailable,
  NativeConfirmUnavailableError,
  type NativeConfirmOutcome,
} from "@/lib/native-confirm";
import { getSetting } from "@/lib/settings";
import {
  applyLiveCountryApproval,
  LiveCountryApprovalError,
  planLiveCountryApproval,
  type CountryPlan,
} from "./live-country-approval";
import {
  ACTIVATION_DOCUMENT_MAX_AGE_DAYS,
  ACTIVATION_MAX_COUNTRIES,
  ACTIVATION_SELF_TEST_MAX_AGE_DAYS,
  COUNTRY_REVOKED_PAUSE_REASON,
} from "./live-country-constants";
import { ActivationError } from "./live-country-error";
import { getLiveReadiness, type ReadinessKey } from "./live-readiness";
import { normalizeCountryCode, policyScopeForMailbox } from "./policies";
import { loadRecipientRestriction } from "./recipient-restriction";

/**
 * UYGULAMA İÇİ ülke aktivasyonu ve geri alma (canlı ülke politikası kilidi).
 *
 * Bu dosya, `live-country-approval.ts`'i içe aktarmaya izin verilen TEK uygulama modülüdür; kendisini yalnızca
 * `src/app/api/compliance/live-country/route.ts` içe aktarır (tests/live-country-approval.test.ts bunu denetler).
 * `policy-service.ts` canlı satırları değiştirmeyi reddetmeye devam eder; veritabanı CHECK kısıtları ve
 * `applyLiveCountryApproval` mantığı aynen kullanılır (ülke bazlı kilit, onay alanları, tek işlem, denetim kaydı).
 *
 * AKTİVASYON (`activateLiveCountries`) şunların HEPSİNİ ister:
 *  1. Hukuki yetkilendirme KAYDI (yetkili temsilci adı/unvanı, belge referansı ve tarihi, kapsam beyanı). Bu kayıt
 *     gerçek hukuki yetkinin doğrulandığı ANLAMINA GELMEZ: uygulama belgenin geçerliliğini veya kişinin yetkisini
 *     doğrulayamaz; yalnızca kimin hangi belgeye dayanarak açtığını denetim kaydına yazar.
 *  2. Test modu AÇIK ve izinli adres listesi dolu (ilk pilot yalnızca izinli adreslere gider; üretime geçiş, test
 *     modunu kapatmak olarak ayrı ve onaylı bir adımdır).
 *  3. Gönderim ön koşulları (onay, firma profili, bağlı gerçek kutu, DNS, doğrulanmış çıkış uç noktası, sağlıklı
 *     çekme) ve her gerçek kutu için son yeniden bağlanmadan sonra, en çok 30 gün içinde başarılı "kendime test gönder".
 *  4. Electron ana sürecinden TEK KULLANIMLIK yerel onay (özet ve kimliğe bağlı, 120 sn, varsayılan İptal). Kanal yoksa
 *     (tarayıcı, betik, test) aktivasyon REDDEDİLİR.
 *
 * GERİ ALMA (`revokeLiveCountries`): çalışan canlı kampanyaları ÖNCE duraklatır (`country_blocked` dağıtıcıda kalıcı
 * dışlama nedenidir; duraklatma bunu önler), sonra ülkeyi yeniden `blocked` + kilitli yapar. Sıkılaştırma olduğu için
 * yerel onay gerekmez.
 */

export type ActivationMode = "generic_only" | "allowed";

export interface ActivationInput {
  countries: string[];
  mode: ActivationMode;
  representativeName: string;
  representativeTitle: string;
  operatorName: string;
  documentRef: string;
  /** Belge tarihi, "YYYY-MM-DD". */
  documentDate: string;
  /** İsteğe bağlı: belgenin SHA-256 özeti (belge saklanmaz). */
  documentSha256?: string | null;
  /** "Belgedeki ülkeler ve mod, burada seçilenlerle aynıdır" beyanı. */
  scopeAttested: boolean;
}

export interface NormalizedActivation {
  countries: string[];
  mode: ActivationMode;
  representativeName: string;
  representativeTitle: string;
  operatorName: string;
  documentRef: string;
  documentDate: string;
  documentSha256: string | null;
  /** `approved_by` sütununa yazılacak değer (≤ 120). */
  approvedBy: string;
  /** `approval_ref` sütununa yazılacak değer (≤ 200). */
  approvalRef: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const DAY_MS = 86_400_000;

function field(value: unknown, min: number, max: number, name: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max || CONTROL.test(s)) {
    throw new ActivationError(
      "activation_legal",
      `${name} ${min}–${max} karakter olmalı (kontrol karakteri içeremez).`,
      { field: name },
    );
  }
  return s;
}

/** "YYYY-MM-DD" → UTC gün başlangıcı (geçersizse `null`). */
function parseDay(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

export function validateActivationInput(input: ActivationInput, now: number): NormalizedActivation {
  // Ülkeler ve mod
  const rawCountries = Array.isArray(input.countries) ? input.countries : [];
  const countries: string[] = [];
  for (const c of rawCountries) {
    const code = typeof c === "string" ? normalizeCountryCode(c) : null;
    if (!code || !isKnownCountry(code)) {
      throw new ActivationError("activation_invalid", "Desteklenmeyen ülke kodu.", {
        field: "countries",
      });
    }
    if (!countries.includes(code)) countries.push(code);
  }
  if (countries.length < 1 || countries.length > ACTIVATION_MAX_COUNTRIES) {
    throw new ActivationError(
      "activation_invalid",
      `1–${ACTIVATION_MAX_COUNTRIES} ülke seçilmeli.`,
      { field: "countries" },
    );
  }
  if (input.mode !== "generic_only" && input.mode !== "allowed") {
    throw new ActivationError("activation_invalid", "Geçersiz mod.", { field: "mode" });
  }

  // Hukuki yetkilendirme KAYDI (zorunlu)
  const representativeName = field(input.representativeName, 2, 40, "representativeName");
  const representativeTitle = field(input.representativeTitle, 2, 30, "representativeTitle");
  const operatorName = field(input.operatorName, 2, 30, "operatorName");
  const documentRef = field(input.documentRef, 3, 100, "documentRef");
  if (input.scopeAttested !== true) {
    throw new ActivationError(
      "activation_legal",
      "Belgedeki kapsamın seçilen ülkeler ve modla aynı olduğu beyan edilmeli.",
      { field: "scopeAttested" },
    );
  }
  const documentDate = typeof input.documentDate === "string" ? input.documentDate.trim() : "";
  const docDay = parseDay(documentDate);
  const today = parseDay(new Date(now).toISOString().slice(0, 10))!;
  if (docDay === null) {
    throw new ActivationError("activation_legal", "Belge tarihi YYYY-AA-GG olmalı.", {
      field: "documentDate",
    });
  }
  if (docDay > today) {
    throw new ActivationError("activation_legal", "Belge tarihi gelecekte olamaz.", {
      field: "documentDate",
    });
  }
  if ((today - docDay) / DAY_MS > ACTIVATION_DOCUMENT_MAX_AGE_DAYS) {
    throw new ActivationError(
      "activation_legal",
      `Belge ${ACTIVATION_DOCUMENT_MAX_AGE_DAYS} günden eski; güncel bir onay gerekir.`,
      { field: "documentDate", maxAgeDays: ACTIVATION_DOCUMENT_MAX_AGE_DAYS },
    );
  }
  let documentSha256: string | null = null;
  if (
    input.documentSha256 !== undefined &&
    input.documentSha256 !== null &&
    input.documentSha256 !== ""
  ) {
    const h = String(input.documentSha256).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) {
      throw new ActivationError("activation_legal", "Belge özeti 64 onaltılık karakter olmalı.", {
        field: "documentSha256",
      });
    }
    documentSha256 = h;
  }

  const approvedBy = `${representativeName} (${representativeTitle}); işlem: ${operatorName}`;
  const approvalRef = `${documentRef} | ${documentDate}${
    documentSha256 ? ` | sha256:${documentSha256.slice(0, 16)}` : ""
  }`;
  return {
    countries,
    mode: input.mode,
    representativeName,
    representativeTitle,
    operatorName,
    documentRef,
    documentDate,
    documentSha256,
    approvedBy,
    approvalRef,
  };
}

/* ------------------------------ ön koşullar ------------------------------ */

/** Aktivasyon için "tamam" olması gereken hazırlık maddeleri (inbox_*, pilot ve başlık güveni bilinçli olarak yok). */
export const REQUIRED_READINESS: readonly ReadinessKey[] = [
  "live_flag",
  "consent",
  "company_profile",
  "real_mailbox",
  "dns_auth",
  "https_unsubscribe",
  "event_delivery",
  "legal_live_countries",
];

export interface PrerequisiteCheck {
  key: string;
  ok: boolean;
}

export interface PrerequisiteReport {
  ok: boolean;
  checks: PrerequisiteCheck[];
  testMode: { enabled: boolean; addresses: number; corrupt: boolean };
  /** Gerçek bağlı kutu başına kendime test kanıtı. */
  selfTest: { mailboxId: number; ok: boolean }[];
}

export async function checkActivationPrerequisites(
  db: DbExecutor,
  now: number,
  env: Record<string, string | undefined> = process.env,
): Promise<PrerequisiteReport> {
  const readiness = await getLiveReadiness(db, { now, env });
  const byKey = new Map(readiness.items.map((i) => [i.key, i.status]));
  const checks: PrerequisiteCheck[] = REQUIRED_READINESS.map((key) => ({
    key,
    ok: byKey.get(key) === "ok",
  }));

  const restriction = await loadRecipientRestriction(db);
  const testMode = {
    enabled: restriction.enabled,
    addresses: restriction.addresses.size,
    corrupt: restriction.corrupt === true,
  };
  checks.push({
    key: "test_mode",
    ok: testMode.enabled && !testMode.corrupt && testMode.addresses >= 1,
  });

  const boxes = (await db.select().from(mailboxes)).filter(
    (m) => policyScopeForMailbox(m.provider) === "live" && m.status === "connected",
  );
  const selfTest: { mailboxId: number; ok: boolean }[] = [];
  for (const m of boxes) {
    // Kanıt: bu kutunun son (yeniden) bağlanmasından SONRA ve son 30 gün içinde başarılı kendime test.
    const since = Math.max(m.connectedAt ?? 0, now - ACTIVATION_SELF_TEST_MAX_AGE_DAYS * DAY_MS);
    const rows = await db
      .select({ sentAt: messages.sentAt })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "out"),
          eq(messages.purpose, "test"),
          eq(messages.mailboxId, m.id),
          eq(messages.status, "sent"),
        ),
      );
    selfTest.push({ mailboxId: m.id, ok: rows.some((r) => (r.sentAt ?? 0) >= since) });
  }
  checks.push({ key: "self_test", ok: selfTest.length > 0 && selfTest.every((s) => s.ok) });

  return { ok: checks.every((c) => c.ok), checks, testMode, selfTest };
}

async function runningLiveCampaignCount(db: DbExecutor): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "running"),
        inArray(
          campaigns.mailboxId,
          db.select({ id: mailboxes.id }).from(mailboxes).where(ne(mailboxes.provider, "demo")),
        ),
      ),
    );
  return Number(r?.n ?? 0);
}

/* --------------------------------- durum --------------------------------- */

export interface LiveCountryRow {
  countryCode: string;
  mode: string;
  locked: boolean;
  approvalRef: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
}

export interface LiveCountryState {
  countries: LiveCountryRow[];
  prerequisites: PrerequisiteReport;
  /** Yerel onay kanalı var mı (paketli masaüstü uygulaması)? Yoksa aktivasyon yapılamaz. */
  nativeConfirmAvailable: boolean;
  runningLiveCampaigns: number;
  limits: {
    maxCountries: number;
    documentMaxAgeDays: number;
    selfTestMaxAgeDays: number;
  };
}

export async function getLiveCountryState(
  db: DbExecutor,
  opts: {
    now?: number;
    env?: Record<string, string | undefined>;
    nativeConfirmAvailable?: boolean;
  } = {},
): Promise<LiveCountryState> {
  const now = opts.now ?? Date.now();
  const rows = await db.select().from(countryPolicies).where(eq(countryPolicies.scope, "live"));
  return {
    countries: rows
      .map((r) => ({
        countryCode: r.countryCode,
        mode: r.mode,
        locked: r.locked,
        approvalRef: r.approvalRef,
        approvedBy: r.approvedBy,
        approvedAt: r.approvedAt,
      }))
      .sort((a, b) => a.countryCode.localeCompare(b.countryCode)),
    prerequisites: await checkActivationPrerequisites(db, now, opts.env),
    nativeConfirmAvailable: opts.nativeConfirmAvailable ?? isNativeConfirmChannelAvailable(),
    runningLiveCampaigns: await runningLiveCampaignCount(db),
    limits: {
      maxCountries: ACTIVATION_MAX_COUNTRIES,
      documentMaxAgeDays: ACTIVATION_DOCUMENT_MAX_AGE_DAYS,
      selfTestMaxAgeDays: ACTIVATION_SELF_TEST_MAX_AGE_DAYS,
    },
  };
}

/* --------------------------------- plan ---------------------------------- */

export interface ActivationPlan {
  input: NormalizedActivation;
  prerequisites: PrerequisiteReport;
  countries: CountryPlan[];
  blockers: string[];
  warnings: string[];
  runningLiveCampaigns: number;
  /** Uygulanabilir mi (tüm ön koşullar tamam, ülke sorunu yok)? Yerel onay ayrıca gerekir. */
  ready: boolean;
}

export async function planActivation(
  db: DbExecutor,
  rawInput: ActivationInput,
  opts: { now?: number; env?: Record<string, string | undefined> } = {},
): Promise<ActivationPlan> {
  const now = opts.now ?? Date.now();
  const input = validateActivationInput(rawInput, now);
  const prerequisites = await checkActivationPrerequisites(db, now, opts.env);
  const base = await planLiveCountryApproval(
    db,
    {
      countries: input.countries,
      mode: input.mode,
      approvalRef: input.approvalRef,
      approvedBy: input.approvedBy,
    },
    now,
  );
  const warnings: string[] = [];
  const consent = await getSetting(db, "consent");
  if (consent && consent.name.trim().toLowerCase() !== input.operatorName.trim().toLowerCase()) {
    warnings.push("operator_differs_from_consent");
  }
  return {
    input,
    prerequisites,
    countries: base.countries,
    blockers: base.blockers,
    warnings,
    runningLiveCampaigns: await runningLiveCampaignCount(db),
    ready: prerequisites.ok && base.ready,
  };
}

/* ------------------------------- aktivasyon ------------------------------- */

export interface ActivationDeps {
  /** Yerel onay isteği (üretimde `requestNativeConfirm`). */
  confirm: (req: {
    kind: "country_activation";
    summary: CountryActivationSummary;
  }) => Promise<NativeConfirmOutcome>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export interface ActivationResult {
  activated: string[];
  approvedAt: number;
  warnings: string[];
}

function failedChecks(p: PrerequisiteReport): string[] {
  return p.checks.filter((c) => !c.ok).map((c) => c.key);
}

export async function activateLiveCountries(
  db: Db,
  rawInput: ActivationInput,
  deps: ActivationDeps,
): Promise<ActivationResult> {
  const clock = deps.now ?? Date.now;
  const plan = await planActivation(db, rawInput, { now: clock(), env: deps.env });
  const input = plan.input;
  const cancelled = async (reason: string) =>
    audit(
      db,
      "country_policy.activation_cancelled",
      "country_policy",
      input.countries.join(","),
      { countries: input.countries, mode: input.mode, reason },
      clock(),
    );

  // Test modu ayrı ve açık bir kural olarak raporlanır (arayüz buna özel yönlendirme gösterir).
  if (!plan.prerequisites.checks.find((c) => c.key === "test_mode")?.ok) {
    await cancelled("test_mode_required");
    throw new ActivationError(
      "activation_test_mode",
      "İlk aktivasyon için test modu açık ve izinli adres listesi dolu olmalı.",
      { testMode: plan.prerequisites.testMode },
    );
  }
  if (!plan.prerequisites.ok) {
    await cancelled("prerequisites");
    throw new ActivationError("activation_prerequisites", "Gönderim ön koşulları tamam değil.", {
      failed: failedChecks(plan.prerequisites),
    });
  }
  if (plan.blockers.length > 0 || plan.countries.some((c) => c.problems.length > 0)) {
    await cancelled("country_problem");
    throw new ActivationError("activation_refused", "Ülke açılamıyor.", {
      problems: plan.countries.flatMap((c) => c.problems.map((p) => `${c.countryCode}: ${p}`)),
      blockers: plan.blockers,
    });
  }

  const summary: CountryActivationSummary = {
    countries: input.countries,
    mode: input.mode,
    operatorName: input.operatorName,
    representativeName: input.representativeName,
    representativeTitle: input.representativeTitle,
    documentRef: input.documentRef,
    documentDate: input.documentDate,
    documentShaPrefix: input.documentSha256 ? input.documentSha256.slice(0, 16) : null,
    testModeEnabled: plan.prerequisites.testMode.enabled,
    allowedAddressCount: plan.prerequisites.testMode.addresses,
    runningLiveCampaigns: plan.runningLiveCampaigns,
  };

  // Yerel (insan) onayı: yoksa, iptal edilirse veya süre dolarsa HİÇBİR ŞEY yazılmaz.
  let outcome: NativeConfirmOutcome;
  try {
    outcome = await deps.confirm({ kind: "country_activation", summary });
  } catch (e) {
    if (e instanceof NativeConfirmUnavailableError) {
      await cancelled(`unavailable:${e.why}`);
      throw new ActivationError("confirm_unavailable", e.message, { why: e.why });
    }
    throw e;
  }
  if (outcome !== "approved") {
    await cancelled(outcome);
    throw new ActivationError(
      outcome === "timeout" ? "confirm_timeout" : "confirm_declined",
      outcome === "timeout" ? "Yerel onay süresi doldu." : "Yerel onay verilmedi.",
    );
  }

  // Onaydan sonra her şey yeniden doğrulanır (onay beklerken durum değişmiş olabilir).
  const now = clock();
  const again = await checkActivationPrerequisites(db, now, deps.env);
  if (!again.ok) {
    await cancelled("prerequisites_changed");
    throw new ActivationError("activation_prerequisites", "Onay sırasında ön koşullar değişti.", {
      failed: failedChecks(again),
    });
  }

  let result;
  try {
    result = await applyLiveCountryApproval(
      db,
      {
        countries: input.countries,
        mode: input.mode,
        approvalRef: input.approvalRef,
        approvedBy: input.approvedBy,
      },
      { now, via: "app:native-confirm" },
    );
  } catch (e) {
    if (e instanceof LiveCountryApprovalError) {
      await cancelled("apply_refused");
      throw new ActivationError("activation_refused", e.message);
    }
    throw e;
  }

  await audit(
    db,
    "country_policy.activation_confirmed",
    "country_policy",
    input.countries.join(","),
    {
      countries: input.countries,
      mode: input.mode,
      // Hukuki yetkilendirme KAYDI: beyan edilen değerler; doğrulanmış hukuki yetki DEĞİLDİR.
      legalRecord: {
        representativeName: input.representativeName,
        representativeTitle: input.representativeTitle,
        documentRef: input.documentRef,
        documentDate: input.documentDate,
        documentShaPrefix: input.documentSha256 ? input.documentSha256.slice(0, 16) : null,
        scopeAttested: true,
        verifiedByApp: false,
      },
      operatorName: input.operatorName,
      testMode: plan.prerequisites.testMode,
      warnings: plan.warnings,
      confirm: "native",
    },
    now,
  );
  return { activated: result.approved, approvedAt: result.approvedAt, warnings: plan.warnings };
}

/* -------------------------------- geri alma -------------------------------- */

export interface RevokeInput {
  countries: string[];
  /** Açık onay: çalışan canlı kampanyalar duraklatılır ve sürdürmede o ülkenin alıcıları dışlanır. */
  ack: boolean;
}

export interface RevokeResult {
  revoked: string[];
  pausedCampaigns: number[];
}

export async function revokeLiveCountries(
  db: Db,
  input: RevokeInput,
  opts: { now?: number } = {},
): Promise<RevokeResult> {
  const now = opts.now ?? Date.now();
  const codes: string[] = [];
  for (const c of Array.isArray(input.countries) ? input.countries : []) {
    const code = typeof c === "string" ? normalizeCountryCode(c) : null;
    if (!code || !isKnownCountry(code)) {
      throw new ActivationError("activation_invalid", "Desteklenmeyen ülke kodu.", {
        field: "countries",
      });
    }
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length < 1 || codes.length > ACTIVATION_MAX_COUNTRIES) {
    throw new ActivationError(
      "activation_invalid",
      `1–${ACTIVATION_MAX_COUNTRIES} ülke seçilmeli.`,
      { field: "countries" },
    );
  }
  if (input.ack !== true) {
    throw new ActivationError(
      "activation_invalid",
      "Geri alma için açık onay gerekir: çalışan canlı kampanyalar duraklatılır.",
      { field: "ack" },
    );
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), inArray(countryPolicies.countryCode, codes)));
    const open = rows.filter((r) => r.mode !== "blocked" || !r.locked);
    if (open.length === 0) {
      throw new ActivationError("activation_invalid", "Seçilen ülkeler zaten kilitli.", {
        field: "countries",
      });
    }

    // 1) ÖNCE kampanyaları duraklat: dağıtıcı yalnızca `running` kampanyaları seçer; böylece `country_blocked`
    //    (kalıcı dışlama nedeni) hiçbir alıcıya uygulanmaz. Gönderimi sürmekte olan istek geri alınamaz; sonucu
    //    normal yoldan kaydedilir.
    const paused = await tx
      .update(campaigns)
      .set({
        status: "paused",
        pausedAt: now,
        pauseReason: COUNTRY_REVOKED_PAUSE_REASON,
        updatedAt: bumpUpdatedAt(now),
      })
      .where(
        and(
          eq(campaigns.status, "running"),
          inArray(
            campaigns.mailboxId,
            tx.select({ id: mailboxes.id }).from(mailboxes).where(ne(mailboxes.provider, "demo")),
          ),
        ),
      )
      .returning({ id: campaigns.id });
    const pausedIds = paused.map((r) => r.id);

    // 2) Sonra ülkeleri yeniden engelle + kilitle (CHECK kısıtlarına uyar: kilitli satır yalnızca `blocked` olabilir).
    for (const r of open) {
      const updated = await tx
        .update(countryPolicies)
        .set({
          mode: "blocked",
          locked: true,
          approvalRef: null,
          approvedBy: null,
          approvedAt: null,
          updatedAt: now,
        })
        .where(
          and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, r.countryCode)),
        )
        .returning({ code: countryPolicies.countryCode });
      if (updated.length !== 1) {
        throw new ActivationError("activation_refused", `${r.countryCode}: satır değiştirilemedi.`);
      }
      await audit(
        tx,
        "country_policy.live_revoked",
        "country_policy",
        `live:${r.countryCode}`,
        {
          scope: "live",
          countryCode: r.countryCode,
          from: { mode: r.mode, locked: r.locked },
          previousApprovalRef: r.approvalRef,
          previousApprovedBy: r.approvedBy,
          previousApprovedAt: r.approvedAt,
          to: { mode: "blocked", locked: true },
          pausedCampaigns: pausedIds.length,
          via: "app",
        },
        now,
      );
    }
    if (pausedIds.length > 0) {
      await audit(
        tx,
        "country_policy.campaigns_paused",
        "country_policy",
        open.map((r) => r.countryCode).join(","),
        { campaigns: pausedIds.length, reason: COUNTRY_REVOKED_PAUSE_REASON },
        now,
      );
    }
    return { revoked: open.map((r) => r.countryCode), pausedCampaigns: pausedIds };
  });
}
