import { and, count, eq, inArray, ne } from "drizzle-orm";
import { bumpUpdatedAt } from "@/lib/campaigns/errors";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaigns, mailboxes, settings } from "@/lib/db/schema";
import { classifyKind, isConsumerDomain, parseEmail } from "@/lib/email/address";
import { setSetting, settingSchemas } from "@/lib/settings";

/**
 * TEST ALICI SINIRI ("test modu").
 *
 * Amaç: gerçek (canlı) hesapla yapılan uçtan uca denemelerde gerçek kampanya iletilerinin YALNIZCA açıkça belirlenmiş
 * test adreslerine gitmesini, hem uygunluk denetiminde hem Gmail sağlayıcısında (gönderimden hemen önce) zorunlu kılmak.
 *
 * - VARSAYILAN KAPALI: normal müşteri kullanımı hiçbir zaman kendiliğinden sınırlanmaz.
 * - Yalnızca TAM e-posta adresleri (alan adı veya joker yok), en çok 50.
 * - AÇARKEN liste açıkça verilmelidir (boş liste ile açılamaz).
 * - İzin verilmeyen alıcı SİLİNMEZ ve dışlanmaz: dizi ertelenir (\`recipient_not_allowed\`); sınır kalkınca veya liste
 *   genişleyince kaldığı yerden devam edebilir, ancak OTOMATİK başlamaz (aşağıya bakın).
 * - GEVŞETME (sınırı kapatmak veya listeye adres eklemek) açık onay (\`ackLoosening\`) ister ve çalışan canlı
 *   kampanyaları DURAKLATIR (neden \`restriction\`). Bu kampanyalar yalnızca açık "yeniden başlatma onayıyla" sürdürülür
 *   (\`campaigns/lifecycle.ts\`). Sıkılaştırma (açmak, adres çıkarmak) serbesttir.
 * - Bozuk kayıt: sınır AÇIK ve liste BOŞ sayılır (her şeyi engeller); varsayılana (kapalı) düşmez.
 *
 * Bu sınır mevcut ülke politikası, DNS, çıkış bağlantısı, suppression ve uygunluk kurallarına EK bir ret nedenidir
 * (VE koşulu); hiçbirini gevşetmez. Sınır, kampanya iletilerini kısıtlar; "kendime test gönder" (zaten yalnızca kutunun
 * kendi adresine gider), gelen yanıtlar ve çıkış talepleri etkilenmez.
 */

export const RESTRICTION_KEY = "mail.recipientRestriction" as const;
export const RESTRICTION_MAX_ADDRESSES = 50;
/** Çalışan kampanyaların, sınır nedeniyle duraklatıldığını gösteren \`pause_reason\` değeri. */
export const RESTRICTION_PAUSE_REASON = "restriction" as const;
/** İzin verilmeyen alıcının dizisi bu süre sonra yeniden denetlenir (ertelenir, dışlanmaz). */
export const RESTRICTION_RECHECK_MS = 60 * 60_000;

export interface ResolvedRestriction {
  enabled: boolean;
  /** Küçük harfli, ayrıştırılmış tam adresler. */
  addresses: ReadonlySet<string>;
  /** Kayıt bozuktu: sınır açık ve boş sayıldı (her şey engellenir). */
  corrupt: boolean;
}

export const RESTRICTION_OFF: ResolvedRestriction = Object.freeze({
  enabled: false,
  addresses: new Set<string>(),
  corrupt: false,
});

/**
 * Sınırı OKUR. Kayıt yoksa KAPALI; kayıt var ama şemaya uymuyorsa AÇIK ve boş (güvenli taraf). \`getSetting\` kullanılmaz:
 * o, bozuk değeri varsayılana (kapalı) düşürürdü.
 */
export async function loadRecipientRestriction(db: DbExecutor): Promise<ResolvedRestriction> {
  const rows = await db.select().from(settings).where(eq(settings.key, RESTRICTION_KEY)).limit(1);
  const row = rows[0];
  if (!row) return RESTRICTION_OFF;
  const parsed = settingSchemas[RESTRICTION_KEY].safeParse(row.value);
  if (!parsed.success) return { enabled: true, addresses: new Set<string>(), corrupt: true };
  return {
    enabled: parsed.data.enabled,
    addresses: new Set(parsed.data.addresses.map((a) => a.toLowerCase())),
    corrupt: false,
  };
}

