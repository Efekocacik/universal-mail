import fs from "node:fs";
import path from "node:path";
import type { ReplayStore } from "@/lib/unsubscribe/relay";

/**
 * Dosya destekli tekrar oynatma kaydı (TB-6): aktarıcı yeniden başlasa da aynı belirteç (jti) İKİNCİ kez kuyruğa
 * yazılmaz. Yalnızca bir iyileştirmedir; asıl tekilleştirme uygulama tarafındadır (ingest, `jti`). Bu yüzden kayıt
 * yazılamazsa/okunamazsa hiçbir istek reddedilmez: en kötü durumda olay tekrar kuyruğa girer.
 *
 * Biçim: satır başına `<jti> <bitiş_ms>\n`, yalnızca ekleme (append-only). Açılışta süresi dolanlar atılır ve dosya
 * atomik olarak (tmp → rename) sıkıştırılır. Bellekteki kayıt sayısı sınırlıdır (en eski atılır).
 */

const JTI_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface FileReplayStoreOptions {
  file: string;
  max?: number;
  now?: () => number;
}

export class FileReplayStore implements ReplayStore {
  private readonly map = new Map<string, number>();
  private readonly max: number;
  private readonly clock: () => number;
  private appended = 0;

  constructor(private readonly o: FileReplayStoreOptions) {
    this.max = o.max ?? 100_000;
    this.clock = o.now ?? Date.now;
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    this.load();
    this.compact();
  }

  private load(): void {
    let raw = "";
    try {
      raw = fs.readFileSync(this.o.file, "utf8");
    } catch {
      return; // ilk açılış
    }
    const now = this.clock();
    for (const line of raw.split("\n")) {
      const [jti, expRaw] = line.split(" ");
      const exp = Number(expRaw);
      if (!jti || !JTI_RE.test(jti) || !Number.isSafeInteger(exp) || exp <= now) continue;
      this.map.set(jti, exp);
    }
    this.trim(now);
  }

  /** Süresi dolanları ve fazlalığı atar (en eski eklenen önce). */
  private trim(now: number): void {
    if (this.map.size <= this.max) return;
    for (const [k, exp] of this.map) if (exp <= now) this.map.delete(k);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  private compact(): void {
    const tmp = `${this.o.file}.tmp`;
    try {
      let out = "";
      for (const [k, exp] of this.map) out += `${k} ${exp}\n`;
      fs.writeFileSync(tmp, out, { mode: 0o600 });
      fs.renameSync(tmp, this.o.file);
      this.appended = 0;
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  seen(jti: string): boolean {
    const exp = this.map.get(jti);
    return exp !== undefined && exp > this.clock();
  }

  remember(jti: string, expiresAtMs: number): void {
    if (!JTI_RE.test(jti) || !Number.isSafeInteger(expiresAtMs)) return;
    const now = this.clock();
    this.map.delete(jti);
    this.map.set(jti, expiresAtMs);
    this.trim(now);
    try {
      fs.appendFileSync(this.o.file, `${jti} ${expiresAtMs}\n`, { mode: 0o600 });
      this.appended++;
      if (this.appended > Math.max(1_000, this.map.size)) this.compact();
    } catch {
      /* kayıt yazılamadı: uygulama tarafı yine tekilleştirir */
    }
  }

  get size(): number {
    return this.map.size;
  }
}
