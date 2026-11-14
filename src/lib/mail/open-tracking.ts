import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { messageOpens, messages } from "@/lib/db/schema";
import { resolveMasterKey } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { DEMO_OPEN_PIXEL_BASE } from "./mime/message-builder";

/**
 * Açılma izleme (Faz 5, SRS FR-CMP-09) — varsayılan KAPALI, bu sürümde YALNIZCA DEMO.
 *
 *  - Ayar `tracking.opens` açık değilse hiçbir piksel eklenmez ve hiçbir açılma yazılmaz.
 *  - Piksel yalnızca demo kampanya iletisine eklenir; canlı iletiye ASLA eklenmez (genel erişilebilir aktarıcı
 *    `/o/:token` + çekme işi gelene kadar). Demo iletisi gönderilmediğinden pikselin adresi `.invalid` örnek alan
 *    adıdır; yerel `GET /api/t/o/:token` aynı belirteci doğrular (elle deneme ve testler için).
 *  - Belirteç: `o1.<kampanya_alıcısı_no(36)>.<adım>.<HMAC-SHA256 22>`; içinde adres veya kişisel veri YOKTUR.
 *    İletiye, gönderim kaydının idempotency anahtarı (`cl:<no>:s:<adım>`) üzerinden bağlanır: belirteç ileti satırı
 *    yazılmadan önce üretilebilir ve aynı adımın yeniden denemesi aynı belirteci verir.
 *  - Açılma verisi kesin DEĞİLDİR (görsel engelleme, otomatik ön yükleme); arayüz bunu her yerde söyler.
 */

const INFO = "um-open-v1";
const MAC_LEN = 22;
const TOKEN_RE = /^o1\.([0-9a-z]{1,11})\.([0-2])\.([A-Za-z0-9_-]{22})$/;

export { DEMO_OPEN_PIXEL_BASE };

/** 1×1 saydam GIF (43 bayt). */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);

/** Bir iletinin açılma sayacı bu değerde durur (sınırsız büyüme yok). */
export const MAX_OPEN_COUNT = 10_000;

/** Demo benzetimi: iletilerin yaklaşık yüzde kaçı "açıldı" sayılır. */
export const DEMO_OPEN_PERCENT = 40;

function macKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", resolveMasterKey(), Buffer.alloc(0), INFO, 32));
}

function mac(body: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, MAC_LEN);
}

export interface OpenRef {
  campaignLeadId: number;
  stepIndex: number;
}

export function createOpenToken(ref: OpenRef): string {
  if (!Number.isSafeInteger(ref.campaignLeadId) || ref.campaignLeadId < 1)
    throw new Error("invalid campaign lead id");
  if (!Number.isInteger(ref.stepIndex) || ref.stepIndex < 0 || ref.stepIndex > 2)
    throw new Error("invalid step index");
  const body = `o1.${ref.campaignLeadId.toString(36)}.${ref.stepIndex}`;
  return `${body}.${mac(body, macKey())}`;
}

/** Geçerliyse başvuruyu, aksi halde null döndürür (biçim, sabit zamanlı HMAC karşılaştırması). */
export function verifyOpenToken(token: string): OpenRef | null {
  if (typeof token !== "string" || token.length > 64) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const body = `o1.${m[1]}.${m[2]}`;
  const expected = Buffer.from(mac(body, macKey()));
  const given = Buffer.from(m[3]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const campaignLeadId = Number.parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(campaignLeadId) || campaignLeadId < 1) return null;
  return { campaignLeadId, stepIndex: Number(m[2]) };
}

export function demoOpenPixelUrl(ref: OpenRef): string {
  return `${DEMO_OPEN_PIXEL_BASE}${createOpenToken(ref)}`;
}

/** Açılma izleme açık mı? (Ayar okunamazsa varsayılan: kapalı.) */
export async function openTrackingEnabled(db: DbExecutor): Promise<boolean> {
  return (await getSetting(db, "tracking.opens")).enabled === true;
}