/** Bu alıcıya gönderilebilir mi? Sınır yoksa/kapalıysa evet; açıksa yalnızca listedeki tam adres. */
export function isRecipientAllowed(r: ResolvedRestriction | null, email: string): boolean {
  if (!r || !r.enabled) return true;
  return r.addresses.has(email.trim().toLowerCase());
}

/* ------------------------------------------------------------------------------------------------
 * Değişiklik servisi
 * ---------------------------------------------------------------------------------------------- */

export type RestrictionErrorKind =
  | "invalid_input"
  | "list_required"
  | "too_many_addresses"
  | "invalid_address"
  | "loosening_ack_required";

export class RestrictionError extends Error {
  constructor(
    readonly kind: RestrictionErrorKind,
    message: string,
    /** Yanıta eklenen, kişisel veri İÇERMEYEN makine bilgisi. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Kullanıcı girdisini tam adreslere çevirir. Yalnızca düz tam adres kabul edilir: görünen ad (\`<a@b.com>\`), boşluk, alan
 * adı girişi (\`@firma.com\`) ve joker (\`*\`) GEÇERSİZDİR. Yinelenenler tekilleştirilir.
 */
export function normalizeAddresses(raw: readonly string[]): {
  addresses: string[];
  invalid: number;
} {
  const seen = new Set<string>();
  let invalid = 0;
  for (const item of raw) {
    const value = item.trim();
    // `*` ve `?` RFC'ye göre yerel kısımda geçerlidir ama burada JOKER sayılır ve reddedilir.
    const parsed = value.length > 0 && !/[\s*?]/.test(value) ? parseEmail(value) : null;
    if (!parsed || parsed.email !== value.toLowerCase()) {
      invalid++;
      continue;
    }
    seen.add(parsed.email);
  }
  return { addresses: [...seen].sort(), invalid };
}

export interface RestrictionNote {
  address: string;
  /** Mevcut uygunluk kuralları bu adrese kampanyada zaten göndermez (bilgi amaçlı uyarı). */
  issue: "consumer" | "personal";
}

export interface RestrictionState {
  enabled: boolean;
  addresses: string[];
  updatedAt: number;
  max: number;
  /** Kayıt bozuktu (sınır açık ve boş sayılıyor). */
  corrupt: boolean;
  /** Gevşetilirse duraklatılacak, canlı posta kutusuyla ÇALIŞAN kampanyaların sayısı. */
  runningLiveCampaigns: number;
  notes: RestrictionNote[];
}

async function runningLiveCampaignCount(db: DbExecutor): Promise<number> {
  const [row] = await db
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
  return Number(row?.n ?? 0);
}

function notesFor(addresses: readonly string[]): RestrictionNote[] {
  const out: RestrictionNote[] = [];
  for (const address of addresses) {
    const p = parseEmail(address);
    if (!p) continue;
    if (isConsumerDomain(p.domain)) out.push({ address, issue: "consumer" });
    else if (classifyKind(p) !== "generic") out.push({ address, issue: "personal" });
  }
  return out;
}

export async function getRecipientRestrictionState(db: DbExecutor): Promise<RestrictionState> {
  const rows = await db.select().from(settings).where(eq(settings.key, RESTRICTION_KEY)).limit(1);
  const resolved = await loadRecipientRestriction(db);
  const parsed = rows[0] ? settingSchemas[RESTRICTION_KEY].safeParse(rows[0].value) : null;
  const addresses = [...resolved.addresses].sort();
  return {
    enabled: resolved.enabled,
    addresses,
    updatedAt: parsed?.success ? parsed.data.updatedAt : 0,
    max: RESTRICTION_MAX_ADDRESSES,
    corrupt: resolved.corrupt,
    runningLiveCampaigns: await runningLiveCampaignCount(db),
    notes: notesFor(addresses),
  };
}

export interface RestrictionUpdateInput {
  enabled: boolean;
  addresses: string[];
  /** Sınırı kapatmak veya listeye adres eklemek (gevşetme) için açık onay. */
  ackLoosening?: boolean;
}

export interface RestrictionUpdateResult {
  state: RestrictionState;
  loosened: boolean;
  /** Gevşetme nedeniyle duraklatılan canlı kampanyalar (açık yeniden başlatma onayı bekler). */
  pausedCampaigns: number[];
  changed: boolean;
}

export async function updateRecipientRestriction(
  db: Db,
  input: RestrictionUpdateInput,
  opts: { now?: number } = {},
): Promise<RestrictionUpdateResult> {
  const now = opts.now ?? Date.now();
  if (input.addresses.length > RESTRICTION_MAX_ADDRESSES * 2) {
    throw new RestrictionError("too_many_addresses", "Çok fazla adres girildi.", {
      max: RESTRICTION_MAX_ADDRESSES,
    });
  }
  const { addresses, invalid } = normalizeAddresses(input.addresses);
  if (invalid > 0) {
    throw new RestrictionError(
      "invalid_address",
      "Yalnızca geçerli tam e-posta adresleri girilebilir.",
      {
        invalid,
      },
    );
  }
  if (addresses.length > RESTRICTION_MAX_ADDRESSES) {
    throw new RestrictionError("too_many_addresses", "Çok fazla adres girildi.", {
      max: RESTRICTION_MAX_ADDRESSES,
    });
  }
  if (input.enabled && addresses.length === 0) {
    throw new RestrictionError(
      "list_required",
      "Test modunu açmak için en az bir izinli adres belirtmelisiniz.",
    );
  }

  return db.transaction(async (tx) => {
    const before = await loadRecipientRestriction(tx);
    const next = new Set(addresses);
    // Gevşetme: açıkken kapatmak VEYA açıkken listeye yeni adres eklemek. Bozuk kayıt "açık ve boş" sayıldığından onu
    // geçerli bir yapılandırmayla değiştirmek de (adres içeriyorsa) gevşetmedir.
    const added = [...next].filter((a) => !before.addresses.has(a));
    const removed = [...before.addresses].filter((a) => !next.has(a));
    const loosened = before.enabled && (!input.enabled || added.length > 0);
    const runningLive = await runningLiveCampaignCount(tx);
    if (loosened && input.ackLoosening !== true) {
      throw new RestrictionError(
        "loosening_ack_required",
        "Sınırı gevşetmek için onay gerekir: çalışan canlı kampanyalar duraklatılır.",
        { runningCampaigns: runningLive },
      );
    }
    const unchanged =
      before.enabled === input.enabled &&
      added.length === 0 &&
      removed.length === 0 &&
      !before.corrupt;
    if (unchanged) {
      return {
        state: await getRecipientRestrictionState(tx),
        loosened: false,
        pausedCampaigns: [],
        changed: false,
      };
    }

    await setSetting(tx, RESTRICTION_KEY, { enabled: input.enabled, addresses, updatedAt: now });
    await audit(
      tx,
      "recipient_restriction.updated",
      "settings",
      RESTRICTION_KEY,
      {
        enabled: input.enabled,
        addresses: addresses.length,
        added: added.length,
        removed: removed.length,
        loosened,
      },
      now,
    );

    let pausedCampaigns: number[] = [];
    if (loosened) {
      // Ertelenen alıcıların kendiliğinden gönderime başlamaması için çalışan canlı kampanyalar aynı işlemde duraklatılır.
      const rows = await tx
        .update(campaigns)
        .set({
          status: "paused",
          pausedAt: now,
          pauseReason: RESTRICTION_PAUSE_REASON,
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
      pausedCampaigns = rows.map((r) => r.id);
      if (pausedCampaigns.length > 0) {
        await audit(
          tx,
          "recipient_restriction.campaigns_paused",
          "settings",
          RESTRICTION_KEY,
          { campaigns: pausedCampaigns.length },
          now,
        );
      }
    }
    return {
      state: await getRecipientRestrictionState(tx),
      loosened,
      pausedCampaigns,
      changed: true,
    };
  });
}
