import { MemoryRateLimiter, type RateLimiter } from "@/lib/unsubscribe/relay";

/**
 * Aktarıcı girişlerinin (VPS: ./server, Cloudflare Worker: ./worker) ORTAK, çalışma ortamından bağımsız parçaları:
 * yapılandırma ayrıştırma, yönteme duyarlı hız sınırı, hız sınırı kimliği, yol sınıfı ve yanıt başlıkları.
 * `node:` modülü içe aktarılmaz.
 */

/** Yalnızca okunan ortam değişkenleri (testte düz nesne verilebilir). */
export type RelayEnv = Readonly<Record<string, string | undefined>>;

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}

/** Tamsayı ortam değişkeni: boşsa varsayılan; biçim/aralık dışıysa `RelayConfigError`. */
export function intEnv(env: RelayEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return def;
  if (!/^\d{1,10}$/.test(raw)) throw new RelayConfigError(`${name} bir tamsayı olmalı.`);
  const n = Number(raw);
  if (n < min || n > max) throw new RelayConfigError(`${name} ${min}–${max} aralığında olmalı.`);
  return n;
}

/**
 * Yönteme duyarlı hız sınırlayıcı (B8): Gmail tek tıklamalı POST'ları paylaşılan Google adreslerinden gelir, bu
 * yüzden POST kovası GET'ten geniştir. Anahtar `${YÖNTEM}:${istemci}` biçimindedir (sınırlayıcı isteği görmez).
 */
export class MethodAwareRateLimiter implements RateLimiter {
  private readonly get: MemoryRateLimiter;
  private readonly post: MemoryRateLimiter;
  constructor(getLimit: number, postLimit: number, windowMs: number) {
    this.get = new MemoryRateLimiter(getLimit, windowMs);
    this.post = new MemoryRateLimiter(postLimit, windowMs);
  }
  check(key: string, now: number): number | null {
    return (key.startsWith("POST:") ? this.post : this.get).check(key, now);
  }
}

/** Ondalık noktalı IPv4 (her bölüm 0–255, baştaki sıfırlara izin verilmez). */
export function isIPv4Text(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((p) => Number(p) <= 255 && (p === "0" || !p.startsWith("0")));
}

/** IPv6 metni (bölge kimliği `%` kabul edilmez); denetim WHATWG URL ayrıştırıcısıyla yapılır (Node ve Workers). */
export function isIPv6Text(s: string): boolean {
  if (s.length < 2 || s.length > 45 || !s.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(s))
    return false;
  try {
    return new URL(`http://[${s}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/**
 * Hız sınırı için istemci kimliği: IPv4 olduğu gibi; IPv6 ise /64 öneki (tek bir istemci genellikle bütün bir /64'ü
 * denetler; tam adresle her istek yeni bir kova alırdı). Geçersiz değer olduğu gibi döner. `isV6`: IPv6 denetimi
 * (VPS: `net.isIPv6`; Worker: `isIPv6Text`).
 */
export function rateLimitSubjectWith(ip: string, isV6: (s: string) => boolean): string {
  if (!isV6(ip)) return ip;
  const lower = ip.toLowerCase();
  const compressed = lower.includes("::");
  const [head = "", tail = ""] = lower.split("::", 2);
  const h = head ? head.split(":") : [];
  const t = compressed && tail ? tail.split(":") : [];
  // Gömülü IPv4 (a.b.c.d) son iki 16 bitlik grubu kaplar.
  const width = (gs: string[]) => gs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const groups = compressed
    ? [...h, ...Array<string>(Math.max(0, 8 - width(h) - width(t))).fill("0"), ...t]
    : h;
  const norm = groups.map((g) => (g.includes(".") ? g : (parseInt(g, 16) || 0).toString(16)));
  // IPv4 eşlemeli/uyumlu adres (onaltılık biçim dahil, ör. ::ffff:c000:201): ilk 80 bit sıfırdır; /64'e indirgemek
  // bütün IPv4 istemcilerini TEK kovada toplardı, bu yüzden adresin kendisi kullanılır.
  if (norm.slice(0, 5).every((g) => g === "0")) return lower;
  return `${norm.slice(0, 4).join(":")}::/64`;
}

/** Günlük için yol sınıfı; yolun kendisi (belirteç) ASLA yazılmaz. */
export function routeClass(pathname: string): "u" | "spool" | "healthz" | "other" {
  if (pathname.startsWith("/u/")) return "u";
  if (pathname.startsWith("/spool/")) return "spool";
  if (pathname === "/healthz") return "healthz";
  return "other";
}

export const PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export const JSON_RESPONSE_HEADERS = {
  ...PLAIN_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
};
