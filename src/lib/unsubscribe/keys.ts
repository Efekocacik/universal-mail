import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaignLeads } from "@/lib/db/schema";
import {
  deleteSecret,
  getSecret,
  resolveMasterKey,
  setSecret,
  unsubscribeKeySecretName,
} from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { kidOfPublicKey, newClaims, signToken, type PublicKeyEntry } from "./token";

/**
 * Abonelikten çıkış imza anahtarları ve belirteç üretimi (Aşama 15.6) — uygulama tarafı.
 *
 *  - Özel anahtar YALNIZCA şifreli gizli depoda durur (`unsubscribe.signingKey.<kid>`); SQLite'a, günlüğe, denetim
 *    kaydına veya yanıtlara yazılmaz. Ayar kaydı yalnızca GENEL anahtarları ve durumu tutar.
 *  - Aktarıcıya yalnızca GENEL anahtar kümesi verilir (`exportRelayKeySet`).
 *  - Döndürme: yeni anahtar etkin olur, eskisi "emekli" kalır (eski belirteçler süreleri dolana kadar doğrulanır).
 *    İptal: anahtar doğrulama kümesinden çıkar ve özel anahtar silinir (sızıntı durumu; o anahtarın belirteçleri ölür).
 *  - Alıcı etiketi: uygulama ana anahtarından türetilen gizli anahtarla HMAC; adres özetinden tahmin edilemez.
 */

const TAG_INFO = "um-unsubscribe-recipient-tag-v1";

export interface KeyRegistryEntry {
  kid: string;
  x: string;
  createdAt: number;
  retiredAt: number | null;
  revokedAt: number | null;
}

function recipientTagKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", resolveMasterKey(), Buffer.alloc(0), TAG_INFO, 32));
}

/** Alıcı etiketi (22 karakter, base64url). `recipientHash`: kampanya alıcısının adres özeti. */
export function recipientTag(recipientHash: string): string {
  return crypto
    .createHmac("sha256", recipientTagKey())
    .update(recipientHash)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function tagsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function generate(db: Db, now: number): Promise<KeyRegistryEntry> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = kidOfPublicKey(x);
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  await setSecret(unsubscribeKeySecretName(kid), pkcs8);
  return { kid, x, createdAt: now, retiredAt: null, revokedAt: null };
}

/** Etkin anahtar yoksa üretir. Gizli depo yazılamazsa kayıt OLUŞTURULMAZ (önce özel anahtar, sonra ayar). */
export async function ensureSigningKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeKeys");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (cur) return { kid: cur.kid };
  const entry = await generate(db, now);
  await setSetting(db, "mail.unsubscribeKeys", {
    current: entry.kid,
    keys: [...reg.keys, entry],
  });
  await audit(db, "unsubscribe.key_created", "unsubscribe_key", entry.kid, undefined, now);
  return { kid: entry.kid };
}

/** Yeni anahtar etkin olur; önceki emekli kalır ve süresi dolana kadar doğrulanır. */
export async function rotateSigningKey(
  db: Db,
  now = Date.now(),
): Promise<{ kid: string; previous: string | null }> {
  const reg = await getSetting(db, "mail.unsubscribeKeys");
  const entry = await generate(db, now);
  const keys = reg.keys.map((k) =>
    k.kid === reg.current && k.retiredAt === null ? { ...k, retiredAt: now } : k,
  );
  await setSetting(db, "mail.unsubscribeKeys", { current: entry.kid, keys: [...keys, entry] });
  await audit(
    db,
    "unsubscribe.key_rotated",
    "unsubscribe_key",
    entry.kid,
    { previous: reg.current },
    now,
  );
  return { kid: entry.kid, previous: reg.current };
}

/** Sızıntı: anahtar doğrulama kümesinden çıkar, özel anahtar silinir. Etkin anahtar iptal edilirse etkin anahtar kalmaz. */
export async function revokeSigningKey(db: Db, kid: string, now = Date.now()): Promise<boolean> {
  const reg = await getSetting(db, "mail.unsubscribeKeys");
  const target = reg.keys.find((k) => k.kid === kid && k.revokedAt === null);
  if (!target) return false;
  await setSetting(db, "mail.unsubscribeKeys", {
    current: reg.current === kid ? null : reg.current,
    keys: reg.keys.map((k) => (k.kid === kid ? { ...k, revokedAt: now } : k)),
  });
  await deleteSecret(unsubscribeKeySecretName(kid));
  await audit(db, "unsubscribe.key_revoked", "unsubscribe_key", kid, undefined, now);
  return true;
}

