import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config/paths";

/**
 * Gizli bilgi deposu (API anahtarları). SQLite'a düz metin YAZILMAZ (SRS FR-SET-03).
 *
 * Şifreleme: AES-256-GCM. Ana anahtar (master key):
 *  - Electron'da: ana süreç rastgele üretir, işletim sistemi anahtarlığıyla (safeStorage) korur ve
 *    alt süreçlere `UM_MASTER_KEY` ortam değişkeniyle iletir. Bu durumda `UM_REQUIRE_MASTER_KEY=1`
 *    ayarlıdır ve anahtar yoksa depo açılmaz.
 *  - Geliştirmede: `.data/master.key` dosyası (yalnızca sahibi okur). Üretimde kullanılmaz.
 */

export const SECRET_NAMES = ["google.placesKey", "google.mapsKey", "hunter.apiKey"] as const;
/**
 * Gmail OAuth istemci sırrı (Aşama 15.2). Genel `/api/secrets` ucunun listesinde (SECRET_NAMES) DEĞİLDİR: yalnızca
 * posta kutusu servisi yazar; maskeli değer bile döndürülmez, ortam değişkeninden de okunmaz.
 */
export const OAUTH_CLIENT_SECRET = "gmail.oauthClientSecret" as const;
/** Posta kutusu başına yenileme belirteci adı (Aşama 15.3'te yazılır); değer SQLite'a ASLA yazılmaz. */
export type MailboxSecretName = `gmail.refreshToken.${number}`;
const MAILBOX_SECRET_RE = /^gmail\.refreshToken\.[1-9]\d{0,8}$/;
/**
 * Abonelikten çıkış belirteci imza anahtarı (Aşama 15.6): anahtar kimliği başına Ed25519 ÖZEL anahtarı (PKCS8, base64url).
 * Genel `/api/secrets` listesinde DEĞİLDİR; yalnızca abonelikten çıkış anahtar servisi yazar/okur.
 */
export type UnsubscribeKeySecretName =
  `unsubscribe.signingKey.${string}` | `unsubscribe.channelKey.${string}`;
const UNSUB_SECRET_RE = /^unsubscribe\.(signingKey|channelKey)\.[0-9a-f]{16}$/;
export type SecretName =
  | (typeof SECRET_NAMES)[number]
  | typeof OAUTH_CLIENT_SECRET
  | MailboxSecretName
  | UnsubscribeKeySecretName;

/** Aktarıcı kanalı (olay çekme/onay) istek imza anahtarı (Aşama 15.7): Ed25519 ÖZEL anahtarı, uygulamada kalır. */
export function channelKeySecretName(kid: string): UnsubscribeKeySecretName {
  if (!/^[0-9a-f]{16}$/.test(kid)) throw new Error("Geçersiz anahtar kimliği.");
  return `unsubscribe.channelKey.${kid}`;
}

export function unsubscribeKeySecretName(kid: string): UnsubscribeKeySecretName {
  if (!/^[0-9a-f]{16}$/.test(kid)) throw new Error("Geçersiz anahtar kimliği.");
  return `unsubscribe.signingKey.${kid}`;
}

export function mailboxRefreshTokenName(mailboxId: number): MailboxSecretName {
  if (!Number.isInteger(mailboxId) || mailboxId < 1 || mailboxId > 999_999_999) {
    throw new Error("Geçersiz posta kutusu kimliği.");
  }
  return `gmail.refreshToken.${mailboxId}`;
}

function assertKnownName(name: string): void {
  if (
    (SECRET_NAMES as readonly string[]).includes(name) ||
    name === OAUTH_CLIENT_SECRET ||
    MAILBOX_SECRET_RE.test(name) ||
    UNSUB_SECRET_RE.test(name)
  ) {
    return;
  }
  throw new Error("Bilinmeyen gizli bilgi adı.");
}

function envNames(name: SecretName): string[] {
  return name in ENV_FALLBACKS ? ENV_FALLBACKS[name as keyof typeof ENV_FALLBACKS] : [];
}

const ENV_FALLBACKS: Record<(typeof SECRET_NAMES)[number], string[]> = {
  "google.placesKey": ["GOOGLE_PLACES_API_KEY"],
  "google.mapsKey": ["GOOGLE_MAPS_BROWSER_KEY", "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY"],
  "hunter.apiKey": ["HUNTER_API_KEY"],
};

interface SecretFile {
  v: 1;
  items: Record<string, { iv: string; tag: string; data: string }>;
}

function secretsPath(): string {
  return path.join(dataDir(), "secrets.json");
}

let warnedDevKey = false;

