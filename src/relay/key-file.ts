import fs from "node:fs";
import { kidOfPublicKey, type PublicKeyEntry } from "@/lib/unsubscribe/token";
import {
  KeyFileError,
  MAX_KEY_FILE_BYTES,
  parseKeySet,
  type KeyFileErrorCode,
  type RelayKeySet,
} from "./key-set";

export {
  KeyFileError,
  MAX_KEY_FILE_BYTES,
  normalizeOrigin,
  type KeyFileErrorCode,
  type RelayKeySet,
} from "./key-set";

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
 * Doğrulama (dosyanın TAMAMI; tek bir bozuk giriş bütün dosyayı geçersiz kılar; çekirdek ./key-set, Cloudflare Worker
 * aktarıcısı da aynısını kullanır):
 *  - `v === 1`, `origin` aktarıcının `RELAY_PUBLIC_ORIGIN` değeriyle AYNI köken,
 *  - her giriş: kid `/^[0-9a-f]{16}$/`, x `/^[A-Za-z0-9_-]{43}$/` ve `kidOfPublicKey(x) === kid`,
 *  - kid tekrarı yok, liste başına en çok 50 giriş, dosya en çok 64 KiB.
 *
 * Sıcak yeniden yükleme: dosyanın değişiklik zamanı/boyutu en çok `minIntervalMs` (varsayılan 5 sn) aralıkla
 * denetlenir; değiştiyse yeniden okunur. Yeni dosya GEÇERSİZSE son geçerli küme korunur (ve günlüğe yalnızca hata
 * kodu yazılır). Hiç geçerli küme yoksa erişimciler İSTİSNA fırlatır → işleyiciler 503 döner.
 */

export const KEY_FILE_RELOAD_MS = 5_000;

/** Anahtar dosyası metnini doğrular; geçersizse `KeyFileError`. `expectedOrigin` normalleştirilmiş köken olmalı. */
export function parseKeyFile(raw: string, expectedOrigin: string): RelayKeySet {
  return parseKeySet(raw, expectedOrigin, kidOfPublicKey);
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
