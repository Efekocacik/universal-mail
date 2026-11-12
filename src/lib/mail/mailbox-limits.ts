import { and, eq } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes } from "@/lib/db/schema";
import { wakeDispatchSafely, type WakeOutcome } from "./scheduler/job";
import { effectiveMailboxCap, mailboxLimitBounds } from "./scheduler/limits";

/**
 * Posta kutusu günlük tavanı ve ısınma artışı (Faz 4, hata c). Kullanıcı Ayarlar → Posta kutuları → "Günlük sınır"
 * penceresinden değiştirir.
 *
 *  - Sınırlar profile göredir: kişisel Gmail en çok 50/gün ve haftada en çok +5; diğerleri en çok 80/gün ve +10.
 *    Profil üst sınırını aşan değer SESSİZCE KIRPILMAZ, açık hata kodu ile reddedilir (`cap_above_provider_max`,
 *    `warmup_step_above_max`). Veritabanı kısıtı (1..80, 0..10) ayrıca savunma katmanıdır.
 *  - Demo kutusu değiştirilemez (demo tohumu sabittir).
 *  - İyimser eşzamanlılık: istemci okuduğu `updatedAt` değerini gönderir; arada değişmişse 409 `conflict`.
 *  - Tavan yükselir ve bugünkü geçerli tavan artarsa dağıtıcı HEMEN uyandırılır (işlem kaydedildikten sonra). Bu bir
 *    gönderim kararı değildir: 90 s aralık, ısınma tavanı, pencere ve bütün uygunluk kuralları gönderim anında aynen
 *    uygulanır; ısınma rampası atlanamaz (`effectiveMailboxCap` her zaman ısınma tavanıyla sınırlıdır).
 *  - Denetim kaydı adres İÇERMEZ; yalnızca eski/yeni değerler.
 */

export type MailboxLimitsErrorKind =
  | "invalid_input"
  | "not_found"
  | "not_editable"
  | "conflict"
  | "cap_above_provider_max"
  | "warmup_step_above_max";

export const MAILBOX_LIMITS_STATUS: Record<MailboxLimitsErrorKind, number> = {
  invalid_input: 400,
  cap_above_provider_max: 400,
  warmup_step_above_max: 400,
  not_found: 404,
  not_editable: 409,
  conflict: 409,
};

export class MailboxLimitsError extends Error {
  constructor(
    readonly kind: MailboxLimitsErrorKind,
    message: string,
    readonly detail: Record<string, number> = {},
  ) {
    super(message);
  }
}

export interface MailboxLimitsPatch {
  dailyCap?: number;
  warmupStep?: number;
  /** İstemcinin okuduğu `mailboxes.updated_at`. */
  expectedUpdatedAt: number;
}

export interface MailboxLimitsResult {
  id: number;
  dailyCap: number;
  warmupStep: number;
  updatedAt: number;
  todayCap: number;
  /** Değer değişmedi (aynı değerlerle tekrar istek); hiçbir şey yazılmadı. */
  unchanged: boolean;
  wake: WakeOutcome | "failed" | null;
}

export async function updateMailboxLimits(
  db: Db,
  id: number,
  patch: MailboxLimitsPatch,
  opts: { now?: number; env?: Record<string, string | undefined> } = {},
): Promise<MailboxLimitsResult> {
  if (patch.dailyCap === undefined && patch.warmupStep === undefined) {
    throw new MailboxLimitsError("invalid_input", "Değiştirilecek bir sınır belirtilmedi.");
  }
  const now = opts.now ?? Date.now();

  const out = await db.transaction(async (tx) => {
    const [mb] = await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    if (!mb) throw new MailboxLimitsError("not_found", "Posta kutusu bulunamadı.");
    if (mb.provider === "demo") {
      throw new MailboxLimitsError(
        "not_editable",
        "Demo posta kutusunun sınırları değiştirilemez.",
      );
    }
    const bounds = mailboxLimitBounds(mb);
    if (patch.dailyCap !== undefined && patch.dailyCap > bounds.maxDailyCap) {
      throw new MailboxLimitsError(
        "cap_above_provider_max",
        `Bu posta kutusu için günlük sınır en çok ${bounds.maxDailyCap} olabilir.`,
        { max: bounds.maxDailyCap },
      );
    }
    if (patch.warmupStep !== undefined && patch.warmupStep > bounds.maxWarmupStep) {
      throw new MailboxLimitsError(
        "warmup_step_above_max",
        `Bu posta kutusu için haftalık artış en çok ${bounds.maxWarmupStep} olabilir.`,
        { max: bounds.maxWarmupStep },
      );
    }
    const next = {
      dailyCap: patch.dailyCap ?? mb.dailyCap,
      warmupStep: patch.warmupStep ?? mb.warmupStep,
    };
    const beforeCap = effectiveMailboxCap(mb, now);
    if (next.dailyCap === mb.dailyCap && next.warmupStep === mb.warmupStep) {
      // Aynı değerlerin tekrarı (ör. yanıtı kaybolan istek): yazma yok, sürüm denetimi de gerekmez.
      return { mb, next, beforeCap, afterCap: beforeCap, updatedAt: mb.updatedAt, unchanged: true };
    }
    if (mb.updatedAt !== patch.expectedUpdatedAt) {
      throw new MailboxLimitsError(
        "conflict",
        "Posta kutusu başka bir yerde değiştirildi; güncel değerler yüklendi, yeniden deneyin.",
      );
    }
    const updatedAt = Math.max(now, mb.updatedAt + 1);
    const rows = await tx
      .update(mailboxes)
      .set({ ...next, updatedAt })
      .where(and(eq(mailboxes.id, id), eq(mailboxes.updatedAt, patch.expectedUpdatedAt)))
      .returning({ id: mailboxes.id });
    if (rows.length !== 1) {
      throw new MailboxLimitsError(
        "conflict",
        "Posta kutusu başka bir yerde değiştirildi; güncel değerler yüklendi, yeniden deneyin.",
      );
    }
    const afterCap = effectiveMailboxCap({ ...mb, ...next }, now);
    await audit(
      tx,
      "mailbox.limits_updated",
      "mailbox",
      id,
      {
        from: { dailyCap: mb.dailyCap, warmupStep: mb.warmupStep },
        to: next,
        todayCap: { from: beforeCap, to: afterCap },
      },
      now,
    );
    return { mb, next, beforeCap, afterCap, updatedAt, unchanged: false };
  });

  const wake =
    !out.unchanged && out.afterCap > out.beforeCap
      ? await wakeDispatchSafely(db, { now, env: opts.env, source: "mailbox.limits" })
      : null;
  return {
    id,
    dailyCap: out.next.dailyCap,
    warmupStep: out.next.warmupStep,
    updatedAt: out.updatedAt,
    todayCap: out.afterCap,
    unchanged: out.unchanged,
    wake,
  };
}