export function resolveMasterKey(): Buffer {
  const fromEnv = process.env.UM_MASTER_KEY;
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv))
      throw new Error("UM_MASTER_KEY 64 karakterlik onaltılık (hex) olmalıdır.");
    return Buffer.from(fromEnv, "hex");
  }
  if (process.env.UM_REQUIRE_MASTER_KEY === "1") {
    throw new Error("Ana anahtar (UM_MASTER_KEY) bulunamadı; gizli bilgi deposu açılamıyor.");
  }
  const file = path.join(dataDir(), "master.key");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn(
      "[secrets] Geliştirme modu: ana anahtar .data/master.key dosyasında. Üretimde işletim sistemi anahtarlığı kullanılır.",
    );
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

/** Okuma yolları için: dosya yok veya okunamıyorsa boş depo (değer yok sayılır, kullanıcıdan yeniden istenir). */
function readFile(): SecretFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath(), "utf8")) as SecretFile;
    return parsed.v === 1 ? parsed : { v: 1, items: {} };
  } catch {
    return { v: 1, items: {} };
  }
}

/**
 * Yazma (oku-değiştir-yaz) yolları için: YALNIZCA dosya yoksa boş depo. Dosya okunamıyor/ayrıştırılamıyorsa veya biçimi
 * tanınmıyorsa ÜZERİNE YAZILMAZ (aksi hâlde tek bir yazma bütün yenileme belirteçlerini ve geri getirilemeyen imza
 * anahtarlarını silerdi): dosya `secrets.json.corrupt-<zaman>` adıyla yedeklenir ve hata fırlatılır.
 */
function readFileForWrite(): SecretFile {
  const target = secretsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { v: 1, items: {} };
    throw new Error("Gizli bilgi deposu okunamadı; dosyaya dokunulmadı.");
  }
  try {
    const parsed = JSON.parse(raw) as SecretFile;
    if (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.items === "object" &&
      parsed.items !== null &&
      !Array.isArray(parsed.items)
    ) {
      return parsed;
    }
  } catch {
    /* aşağıda yedeklenir */
  }
  try {
    const backup = `${target}.corrupt-${Date.now()}`;
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  } catch {
    /* yedek alınamasa da asıl dosyanın üzerine yazılmaz */
  }
  throw new Error("Gizli bilgi deposu okunamadı; dosya yedeklendi.");
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Süreçler arası kilit (web sunucusu ve arka plan işçisi aynı dosyayı yazar): `O_EXCL` kilit dosyası; çökmüş bir
 * sürecin bıraktığı kilit `LOCK_STALE_MS` sonra bayat sayılır. Oku-değiştir-yaz zaman uyumludur, kilit kısa tutulur.
 */
function withFileLock<T>(fn: () => T): T {
  const lock = `${secretsPath()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // kilit bu arada kalktı
      }
      if (Date.now() > deadline) throw new Error("Gizli bilgi deposu meşgul; tekrar deneyin.");
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function writeFile(file: SecretFile): void {
  const target = secretsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(file));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function encrypt(name: string, plain: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(
  name: string,
  item: { iv: string; tag: string; data: string },
  key: Buffer,
): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(item.iv, "base64"));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(item.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(item.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  assertKnownName(name);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Boş değer kaydedilemez.");
  const item = encrypt(name, trimmed, resolveMasterKey());
  withFileLock(() => {
    const file = readFileForWrite();
    file.items[name] = item;
    writeFile(file);
  });
}

export async function deleteSecret(name: SecretName): Promise<void> {
  assertKnownName(name);
  withFileLock(() => {
    const file = readFileForWrite();
    if (!(name in file.items)) return;
    delete file.items[name];
    writeFile(file);
  });
}

export async function getSecret(name: SecretName): Promise<string | undefined> {
  const item = readFile().items[name];
  if (item) {
    try {
      return decrypt(name, item, resolveMasterKey());
    } catch {
      // Ana anahtar değişmiş veya dosya bozulmuş: değeri yok say, kullanıcıdan yeniden girmesi istenir.
    }
  }
  for (const envName of envNames(name)) {
    const v = process.env[envName]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Değer döndürmeden, çözülebilir bir kayıt var mı? (Maskeli değer bile sızdırılmaz.) */
export async function secretExists(name: SecretName): Promise<boolean> {
  assertKnownName(name);
  const item = readFile().items[name];
  if (!item) return false;
  try {
    decrypt(name, item, resolveMasterKey());
    return true;
  } catch {
    return false;
  }
}

export interface SecretStatus {
  set: boolean;
  source: "store" | "env" | null;
  masked: string | null;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export async function secretStatus(name: SecretName): Promise<SecretStatus> {
  const item = readFile().items[name];
  if (item) {
    try {
      return {
        set: true,
        source: "store",
        masked: maskSecret(decrypt(name, item, resolveMasterKey())),
      };
    } catch {
      /* aşağıda ortam değişkenine bakılır */
    }
  }
  for (const envName of envNames(name)) {
    const v = process.env[envName]?.trim();
    if (v) return { set: true, source: "env", masked: maskSecret(v) };
  }
  return { set: false, source: null, masked: null };
}
