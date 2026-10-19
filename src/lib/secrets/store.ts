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
export type SecretName = (typeof SECRET_NAMES)[number];

const ENV_FALLBACKS: Record<SecretName, string[]> = {
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

function readFile(): SecretFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath(), "utf8")) as SecretFile;
    return parsed.v === 1 ? parsed : { v: 1, items: {} };
  } catch {
    return { v: 1, items: {} };
  }
}

function writeFile(file: SecretFile): void {
  const target = secretsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
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
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Boş değer kaydedilemez.");
  const file = readFile();
  file.items[name] = encrypt(name, trimmed, resolveMasterKey());
  writeFile(file);
}

export async function deleteSecret(name: SecretName): Promise<void> {
  const file = readFile();
  delete file.items[name];
  writeFile(file);
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
  for (const envName of ENV_FALLBACKS[name]) {
    const v = process.env[envName]?.trim();
    if (v) return v;
  }
  return undefined;
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
  for (const envName of ENV_FALLBACKS[name]) {
    const v = process.env[envName]?.trim();
    if (v) return { set: true, source: "env", masked: maskSecret(v) };
  }
  return { set: false, source: null, masked: null };
}
