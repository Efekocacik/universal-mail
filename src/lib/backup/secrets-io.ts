import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config/paths";
import {
  BACKUP_PASSPHRASE_SECRET,
  OAUTH_CLIENT_SECRET,
  resolveMasterKey,
  SECRET_NAMES,
} from "@/lib/secrets/store";

/**
 * Faz 6 (paket Y): yedeğe gizli bilgi aktarımı. Depo dosyası ana anahtarla şifrelidir ve başka makinede açılamaz; bu
 * yüzden yedek, değerleri ÇÖZÜLMÜŞ olarak kendi parolalı yükünde taşır ve geri yüklemede geçerli ana anahtarla yeniden
 * şifreler. Biçim `src/lib/secrets/store.ts` ile aynıdır (AES-256-GCM, AAD = ad); depo dosyası dondurulmuş olduğundan
 * yalnızca okuma/yazma biçimi burada tekrarlanır. Değerler ASLA günlüğe yazılmaz.
 */

const MAILBOX_RE = /^gmail\.refreshToken\.[1-9]\d{0,8}$/;
const UNSUB_RE = /^unsubscribe\.(signingKey|channelKey)\.[0-9a-f]{16}$/;

/** Depodaki bilinen gizli bilgi adı mı (store.ts `assertKnownName` ile aynı küme)? */
export function isKnownSecretName(name: string): boolean {
  return (
    (SECRET_NAMES as readonly string[]).includes(name) ||
    name === OAUTH_CLIENT_SECRET ||
    name === BACKUP_PASSPHRASE_SECRET ||
    MAILBOX_RE.test(name) ||
    UNSUB_RE.test(name)
  );
}

interface StoreItem {
  iv: string;
  tag: string;
  data: string;
}
interface StoreFile {
  v: 1;
  items: Record<string, StoreItem>;
}

export const secretsFilePath = (dir: string = dataDir()) => path.join(dir, "secrets.json");

function decryptItem(name: string, item: StoreItem, key: Buffer): string {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(item.iv, "base64"));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(Buffer.from(item.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(item.data, "base64")), d.final()]).toString("utf8");
}

function encryptItem(name: string, plain: string, key: Buffer): StoreItem {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(name));
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return {
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/**
 * Geçerli ana anahtarla çözülebilen bütün bilinen gizli bilgiler (yedek parolası HARİÇ: geri yüklemede kullanıcının
 * yazdığı parola konur). Çözülemeyen veya bilinmeyen kayıtlar atlanır ve sayılır.
 */
export function exportSecrets(dir: string = dataDir()): {
  secrets: Record<string, string>;
  skipped: number;
} {
  let file: StoreFile;
  try {
    file = JSON.parse(fs.readFileSync(secretsFilePath(dir), "utf8")) as StoreFile;
  } catch {
    return { secrets: {}, skipped: 0 };
  }
  if (!file || file.v !== 1 || typeof file.items !== "object" || file.items === null)
    return { secrets: {}, skipped: 0 };
  const names = Object.keys(file.items).filter((n) => n !== BACKUP_PASSPHRASE_SECRET);
  let key: Buffer;
  try {
    key = resolveMasterKey();
  } catch {
    return { secrets: {}, skipped: names.length };
  }
  const secrets: Record<string, string> = {};
  let skipped = 0;
  for (const name of names) {
    if (!isKnownSecretName(name)) {
      skipped++;
      continue;
    }
    try {
      secrets[name] = decryptItem(name, file.items[name]!, key);
    } catch {
      skipped++;
    }
  }
  return { secrets, skipped };
}

/**
 * Depo biçiminde yeni bir dosya yazar (geçerli ana anahtarla). Bilinmeyen adlar ve boş değerler atlanır. Atomik:
 * geçici dosya + fsync + yeniden adlandırma; izin 0600.
 */
export function writeSecretsFile(target: string, values: Record<string, string>): number {
  const key = resolveMasterKey();
  const out: StoreFile = { v: 1, items: {} };
  for (const [name, value] of Object.entries(values)) {
    const v = value.trim();
    if (!isKnownSecretName(name) || !v) continue;
    out.items[name] = encryptItem(name, v, key);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(out));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return Object.keys(out.items).length;
}
