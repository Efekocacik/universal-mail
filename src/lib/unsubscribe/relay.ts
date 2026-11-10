import { verifyToken, type PublicKeyEntry } from "./token";

/**
 * Taşınabilir HTTPS abonelikten çıkış aktarıcısı (Aşama 15.6; RFC 8058 tek tıklamalı çıkış, RFC 2369).
 *
 * Bu modül yalnızca web standardı `Request`/`Response` ve `./token` (saf, GENEL anahtarla doğrulama) kullanır:
 * veritabanı, dosya sistemi, gizli depo, ağ ÇIKIŞI yoktur. Herhangi bir Node tabanlı HTTPS sunucusuna bağlanabilir.
 * Bu sürümde dağıtım dosyası/alan adı YOKTUR; gerçek HTTPS ve alan adı kararı sonraki aşamalara aittir.
 *
 * Protokol kuralları:
 *  - POST + `application/x-www-form-urlencoded` gövde `List-Unsubscribe=One-Click`: çıkışı kaydeder (RFC 8058).
 *    Çerez, kimlik doğrulama veya yönlendirme YOKTUR; yanıt 3xx ASLA olmaz.
 *  - GET/HEAD durum DEĞİŞTİRMEZ (tarayıcı önizleme, güvenlik tarayıcısı, bağlantı ön yüklemesi çıkış yaptırmasın):
 *    yalnızca onay formu gösterir; onay POST ile yapılır.
 *  - İmza geçersiz, biçim bozuk, anahtar bilinmiyor, yük geçersiz, henüz geçerli değil → 400 (ayrım yapılmaz);
 *    süresi dolmuş → 410. Yanıtlar belirteci, alıcıyı veya kayıt varlığını ASLA yansıtmaz.
 *  - İdempotent: aynı belirteç tekrar gelirse 200 döner, olay İKİNCİ kez iletilmez (aktarıcı yeniden başlasa bile
 *    uygulama tarafı `jti` ile ayrıca tekilleştirir).
 *  - Hız sınırı ve gövde sınırı (1 KiB) kuyruğa/doğrulamaya girmeden uygulanır.
 *
 * TESLİMAT SÖZLEŞMESİ (200 yanıtının anlamı — RFC 8058 gereği 2xx "çıkış talebi alındı ve kaybolmayacak" demektir):
 *  1. 200 YALNIZCA `sink.push()` DAYANIKLI kayıt makbuzu (`{ stored: true, id }`) döndürdükten SONRA verilir. "Dayanıklı":
 *     aktarıcı süreci/makinesi yeniden başlasa veya uygulama çevrimdışı olsa bile olay kaybolmaz (diske/veritabanına
 *     yazılıp onaylanmış). Makbuz yoksa/yanlışsa, `push` istisna fırlatırsa veya `sinkTimeoutMs` aşılırsa 503 +
 *     Retry-After verilir; tekrar oynatma kaydı tutulmaz (istemci yeniden dener).
 *  2. En az bir kez (at-least-once) teslimat: aynı olay birden çok kez kuyruğa girebilir (yeniden deneme, aktarıcı
 *     yeniden başlaması, zaman aşımından sonra geç başarı). Tekilleştirme UYGULAMA tarafındadır (`jti`, ingest.ts).
 *  3. Aynı `jti` için eşzamanlı istekler TEK bir `push` çağrısında birleştirilir (single-flight) ve aynı sonucu alır.
 *  4. Kuyruk dolu/yazılamıyorsa olay ASLA sessizce atılmaz: `push` reddedilir → 503.
 *  5. BELLEK İÇİ kuyruk (`MemoryEventQueue`) YALNIZCA test/demo içindir ve dayanıklı DEĞİLDİR (`durable=false`).
 *     Dayanıklı olmayan bir kuyruk, `NODE_ENV !== "test"` iken işleyiciye verilirse `createRelayHandler` HATA FIRLATIR
 *     (yanlışlıkla gerçek ortamda etkinleştirilemez). Gerçek bir sink `durable: true` bildirmelidir.
 *  Gerçek iletim mekanizmasının (Aşama 15.7) kabul ölçütleri: docs/09-FAZ3-CANLI-DOGRULAMA.md, Bölüm 3.1;
 *  yürütülebilir sözleşme testleri: tests/helpers/sink-contract.ts.
 */

export interface UnsubscribeEvent {
  v: 1;
  /** Aktarıcının doğruladığı belirteç; uygulama KENDİ doğrular (aktarıcıya güvenilmez). */
  token: string;
  /** Aktarıcının isteği aldığı an (ms). */
  receivedAt: number;
  via: "one_click";
}

/** Dayanıklı kayıt makbuzu: yalnızca olay kalıcı olarak kaydedilip onaylandıktan SONRA döndürülür. */
export interface DeliveryReceipt {
  stored: true;
  /** Kuyruktaki kayıt kimliği (izleme/onay için). */
  id: string;
}