/** Doğrulama için kullanılacak genel anahtarlar (etkin + emekli; iptal edilenler HARİÇ). */
export async function loadPublicKeys(db: Db): Promise<PublicKeyEntry[]> {
  const reg = await getSetting(db, "mail.unsubscribeKeys");
  return reg.keys.filter((k) => k.revokedAt === null).map((k) => ({ kid: k.kid, x: k.x }));
}

/** Aktarıcıya verilecek GENEL anahtar kümesi (özel anahtar veya gizli bilgi içermez). */
export async function exportRelayKeySet(
  db: Db,
): Promise<{ v: 1; keys: { kid: string; x: string }[] }> {
  return { v: 1, keys: await loadPublicKeys(db) };
}

export class MintError extends Error {
  constructor(
    readonly code: "lead_not_found" | "no_recipient" | "no_key",
    message: string,
  ) {
    super(message);
    this.name = "MintError";
  }
}

/** Etkin imza anahtarı (kimlik + özel anahtar); yoksa `no_key`. */
export async function getSigner(
  db: DbExecutor,
): Promise<{ kid: string; privateKey: crypto.KeyObject }> {
  const reg = await getSetting(db, "mail.unsubscribeKeys");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (!cur) throw new MintError("no_key", "Etkin imza anahtarı yok.");
  const pkcs8 = await getSecret(unsubscribeKeySecretName(cur.kid));
  if (!pkcs8) throw new MintError("no_key", "İmza anahtarı okunamadı.");
  return {
    kid: cur.kid,
    privateKey: crypto.createPrivateKey({
      key: Buffer.from(pkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
  };
}

/**
 * Bir kampanya alıcısı için imzalı çıkış belirteci üretir. Etkin anahtar yoksa OLUŞTURMAZ (`no_key`): anahtar üretimi
 * bilinçli bir adımdır (`ensureSigningKey`). Silinmiş (anonimleştirilmiş) alıcı için belirteç üretilmez.
 */
export async function mintUnsubscribeToken(
  db: DbExecutor,
  input: { campaignLeadId: number; messageId?: number | null; now?: number; ttlMs?: number },
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const [cl] = await db
    .select({ hash: campaignLeads.recipientHash, email: campaignLeads.recipientEmail })
    .from(campaignLeads)
    .where(eq(campaignLeads.id, input.campaignLeadId))
    .limit(1);
  if (!cl) throw new MintError("lead_not_found", "Kampanya alıcısı bulunamadı.");
  if (!cl.hash || !cl.email) throw new MintError("no_recipient", "Alıcı adresi yok (silinmiş).");

  const signer = await getSigner(db);
  const claims = newClaims({
    kid: signer.kid,
    campaignLeadId: input.campaignLeadId,
    messageId: input.messageId ?? null,
    recipientTag: recipientTag(cl.hash),
    now,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
  return { token: signToken(claims, signer.privateKey), jti: claims.j, expiresAt: claims.e * 1000 };
}

/** Uç nokta SINAMA belirteci (kapsam "p"): hiçbir alıcıya bağlı değildir ve hiçbir suppression üretmez. Süre 15 dk. */
export async function mintProbeToken(
  db: DbExecutor,
  now = Date.now(),
): Promise<{ token: string; jti: string; kid: string }> {
  const signer = await getSigner(db);
  const claims = newClaims({
    kid: signer.kid,
    campaignLeadId: 1,
    recipientTag: recipientTag("um-endpoint-probe"),
    now,
    ttlMs: 15 * 60_000,
    scope: "p",
  });
  return { token: signToken(claims, signer.privateKey), jti: claims.j, kid: signer.kid };
}

/** Bağlantı biçimi: `https://<alan>/u/<belirteç>`; yalnızca güvenli HTTPS tabanı kabul edilir. */
export function buildUnsubscribeUrl(base: string, token: string): string {
  const u = new URL(base);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  ) {
    throw new Error("Güvenli bir HTTPS taban adresi (yol olmadan) gerekir.");
  }
  return `${u.origin}/u/${token}`;
}
