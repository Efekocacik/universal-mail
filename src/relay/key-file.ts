import fs from "node:fs";
import { kidOfPublicKey, type PublicKeyEntry } from "@/lib/unsubscribe/token";

/**
 * Aktarıcı anahtar dosyası (Aşama 15.7, dağıtım; docs/09 K9). Uygulama tarafından üretilir ve sunucuya YALNIZCA SSH
 * ile kopyalanır. Biçim:
 *
 *   {"v":1,"origin":"https://cikis.firma.com","tokenKeys":[{"kid","x"}],"channelKeys":[{"kid","x"}],"generatedAt":ms}
 *
 * İçerik yalnızca GENEL anahtarlardır (gizli değildir), ama BÜTÜNLÜĞÜ güvenlik açısından önemlidir: kanal anahtar
 * listesini değiştirebilen biri kuyruktaki olayları çekip ONAYLAYABİLİR (silebilir). Bu yüzden dosya
 * `root:umrelay` sahipli ve 0640 olmalıdır (deploy/relay/README.md). Belirteç anahtarının değiştirilmesi zararsızdır:
 * uygulama her olayı kendi anahtarlarıyla yeniden doğrular.
 *
 * Doğrulama (dosyanın TAMAMI; tek bir bozuk giriş bütün dosyayı geçersiz kılar):
 *  - `v === 1`, `origin` aktarıcının `RELAY_PUBLIC_ORIGIN` değeriyle AYNI köken,
 *  - her giriş: kid `/^[0-9a-f]{16}$/`, x `/^[A-Za-z0-9_-]{43}$/` ve `kidOfPublicKey(x) === kid`,
 *  - kid tekrarı yok, liste başına en çok 50 giriş, dosya en çok 64 KiB.
 *
 * Sıcak yeniden yükleme: dosyanın değişiklik zamanı/boyutu en çok `minIntervalMs` (varsayılan 5 sn) aralıkla
 * denetlenir; değiştiyse yeniden okunur. Yeni dosya GEÇERSİZSE son geçerli küme korunur (ve günlüğe yalnızca hata
 * kodu yazılır). Hiç geçerli küme yoksa erişimciler İSTİSNA fırlatır → işleyiciler 503 döner.
 */

const KID_RE = /^[0-9a-f]{16}$/;
const X_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ENTRIES = 50;
export const MAX_KEY_FILE_BYTES = 64 * 1024;
export const KEY_FILE_RELOAD_MS = 5_000;

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

function parseEntries(v: unknown): PublicKeyEntry[] {
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
    if (kidOfPublicKey(x) !== kid) throw new KeyFileError("kid_mismatch");
    if (seen.has(kid)) throw new KeyFileError("duplicate_kid");
    seen.add(kid);
    out.push({ kid, x });
  }
  return out;
}

/** Anahtar dosyası metnini doğrular; geçersizse `KeyFileError`. `expectedOrigin` normalleştirilmiş köken olmalı. */
export function parseKeyFile(raw: string, expectedOrigin: string): RelayKeySet {
  if (Buffer.byteLength(raw, "utf8") > MAX_KEY_FILE_BYTES) throw new KeyFileError("too_large");
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
    tokenKeys: parseEntries(f.tokenKeys),
    channelKeys: parseEntries(f.channelKeys),
    generatedAt,
  };
}

export interface KeyFileLoaderOptions {
  path: string;
  /** `RELAY_PUBLIC_ORIGIN` (normalleştirilmiş). */
  origin: string;
  minIntervalMs?: number;
  now?: () => number;
  /** Tek satırlık olay günlüğü; içerik/anahtar ASLA yazılmaz, yalnızca kod. */
  log?: (line: string) => void;
}

/** Sıcak yeniden yüklenen, son geçerli kümeyi koruyan anahtar dosyası okuyucusu. */
export class KeyFileLoader {
  private current: RelayKeySet | null = null;
  private lastCheck = -Infinity;
  private stamp: string | null = null;
  private lastError: KeyFileErrorCode | null = null;
  private readonly interval: number;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: KeyFileLoaderOptions) {
    this.interval = o.minIntervalMs ?? KEY_FILE_RELOAD_MS;
    this.clock = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
  }

  /** Gerekirse dosyayı yeniden yükler (en çok `minIntervalMs` aralıkla); geçerli küme varsa döndürür. */
  refresh(force = false): RelayKeySet | null {
    const now = this.clock();
    if (!force && now - this.lastCheck < this.interval) return this.current;
    this.lastCheck = now;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.o.path);
    } catch {
      this.fail("missing");
      return this.current;
    }
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (stamp === this.stamp) return this.current;
    this.stamp = stamp;
    try {
      if (st.size > MAX_KEY_FILE_BYTES) throw new KeyFileError("too_large");
      const next = parseKeyFile(fs.readFileSync(this.o.path, "utf8"), this.o.origin);
      this.current = next;
      this.lastError = null;
      this.log(`keys loaded token=${next.tokenKeys.length} channel=${next.channelKeys.length}`);
    } catch (e) {
      this.fail(e instanceof KeyFileError ? e.code : "missing");
    }
    return this.current;
  }

  private fail(code: KeyFileErrorCode): void {
    if (this.lastError !== code) {
      this.log(`keys rejected code=${code}${this.current ? " (keeping last good set)" : ""}`);
    }
    this.lastError = code;
  }

  private require(): RelayKeySet {
    const set = this.refresh();
    if (!set) throw new KeyFileError("unavailable");
    return set;
  }

  /** Belirteç doğrulama anahtarları (`createRelayHandler.keys`); geçerli küme yoksa istisna. */
  tokenKeys(): PublicKeyEntry[] {
    return this.require().tokenKeys;
  }

  /** Kanal anahtarları (`createSpoolPullHandler.keys`); geçerli küme yoksa istisna. */
  channelKeys(): PublicKeyEntry[] {
    return this.require().channelKeys;
  }

  /** Sağlık denetimi için: en az bir belirteç ve bir kanal anahtarı yüklü mü (istisna fırlatmaz). */
  ready(): boolean {
    const set = this.refresh();
    return !!set && set.tokenKeys.length > 0 && set.channelKeys.length > 0;
  }
}