export interface EventSink {
  /**
   * `true`: `push` yalnızca kalıcı depoya yazılıp onaylandıktan sonra çözülür (yeniden başlatmada kaybolmaz).
   * `false`: yalnızca test/demo; gerçek ortamda işleyiciye verilemez.
   */
  readonly durable: boolean;
  /** Olayı dayanıklı biçimde kaydeder ve makbuz döndürür; kaydedemezse İSTİSNA fırlatır (sessizce atmaz). */
  push(event: UnsubscribeEvent): Promise<DeliveryReceipt>;
}

export interface ReplayStore {
  seen(jti: string): boolean | Promise<boolean>;
  remember(jti: string, expiresAtMs: number): void | Promise<void>;
}

export interface RateLimiter {
  /** Kabul edilirse null, edilmezse `Retry-After` saniyesi. */
  check(key: string, now: number): number | null;
}

export interface RelayOptions {
  keys: () => readonly PublicKeyEntry[] | Promise<readonly PublicKeyEntry[]>;
  sink: EventSink;
  replay?: ReplayStore;
  limiter?: RateLimiter;
  now?: () => number;
  /** Hız sınırı anahtarı (ör. ana bilgisayarın güvenilir istemci adresi); yoksa tek genel kova. */
  clientKey?: (req: Request) => string;
  /** Sink'in `push` için en çok bekleme süresi (ms); aşılırsa 503 (varsayılan 10 sn). */
  sinkTimeoutMs?: number;
}

export const DEFAULT_SINK_TIMEOUT_MS = 10_000;

/** Dayanıklı olmayan sink yalnızca testte kullanılabilir. */
export function assertSinkAllowed(sink: EventSink): void {
  if (!sink || typeof sink.push !== "function") throw new Error("Geçersiz olay kuyruğu.");
  if (sink.durable !== true && process.env.NODE_ENV !== "test") {
    throw new Error(
      "Dayanıklı olmayan (bellek içi) olay kuyruğu gerçek ortamda kullanılamaz; dayanıklı bir sink gerekir.",
    );
  }
}

const isReceipt = (r: unknown): r is DeliveryReceipt =>
  !!r &&
  typeof r === "object" &&
  (r as DeliveryReceipt).stored === true &&
  typeof (r as DeliveryReceipt).id === "string" &&
  (r as DeliveryReceipt).id.length > 0;

export const MAX_BODY_BYTES = 1024;
const PATH_RE = /^\/u\/([A-Za-z0-9._-]{1,700})$/;
const ONE_CLICK_FIELD = "List-Unsubscribe";
const ONE_CLICK_VALUE = "One-Click";

/* ---------------------------------------------------------------------------------------------- */

/** Bellekte sınırlı tekrar oynatma kaydı (en eski kayıt atılır). */
export class MemoryReplayStore implements ReplayStore {
  private readonly map = new Map<string, number>();
  constructor(private readonly max = 100_000) {}
  seen(jti: string): boolean {
    return this.map.has(jti);
  }
  remember(jti: string, expiresAtMs: number): void {
    const now = Date.now();
    if (this.map.size >= this.max) {
      for (const [k, exp] of this.map) {
        if (exp <= now) this.map.delete(k);
      }
      while (this.map.size >= this.max) {
        const first = this.map.keys().next().value;
        if (first === undefined) break;
        this.map.delete(first);
      }
    }
    this.map.set(jti, expiresAtMs);
  }
}

/** Sabit pencereli basit hız sınırlayıcı (anahtar sayısı sınırlı). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}
  check(key: string, now: number): number | null {
    const b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) {
      if (this.buckets.size >= this.maxKeys) this.buckets.clear();
      this.buckets.set(key, { start: now, count: 1 });
      return null;
    }
    b.count++;
    if (b.count > this.limit) return Math.max(1, Math.ceil((b.start + this.windowMs - now) / 1000));
    return null;
  }
}

/**
 * BELLEKTE olay kuyruğu — YALNIZCA test/demo. DAYANIKLI DEĞİLDİR: süreç kapanınca olaylar kaybolur. Bu yüzden
 * `NODE_ENV !== "test"` iken oluşturulamaz ve `createRelayHandler` ona gerçek ortamda izin vermez.
 */
export class MemoryEventQueue implements EventSink {
  readonly durable = false;
  readonly events: UnsubscribeEvent[] = [];
  failNext = 0;
  private seq = 0;
  constructor() {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("MemoryEventQueue yalnızca testte kullanılabilir (dayanıklı değildir).");
    }
  }
  async push(event: UnsubscribeEvent): Promise<DeliveryReceipt> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("sink unavailable");
    }
    this.events.push(event);
    return { stored: true, id: `mem-${++this.seq}` };
  }
}

/* ---------------------------------------------------------------------------------------------- */

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const HTML_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

