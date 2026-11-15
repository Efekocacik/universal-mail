import type { PublicKeyEntry } from "@/lib/unsubscribe/token-core";
import { kidOfPublicKeyWeb } from "@/lib/unsubscribe/web-crypto";

/**
 * Aktarıcı anahtar kümesi (`relay-keys.json`) doğrulaması — çalışma ortamından BAĞIMSIZ çekirdek. Dosyadan okuyan
 * VPS aktarıcısı (./key-file, `node:fs`) ile Worker gizli değişkeninden okuyan Cloudflare aktarıcısı (./worker) AYNI
 * kuralları kullanır. Biçim ve kurallar için bkz. ./key-file.
 */

const KID_RE = /^[0-9a-f]{16}$/;
const X_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ENTRIES = 50;
export const MAX_KEY_FILE_BYTES = 64 * 1024;

export type KeyFileErrorCode =
  | "missing"
  | "too_large"
  | "bad_json"
  | "bad_version"
  | "origin_mismatch"
  | "bad_entry"
  | "kid_mismatch"
  | "duplicate_kid"
  | "too_many"
  | "unavailable";

export class KeyFileError extends Error {
  constructor(readonly code: KeyFileErrorCode) {
    super(code);
    this.name = "KeyFileError";
  }
}

export interface RelayKeySet {
  origin: string;
  tokenKeys: PublicKeyEntry[];
  channelKeys: PublicKeyEntry[];
  generatedAt: number | null;
}

/** `https://ana.makine[:port]` biçimli köken; yol `/` dışında, sorgu, parça veya kimlik bilgisi içeremez. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

/** Eşzamanlı anahtar kimliği hesaplayıcısı (Node: `kidOfPublicKey`; Worker: önceden hesaplanmış tablo). */
export type KidOf = (x: string) => string;

function parseEntries(v: unknown, kidOf: KidOf): PublicKeyEntry[] {
  if (!Array.isArray(v)) throw new KeyFileError("bad_entry");
  if (v.length > MAX_ENTRIES) throw new KeyFileError("too_many");
  const out: PublicKeyEntry[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new KeyFileError("bad_entry");
    const { kid, x } = e as Record<string, unknown>;
    if (typeof kid !== "string" || typeof x !== "string" || !KID_RE.test(kid) || !X_RE.test(x)) {
      throw new KeyFileError("bad_entry");
    }
    if (kidOf(x) !== kid) throw new KeyFileError("kid_mismatch");
    if (seen.has(kid)) throw new KeyFileError("duplicate_kid");
    seen.add(kid);
    out.push({ kid, x });
  }
  return out;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

/**
 * Anahtar dosyası metnini doğrular; geçersizse `KeyFileError`. `expectedOrigin` normalleştirilmiş köken olmalı.
 * Bir hatalı giriş BÜTÜN dosyayı geçersiz kılar.
 */
export function parseKeySet(raw: string, expectedOrigin: string, kidOf: KidOf): RelayKeySet {
  if (utf8Length(raw) > MAX_KEY_FILE_BYTES) throw new KeyFileError("too_large");
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new KeyFileError("bad_json");
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new KeyFileError("bad_json");
  const f = o as Record<string, unknown>;
  if (f.v !== 1) throw new KeyFileError("bad_version");
  const origin = typeof f.origin === "string" ? normalizeOrigin(f.origin) : null;
  if (!origin || origin !== expectedOrigin) throw new KeyFileError("origin_mismatch");
  const generatedAt =
    typeof f.generatedAt === "number" && Number.isSafeInteger(f.generatedAt) && f.generatedAt > 0
      ? f.generatedAt
      : null;
  return {
    origin,
    tokenKeys: parseEntries(f.tokenKeys, kidOf),
    channelKeys: parseEntries(f.channelKeys, kidOf),
    generatedAt,
  };
}

/**
 * WebCrypto ile (eşzamansız SHA-256) doğrulama: önce dosyadaki biçimce geçerli her `x` için kimlik hesaplanır, sonra
 * AYNI eşzamanlı kurallar (`parseKeySet`) uygulanır; hata kodları ve öncelikleri Node sürümüyle birebir aynıdır.
 */
export async function parseKeySetWeb(raw: string, expectedOrigin: string): Promise<RelayKeySet> {
  const kids = new Map<string, string>();
  if (utf8Length(raw) <= MAX_KEY_FILE_BYTES) {
    let o: unknown = null;
    try {
      o = JSON.parse(raw);
    } catch {
      /* parseKeySet bad_json verir */
    }
    const f = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    for (const list of [f.tokenKeys, f.channelKeys]) {
      if (!Array.isArray(list)) continue;
      for (const e of list.slice(0, MAX_ENTRIES)) {
        const x = (e as { x?: unknown } | null)?.x;
        if (typeof x === "string" && X_RE.test(x) && !kids.has(x)) {
          kids.set(x, await kidOfPublicKeyWeb(x));
        }
      }
    }
  }
  return parseKeySet(raw, expectedOrigin, (x) => kids.get(x) ?? "");
}
