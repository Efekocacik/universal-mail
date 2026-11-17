import crypto from "node:crypto";
import { z } from "zod";
import type { DbExecutor } from "@/lib/db/client";
import { resolveMasterKey } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * "Kendime test gönder" için SUNUCU TARAFINDA doğrulanan onay belirteci (canlı kapsam).
 *
 * Akış: arayüz önce "challenge" ister; sunucu gönderimle AYNI ön koşulları denetler ve hiçbir ileti göndermeden imzalı,
 * kısa ömürlü bir belirteç verir. Arayüz alıcı adresini kullanıcıya gösterip onay alır ve belirteçle gönderimi ister.
 * Sunucu belirteci doğrular; gerçek e-posta ancak geçerli bir belirteçle gider.
 *
 * Belirteç şunlara BAĞLIDIR: posta kutusu, şablon, işletme (lead) ve kutunun alıcı adresi. Başka bir kutu/şablon/lead
 * için alınmış veya adresi değişmiş kutuya ait belirteç geçmez. Ömrü 120 sn'dir. TEK KULLANIMLIKTIR: nonce, test
 * iletisinin kaydıyla AYNI işlemde tüketilir; çift tıklama, tekrar oynatma veya eşzamanlı iki istek ikinci iletiyi
 * doğuramaz. İmza anahtarı, gizli depodaki ana anahtardan HKDF ile türetilir (diske ayrı yazılmaz).
 *
 * KAPSAM VE SINIR (açıkça): Bu mekanizma sahte, başka parametrelere ait, süresi dolmuş veya tekrarlanan istekleri ve
 * çift gönderimi engeller; onayı sunucu tarafında doğrulanabilir ve denetlenebilir yapar. İNSAN VARLIĞININ KESİN KANITI
 * DEĞİLDİR: aynı makinede çalışan ve önce "challenge"ı çağıran bir yerel süreci insandan ayırmaz. Test gönderiminin
 * etkisi sınırlıdır (yalnızca kutunun kendi adresi, saatte ve günde 10). Daha güçlü insan onayı (Electron yerel
 * pencere) canlı yetkilendirme tasarımındadır (docs/14).
 */

export const CONFIRM_TTL_MS = 120_000;
/** Süre sonu "şimdi + TTL" değerinden bu kadar fazla ileride olamaz (saat sapması payı dahil). */
const MAX_FUTURE_MS = CONFIRM_TTL_MS + 5_000;
/** Tüketilmiş nonce kaydı, süre sonundan bu kadar sonra budanır (belirteç zaten süresi dolduğu için geçmez). */
const PURGE_GRACE_MS = 60_000;
const MAX_TOKEN_LENGTH = 1_000;
const INFO = Buffer.from("universal-mail/test-send-confirm/v1");

export interface ConfirmBinding {
  mailboxId: number;
  templateId: number;
  leadId: number;
  /** Kutunun kendi adresi (ayrıştırılmış, küçük harfli). */
  address: string;
}

export interface IssuedConfirm {
  token: string;
  expiresAt: number;
}

export type ConfirmCheck =
  { ok: true; nonce: string; expiresAt: number } | { ok: false; reason: "invalid" | "expired" };

const payloadSchema = z
  .object({
    v: z.literal(1),
    p: z.literal("test-send"),
    m: z.number().int().min(1),
    t: z.number().int().min(1),
    l: z.number().int().min(1),
    a: z.string().regex(/^[0-9a-f]{64}$/),
    n: z.string().regex(/^[0-9a-f]{32}$/),
    e: z.number().int(),
  })
  .strict();

function macKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", resolveMasterKey(), Buffer.alloc(0), INFO, 32));
}

function sign(payloadB64: string): Buffer {
  return crypto.createHmac("sha256", macKey()).update(payloadB64).digest();
}

function addressDigest(address: string): string {
  return crypto.createHash("sha256").update(address.trim().toLowerCase(), "utf8").digest("hex");
}

/** Yeni bir onay belirteci üretir. Sunucu yalnızca hazırlık ön koşulları geçtikten sonra çağırır. */
export function issueConfirmToken(
  binding: ConfirmBinding,
  now: number,
  random: (size: number) => Buffer = crypto.randomBytes,
): IssuedConfirm {
  const expiresAt = now + CONFIRM_TTL_MS;
  const payload = {
    v: 1 as const,
    p: "test-send" as const,
    m: binding.mailboxId,
    t: binding.templateId,
    l: binding.leadId,
    a: addressDigest(binding.address),
    n: random(16).toString("hex"),
    e: expiresAt,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = sign(payloadB64).toString("base64url");
  return { token: `${payloadB64}.${mac}`, expiresAt };
}

/**
 * Belirteci doğrular (saf; veritabanına dokunmaz): imza, biçim, bağlı parametreler, süre. Başarısızlık nedeni dışarıya
 * yalnızca "geçersiz" veya "süresi dolmuş" olarak verilir (imzanın neden tutmadığı sızdırılmaz).
 */
export function verifyConfirmToken(
  token: unknown,
  binding: ConfirmBinding,
  now: number,
): ConfirmCheck {
  const invalid: ConfirmCheck = { ok: false, reason: "invalid" };
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return invalid;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid;
  const [payloadB64, macB64] = parts as [string, string];

  const given = Buffer.from(macB64, "base64url");
  const expected = sign(payloadB64);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return invalid;

  let parsed: z.infer<typeof payloadSchema>;
  try {
    const result = payloadSchema.safeParse(
      JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")),
    );
    if (!result.success) return invalid;
    parsed = result.data;
  } catch {
    return invalid;
  }

  if (
    parsed.m !== binding.mailboxId ||
    parsed.t !== binding.templateId ||
    parsed.l !== binding.leadId ||
    parsed.a !== addressDigest(binding.address)
  ) {
    return invalid;
  }
  if (parsed.e - now > MAX_FUTURE_MS) return invalid;
  if (now > parsed.e) return { ok: false, reason: "expired" };
  return { ok: true, nonce: parsed.n, expiresAt: parsed.e };
}

/**
 * Nonce'u TÜKETİLMİŞ olarak kaydeder. Çağıran, test iletisinin kaydını yazan AYNI işlemin içinde çağırmalıdır: işlem
 * geri alınırsa nonce de geri alınır (belirteç, ileti oluşmadıkça yanmaz); işlem tamamlanırsa belirteç bir daha
 * kullanılamaz. Daha önce tüketilmişse `false` döner. Süresi dolmuş kayıtlar budanır.
 */
export async function consumeConfirmNonce(
  tx: DbExecutor,
  nonce: string,
  expiresAt: number,
  now: number,
): Promise<boolean> {
  const used = await getSetting(tx, "mail.testSendConfirms");
  if (Object.prototype.hasOwnProperty.call(used, nonce)) return false;
  const next: Record<string, number> = {};
  for (const [k, exp] of Object.entries(used)) if (exp + PURGE_GRACE_MS >= now) next[k] = exp;
  next[nonce] = expiresAt;
  await setSetting(tx, "mail.testSendConfirms", next);
  return true;
}
