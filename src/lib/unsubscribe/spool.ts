import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UnsubscribeEventSource } from "./ingest";
import type { DeliveryReceipt, EventSink, UnsubscribeEvent } from "./relay";
import { MAX_TOKEN_LENGTH } from "./token";

/**
 * Dosya tabanlı DAYANIKLI olay kuyruğu (Aşama 15.7; 15.6'daki teslimat sözleşmesinin K1–K6, K10, K11 gerçeklemesi).
 *
 * Yeni bağımlılık ve migrasyon gerektirmez (yalnızca `node:fs`). Aktarıcı sunucusunda çalışır; hem `EventSink`
 * (aktarıcı yazar) hem `UnsubscribeEventSource` (uygulama çeker) arayüzünü gerçekler.
 *
 * Dayanıklılık: Her olay AYRI bir dosyadır. Yazım: `tmp/<id>.tmp` → içerik yazılır → `fsync` → `pending/<id>.json`'a
 * atomik `rename` → dizin `fsync` (en iyi çaba). `push` ANCAK bundan sonra makbuzla çözülür; bu yüzden aktarıcı 200'ü
 * olay diskteyken verir. Yarım kalan yazım (`tmp/`) hiçbir zaman "kuyruktaki olay" sayılmaz ve açılışta temizlenir.
 * Süreç yeniden başlarsa `pending/` dosyaları aynen durur.
 *
 * Teslimat: `pull` olayı TÜKETMEZ; yalnızca `ack` dosyayı siler (en-az-bir-kez). Kuyruk sınırı (`maxPending`) dolunca
 * `push` REDDEDİLİR (olay sessizce atılmaz → aktarıcı 503 verir). Olaylar onaylanana kadar SÜRESİZ saklanır
 * (otomatik silme YOK; saklama süresi ≥ belirteç ömrü şartı K10 böylece sağlanır); bozuk dosya `corrupt/`a taşınır ve
 * sayılır, ASLA sessizce silinmez.
 *
 * SINIRLAR (dürüstlük): Windows'ta dizin `fsync` desteklenmez (yalnızca dosya `fsync` + atomik rename yapılır); gerçek
 * dayanıklılık garantisi POSIX dosya sistemi (Linux) üzerinde, güç kesintisi dahil, ancak gerçek ortamda sınanabilir
 * (docs/09, K2). Tek süreç yazar varsayılır; birden çok yazar güvenlidir (benzersiz dosya adları) ama sayaç yaklaşıktır.
 */

const ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;
export const SPOOL_DEFAULT_MAX_PENDING = 100_000;

export interface FileSpoolOptions {
  dir: string;
  maxPending?: number;
  now?: () => number;
  /** Yalnızca testte: yazmadan önce çağrılır; istisna fırlatarak disk hatası simüle eder. */
  beforeWrite?: () => void;
}

export interface SpoolStats {
  depth: number;
  /** En eski onaysız olayın yaşı (ms); kuyruk boşsa null. */
  oldestAgeMs: number | null;
  corrupt: number;
}

export class SpoolError extends Error {
  constructor(readonly code: "queue_full" | "invalid_event" | "write_failed") {
    super(code);
    this.name = "SpoolError";
  }
}

function isEvent(e: unknown): e is UnsubscribeEvent {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    Object.keys(x).length === 4 &&
    x.v === 1 &&
    x.via === "one_click" &&
    typeof x.token === "string" &&
    x.token.length > 0 &&
    x.token.length <= MAX_TOKEN_LENGTH &&
    typeof x.receivedAt === "number" &&
    Number.isSafeInteger(x.receivedAt) &&
    x.receivedAt > 0
  );
}

export class FileSpool implements EventSink, UnsubscribeEventSource {
  readonly durable = true;
  private readonly pending: string;
  private readonly tmp: string;
  private readonly corrupt: string;
  private readonly max: number;
  private readonly clock: () => number;
  private readonly beforeWrite: (() => void) | undefined;

  constructor(opts: FileSpoolOptions) {
    if (opts.beforeWrite && process.env.NODE_ENV !== "test") {
      throw new Error("beforeWrite yalnızca testte kullanılabilir.");
    }
    this.pending = path.join(opts.dir, "pending");
    this.tmp = path.join(opts.dir, "tmp");
    this.corrupt = path.join(opts.dir, "corrupt");
    this.max = opts.maxPending ?? SPOOL_DEFAULT_MAX_PENDING;
    this.clock = opts.now ?? Date.now;
    this.beforeWrite = opts.beforeWrite;
    for (const d of [this.pending, this.tmp, this.corrupt]) fs.mkdirSync(d, { recursive: true });
    // Yarım kalan yazımlar kuyrukta DEĞİLDİR (istemciye 200 verilmedi); temizlenir.
    for (const f of fs.readdirSync(this.tmp)) fs.rmSync(path.join(this.tmp, f), { force: true });
  }

  private pendingIds(): string[] {
    return fs
      .readdirSync(this.pending)
      .filter((f) => f.endsWith(".json") && ID_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  async push(event: UnsubscribeEvent): Promise<DeliveryReceipt> {
    if (!isEvent(event)) throw new SpoolError("invalid_event");
    if (this.pendingIds().length >= this.max) throw new SpoolError("queue_full");
    const id = `${String(this.clock()).padStart(13, "0")}-${crypto.randomBytes(8).toString("hex")}`;
    const tmpPath = path.join(this.tmp, `${id}.tmp`);
    const finalPath = path.join(this.pending, `${id}.json`);
    try {
      this.beforeWrite?.();
      const fd = fs.openSync(tmpPath, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(event));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, finalPath);
      this.syncDir(this.pending);
    } catch {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      throw new SpoolError("write_failed");
    }
    return { stored: true, id };
  }

  async pull(limit: number): Promise<{ id: string; event: unknown }[]> {
    const n = Math.max(1, Math.min(Math.floor(limit), 500));
    const out: { id: string; event: unknown }[] = [];
    for (const id of this.pendingIds()) {
      if (out.length >= n) break;
      const file = path.join(this.pending, `${id}.json`);
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!isEvent(parsed)) throw new Error("invalid");
        out.push({ id, event: parsed });
      } catch {
        // Bozuk dosya: SİLİNMEZ, karantinaya alınır (sayılır); kuyruğu tıkamaz.
        try {
          fs.renameSync(file, path.join(this.corrupt, `${id}.json`));
        } catch {
          /* başka süreç taşımış olabilir */
        }
      }
    }
    return out;
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (typeof id !== "string" || !ID_RE.test(id)) continue; // yol geçişi/yabancı kimlik yok sayılır
      fs.rmSync(path.join(this.pending, `${id}.json`), { force: true });
    }
  }

  stats(): SpoolStats {
    const ids = this.pendingIds();
    const first = ids[0];
    return {
      depth: ids.length,
      oldestAgeMs: first ? Math.max(0, this.clock() - Number(first.slice(0, 13))) : null,
      corrupt: fs.readdirSync(this.corrupt).length,
    };
  }

  private syncDir(dir: string): void {
    try {
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* Windows vb.: dizin fsync desteklenmez (bkz. sınırlar) */
    }
  }
}