export type PixelOutcome = "recorded" | "disabled" | "invalid" | "unknown_message";

/**
 * Piksel isteğini işler: izleme açıksa ve belirteç geçerliyse iletinin açılmasını yazar (upsert; sayaç sınırlı).
 * Anahtar veya veritabanı hatası çağırana iletilir (yutulmaz); uç nokta her durumda aynı GIF'i döndürür, böylece
 * belirtecin geçerli olup olmadığı dışarı sızmaz.
 */
export async function recordPixelOpen(
  db: DbExecutor,
  token: string,
  now = Date.now(),
): Promise<PixelOutcome> {
  if (!(await openTrackingEnabled(db))) return "disabled";
  const ref = verifyOpenToken(token);
  if (!ref) return "invalid";
  const [msg] = await db
    .select({ id: messages.id, campaignId: messages.campaignId, sentAt: messages.sentAt })
    .from(messages)
    .where(
      and(
        eq(messages.idempotencyKey, `cl:${ref.campaignLeadId}:s:${ref.stepIndex}`),
        eq(messages.status, "sent"),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
      ),
    )
    .limit(1);
  if (!msg || msg.campaignId === null) return "unknown_message";
  // Açılma gönderimden önce olamaz (saat kayması): en erken gönderim anı.
  const at = Math.max(now, msg.sentAt ?? now);
  await db
    .insert(messageOpens)
    .values({
      messageId: msg.id,
      campaignId: msg.campaignId,
      firstOpenedAt: at,
      lastOpenedAt: at,
      openCount: 1,
      source: "pixel",
    })
    .onConflictDoUpdate({
      target: messageOpens.messageId,
      set: {
        openCount: sql`min(${messageOpens.openCount} + 1, ${MAX_OPEN_COUNT})`,
        lastOpenedAt: sql`max(${messageOpens.lastOpenedAt}, ${at})`,
      },
    });
  return "recorded";
}

/**
 * Demo benzetimi (saf): bu ileti "açıldı" sayılır mı ve gönderimden kaç dakika sonra? `sha256(messageId)` ile
 * deterministik: ~%40 açılır, gecikme 5–240 dakika.
 */
export function demoOpenDecision(messageId: number): { opened: boolean; delayMin: number } {
  const h = crypto.createHash("sha256").update(String(messageId)).digest();
  const bucket = h.readUInt32BE(0) % 100;
  const delayMin = 5 + (h.readUInt32BE(4) % 236);
  return { opened: bucket < DEMO_OPEN_PERCENT, delayMin };
}

/**
 * Demo kampanya iletisi `sent` olduktan sonra çağrılır: izleme açıksa ve ileti benzetimde "açılanlardan"sa
 * `demo_simulated` açılmayı yazar. Tekrarlanabilir (aynı ileti için ikinci çağrı satırı değiştirmez).
 */
export async function simulateDemoOpen(
  db: DbExecutor,
  input: { messageId: number; campaignId: number; sentAt: number },
): Promise<boolean> {
  if (!(await openTrackingEnabled(db))) return false;
  const d = demoOpenDecision(input.messageId);
  if (!d.opened) return false;
  const at = input.sentAt + d.delayMin * 60_000;
  await db
    .insert(messageOpens)
    .values({
      messageId: input.messageId,
      campaignId: input.campaignId,
      firstOpenedAt: at,
      lastOpenedAt: at,
      openCount: 1,
      source: "demo_simulated",
    })
    .onConflictDoNothing({ target: messageOpens.messageId });
  return true;
}

/** Süreç içi basit hız sınırı: dakikada en çok 120 piksel kaydı (taşkın veritabanına yazma üretmez). */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
let rateStart = 0;
let rateCount = 0;
export function pixelRateLimited(now = Date.now()): boolean {
  if (now - rateStart >= RATE_WINDOW_MS) {
    rateStart = now;
    rateCount = 0;
  }
  return ++rateCount > RATE_MAX;
}
export function resetPixelRateLimitForTests(): void {
  rateStart = 0;
  rateCount = 0;
}
