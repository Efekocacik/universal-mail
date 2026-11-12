import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { suppressEmailInTx } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, mailboxes } from "@/lib/db/schema";
import { resolveMasterKey } from "@/lib/secrets/store";
import { auditIds, stopSequences } from "./inbound/stop";

/**
 * Bağlantıyla iletişimden çıkma çekirdeği (FR-CMP-08, Aşama 13) — YALNIZCA DEMO.
 *
 * Belirteç: `v1.<kampanya_alıcısı_no>.<HMAC>`; içinde adres veya başka kişisel veri YOKTUR. HMAC anahtarı, yerel
 * şifreli gizli depodaki ana anahtardan türetilir; anahtar okunamazsa işlem reddedilir (fail-closed).
 *
 * KAPSAM SINIRI: Bu uç nokta yalnızca bu bilgisayarda (127.0.0.1) çalışır; alıcılar ve posta sağlayıcıları ona
 * ULAŞAMAZ. Bu yüzden gerçek tek tıklamalı çıkış (RFC 8058) sağlamaz, `oneClickEndpointVerified` ASLA true yapılmaz
 * ve gerçek iletilere eklenmez. Gerçek çıkış, genel erişilebilir HTTPS uç noktası kararından sonra (sonraki aşama)
 * eklenecektir.
 */

const INFO = "um-unsubscribe-v1";
const MAC_LEN = 22; // 128 bit, base64url

function macKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", resolveMasterKey(), Buffer.alloc(0), INFO, 32));
}

function mac(body: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, MAC_LEN);
}

export function createUnsubscribeToken(campaignLeadId: number): string {
  if (!Number.isSafeInteger(campaignLeadId) || campaignLeadId < 1) throw new Error("invalid id");
  const body = `v1.${campaignLeadId.toString(36)}`;
  return `${body}.${mac(body, macKey())}`;
}

/** Geçerliyse kampanya alıcısı numarasını, aksi halde null döndürür. Anahtar yoksa istisna fırlatır. */
export function verifyUnsubscribeToken(token: string): number | null {
  if (typeof token !== "string" || token.length > 80) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[0-9a-z]{1,12}$/.test(parts[1]!)) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(mac(body, macKey()));
  const given = Buffer.from(parts[2]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const id = Number.parseInt(parts[1]!, 36);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

export type UnsubscribeOutcome = "unsubscribed" | "already" | "invalid" | "unavailable";

/** Basit süreç içi hız sınırı: dakikada en çok 60 deneme (tahmin denemelerini ve taşkınları yavaşlatır). */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
let windowStart = 0;
let windowCount = 0;
export function unsubscribeRateLimited(now = Date.now()): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount > MAX_PER_WINDOW;
}
export function resetUnsubscribeRateLimitForTests(): void {
  windowStart = 0;
  windowCount = 0;
}

export async function processUnsubscribe(
  db: Db,
  token: string,
  now = Date.now(),
): Promise<UnsubscribeOutcome> {
  let id: number | null;
  try {
    id = verifyUnsubscribeToken(token);
  } catch {
    return "unavailable";
  }
  if (id === null) return "invalid";

  return db.transaction(async (tx): Promise<UnsubscribeOutcome> => {
    const [row] = await tx
      .select({ cl: campaignLeads, provider: mailboxes.provider })
      .from(campaignLeads)
      .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
      .leftJoin(mailboxes, eq(mailboxes.id, campaigns.mailboxId))
      .where(eq(campaignLeads.id, id))
      .limit(1);
    // Var olmayan kayıt, geçersiz belirteçle aynı yanıtı verir (kayıt varlığı sızdırılmaz).
    if (!row) return "invalid";
    // Canlı kapsam: bu uç nokta gerçek alıcılar için sunulmaz.
    if (!row.provider || policyScopeForMailbox(row.provider) !== "demo") return "invalid";
    const { cl } = row;
    if (!cl.recipientEmail) return "already"; // adres silinmiş; engel zaten silme kaydında

    const res = await suppressEmailInTx(
      tx,
      { email: cl.recipientEmail, reason: "unsubscribe", source: "link" },
      now,
    );
    // 15.10-2: alıcının süren dizileri durur (`stop_reason='unsubscribe'`). Bitmiş dizi durumunu korur ve nedeni
    // yalnızca bağlantının ait olduğu dizide kaydedilir (TB-10).
    const stop = await stopSequences(
      tx,
      cl.recipientHash ? { recipientHash: cl.recipientHash } : { campaignLeadId: cl.id },
      "unsubscribe",
      now,
      cl.id,
    );
    const changed = stop.stopped.length + stop.annotated.length;
    await audit(
      tx,
      "unsubscribe.link",
      "campaign_lead",
      cl.id,
      {
        outcome: res.outcome,
        stopped: stop.stopped.length,
        stoppedIds: auditIds(stop.stopped),
        annotated: stop.annotated.length,
      },
      now,
    );
    return res.outcome === "existing" && changed === 0 ? "already" : "unsubscribed";
  });
}
