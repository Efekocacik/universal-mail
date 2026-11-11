import crypto from "node:crypto";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { channelKeySecretName, deleteSecret, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { kidOfPublicKey, type PublicKeyEntry } from "./token";

/**
 * Aktarıcı ↔ uygulama KANALI (Aşama 15.7; docs/09 K9): uygulama tarafı kanal anahtarı yönetimi.
 *
 * Saf protokol (imza, aktarıcı tarafı çekme/onay uçları, HTTP olay kaynağı) `./channel-protocol` içindedir ve
 * buradan aynen yeniden dışa aktarılır; mevcut içe aktarımlar ve davranış DEĞİŞMEZ.
 */

export {
  CHANNEL_SKEW_MS,
  ChannelError,
  HttpEventSource,
  channelSigningInput,
  createSpoolPullHandler,
  signChannelRequest,
  verifyChannelRequest,
  type HttpEventSourceOptions,
  type PullHandlerOptions,
  type SpoolPort,
} from "./channel-protocol";

/* ---------------------------------------------------------------------------------------------- */
/* Kanal anahtarları (uygulama)                                                                    */

export async function ensureChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (cur) return { kid: cur.kid };
  return rotateChannelKey(db, now);
}

/** Yeni kanal anahtarı etkin olur; eskisi iptal edilene kadar aktarıcıda geçerli kalabilir (kesintisiz döndürme). */
export async function rotateChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = kidOfPublicKey(x);
  await setSecret(
    channelKeySecretName(kid),
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  );
  await setSetting(db, "mail.unsubscribeChannel", {
    current: kid,
    keys: [...reg.keys, { kid, x, createdAt: now, revokedAt: null }],
  });
  await audit(
    db,
    "unsubscribe.channel_key_created",
    "unsubscribe_channel_key",
    kid,
    undefined,
    now,
  );
  return { kid };
}

export async function revokeChannelKey(db: Db, kid: string, now = Date.now()): Promise<boolean> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  if (!reg.keys.some((k) => k.kid === kid && k.revokedAt === null)) return false;
  await setSetting(db, "mail.unsubscribeChannel", {
    current: reg.current === kid ? null : reg.current,
    keys: reg.keys.map((k) => (k.kid === kid ? { ...k, revokedAt: now } : k)),
  });
  await deleteSecret(channelKeySecretName(kid));
  await audit(
    db,
    "unsubscribe.channel_key_revoked",
    "unsubscribe_channel_key",
    kid,
    undefined,
    now,
  );
  return true;
}

/** Aktarıcıya verilecek GENEL kanal anahtarları (iptal edilenler hariç). */
export async function exportChannelPublicKeys(db: Db): Promise<PublicKeyEntry[]> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  return reg.keys.filter((k) => k.revokedAt === null).map((k) => ({ kid: k.kid, x: k.x }));
}

/** Etkin kanal anahtarıyla imzalayıcı; yoksa null. */
export async function getChannelSigner(
  db: Db,
): Promise<{ kid: string; privateKey: crypto.KeyObject } | null> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (!cur) return null;
  const pkcs8 = await getSecret(channelKeySecretName(cur.kid));
  if (!pkcs8) return null;
  return {
    kid: cur.kid,
    privateKey: crypto.createPrivateKey({
      key: Buffer.from(pkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
  };
}