const PAGE = (title: string, p1: string, p2: string, form: boolean): string =>
  `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex,nofollow"><title>${title}</title>` +
  `<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}` +
  `button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style></head><body><h1>${title}</h1><p>${p1}</p><p>${p2}</p>` +
  (form
    ? `<form method="post" action=""><input type="hidden" name="${ONE_CLICK_FIELD}" value="${ONE_CLICK_VALUE}">` +
      `<button type="submit">Abonelikten çık / Unsubscribe</button></form>`
    : "") +
  `</body></html>`;

function html(status: number, body: string, head: boolean): Response {
  return new Response(head ? null : body, { status, headers: HTML_HEADERS });
}

/** Gövdeyi en çok `MAX_BODY_BYTES` bayt okur; aşılırsa null. */
async function readLimited(req: Request): Promise<string | null> {
  const len = req.headers.get("content-length");
  if (len !== null && (!/^\d{1,9}$/.test(len) || Number(len) > MAX_BODY_BYTES)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export function createRelayHandler(opts: RelayOptions): (req: Request) => Promise<Response> {
  const clock = opts.now ?? Date.now;
  const replay = opts.replay ?? new MemoryReplayStore();
  assertSinkAllowed(opts.sink);
  const sinkTimeout = opts.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
  /** Aynı jti için eşzamanlı istekler tek `push` çağrısında birleşir. */
  const inflight = new Map<string, Promise<boolean>>();

  /** Olayı dayanıklı kaydeder; YALNIZCA geçerli makbuzla true. Hata, zaman aşımı veya makbuzsuz çözülme false. */
  const deliver = async (event: UnsubscribeEvent): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        opts.sink.push(event),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("sink timeout")), sinkTimeout);
        }),
      ]);
      return isReceipt(receipt);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return async (req: Request): Promise<Response> => {
    const now = clock();
    const url = new URL(req.url);
    const m = PATH_RE.exec(url.pathname);
    if (!m) return text(404, "Not found");
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      return text(405, "Method not allowed", { Allow: "GET, HEAD, POST" });
    }

    const wait = opts.limiter?.check(opts.clientKey?.(req) ?? "global", now) ?? null;
    if (wait !== null) return text(429, "Too many requests", { "Retry-After": String(wait) });

    const token = m[1]!;
    let keys: readonly PublicKeyEntry[];
    try {
      keys = await opts.keys();
    } catch {
      return text(503, "Unavailable", { "Retry-After": "60" });
    }
    const verdict = verifyToken(token, keys, now);

    if (method === "GET" || method === "HEAD") {
      const head = method === "HEAD";
      if (verdict.ok) {
        return html(
          200,
          PAGE(
            "Abonelikten çıkış / Unsubscribe",
            "Bu adrese bir daha ileti gönderilmemesi için aşağıdaki düğmeye basın.",
            "Press the button below to stop receiving messages at this address.",
            true,
          ),
          head,
        );
      }
      if (verdict.reason === "expired") {
        return html(
          410,
          PAGE(
            "Bağlantının süresi doldu / Link expired",
            "Bu çıkış bağlantısının süresi doldu. İletideki iletişim adresine yazarak çıkış talebinde bulunabilirsiniz.",
            "This unsubscribe link has expired. Please reply to the message to opt out.",
            false,
          ),
          head,
        );
      }
      return html(
        400,
        PAGE(
          "Geçersiz bağlantı / Invalid link",
          "Bu çıkış bağlantısı geçerli değil.",
          "This unsubscribe link is not valid.",
          false,
        ),
        head,
      );
    }

    // POST: RFC 8058 tek tıklamalı çıkış.
    const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/x-www-form-urlencoded") return text(415, "Unsupported media type");
    const body = await readLimited(req);
    if (body === null) return text(413, "Payload too large");
    if (new URLSearchParams(body).get(ONE_CLICK_FIELD) !== ONE_CLICK_VALUE) {
      return text(400, "Invalid request");
    }
    if (!verdict.ok) {
      return verdict.reason === "expired" ? text(410, "Expired") : text(400, "Invalid");
    }

    const { j, e } = verdict.claims;
    let already = false;
    try {
      already = await replay.seen(j);
    } catch {
      already = false; // kayıt okunamazsa yeniden ilet (uygulama tarafı tekilleştirir)
    }
    if (!already) {
      let flight = inflight.get(j);
      if (!flight) {
        const event: UnsubscribeEvent = { v: 1, token, receivedAt: now, via: "one_click" };
        flight = deliver(event)
          .then(async (ok) => {
            if (ok) {
              try {
                await replay.remember(j, e * 1000);
              } catch {
                /* olay dayanıklı kaydedildi; uygulama tarafı tekilleştirir */
              }
            }
            return ok;
          })
          .finally(() => inflight.delete(j));
        inflight.set(j, flight);
      }
      // 200 YALNIZCA dayanıklı kayıt onaylandıysa; aksi halde 503 (RFC 8058 istemcisi yeniden dener).
      if (!(await flight)) return text(503, "Unavailable", { "Retry-After": "60" });
    }
    return text(200, "OK");
  };
}
