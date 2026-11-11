import crypto from "node:crypto";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  channelKeySecretName,
  deleteSecret,
  getSecret,
  secretExists,
  setSecret,
} from "@/lib/secrets/store";
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

/**
 * Etkin kanal anahtarının ÖZEL anahtarı okunamıyor mu? (Kayıtta etkin anahtar var ama gizli depoda çözülebilir değeri
 * yok: tipik olarak "Gizli bilgileri sıfırla" sonrası.) Etkin anahtar yoksa false.
 */
export async function channelPrivateKeyMissing(db: DbExecutor): Promise<boolean> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (!cur) return false;
  return !(await secretExists(channelKeySecretName(cur.kid)));
}

/** Etkin kanal anahtarı yoksa VEYA özel anahtarı okunamıyorsa yenisini üretir. */
export async function ensureChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (cur && (await secretExists(channelKeySecretName(cur.kid)))) return { kid: cur.kid };
  return rotateChannelKey(db, now);
}

/**
 * Yeni kanal anahtarı etkin olur; önceki (iptal edilmemiş) kanal anahtarları İPTAL edilir ve özel anahtarları silinir.
 * Uygulama yalnızca etkin anahtarla imzaladığı için eski anahtarın aktarıcıda geçerli kalmasının meşru bir amacı yoktur;
 * yeni anahtar dosyası yüklenince eski anahtar sunucuda da tanınmaz (sızmış bir eski anahtarla olay çekilemez/silinemez).
 * İmza anahtarlarından farkı: kanal anahtarı gönderilmiş iletilerde yer almaz, emekli tutmak gerekmez.
 */
export async function rotateChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = kidOfPublicKey(x);
  await setSecret(
    channelKeySecretName(kid),
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  );
  const old = reg.keys.filter((k) => k.revokedAt === null);
  await setSetting(db, "mail.unsubscribeChannel", {
    current: kid,
    keys: [
      ...reg.keys.map((k) => (k.revokedAt === null ? { ...k, revokedAt: now } : k)),
      { kid, x, createdAt: now, revokedAt: null },
    ],
  });
  for (const k of old) {
    await deleteSecret(channelKeySecretName(k.kid));
    await audit(
      db,
      "unsubscribe.channel_key_revoked",
      "unsubscribe_channel_key",
      k.kid,
      { reason: "rotated" },
      now,
    );
  }
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

/** Aktarıcıya verilecek GENEL kanal anahtarları (iptal edilenler hariç; döndürmeden sonra yalnızca etkin anahtar). */
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
