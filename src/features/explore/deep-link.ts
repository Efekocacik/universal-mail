import type { LeadLifecycle } from "@/lib/leads/query";

/** Keşif bağlantısından gelen başlangıç süzgeçleri (bkz. state.tsx `InitialExploreState`). */
export interface ExploreLink {
  scanId?: number;
  lifecycle?: LeadLifecycle[];
  detectedSince?: number;
  /** `detectedSince` varsayılan pencereden geldiyse gün sayısı (süzgeç çipi "Son N gün" der). */
  detectedDays?: number;
  archived?: boolean;
}

const DAY_MS = 86_400_000;

const LIFECYCLES: readonly LeadLifecycle[] = ["opened", "future", "new"];
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/?scan=…&lifecycle=opened,new&detectedSince=…&archived=1` bağlantısını çözer (saf; sınanır). Bağlantı dışarıdan
 * (bildirim, gösterge paneli) gelir: bilinmeyen ve geçersiz değerler sessizce atılır, sayfa hata vermez.
 *
 * `lifecycle` `opened` veya `new` içerip `detectedSince` YOKSA, `defaultWindowDays` (ayarlardaki "yeni" penceresi,
 * varsayılan 60 gün) uygulanır: "Yeni açılanlar" bağlantısı tüm zamanları değil son N günü gösterir (çip "Son 60 gün";
 * kullanıcı "Tüm zamanlar"ı seçebilir). Tüm zamanlar için bağlantı açıkça `detectedSince=0` taşır. API'nin kendisi
 * varsayılan uygulamaz: `GET /api/leads?lifecycle=opened` tüm zamanlardır; pencere isteyen çağıran `detectedSince` verir.
 */
export function parseExploreLink(
  sp: Record<string, string | string[] | undefined>,
  opts: { defaultWindowDays?: number; now?: number } = {},
): ExploreLink {
  const out: ExploreLink = {};
  const scan = Number(first(sp.scan));
  if (Number.isInteger(scan) && scan > 0) out.scanId = scan;
  const lc = (first(sp.lifecycle) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LeadLifecycle => (LIFECYCLES as readonly string[]).includes(s));
  if (lc.length) out.lifecycle = [...new Set(lc)];
  const raw = first(sp.detectedSince);
  const since = raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isInteger(since) && since >= 0 && since <= 8_640_000_000_000_000)
    out.detectedSince = since;
  else if (
    (raw === undefined || raw === "") &&
    opts.defaultWindowDays !== undefined &&
    out.lifecycle?.some((l) => l === "opened" || l === "new")
  ) {
    out.detectedDays = opts.defaultWindowDays;
    out.detectedSince = (opts.now ?? Date.now()) - opts.defaultWindowDays * DAY_MS;
  }
  if (first(sp.archived) === "1") out.archived = true;
  return out;
}

/** Ters yön: keşif bağlantısı üretir (gösterge paneli ve bildirimler bunu kullanabilir). */
export function exploreHref(link: ExploreLink): string {
  const sp = new URLSearchParams();
  if (link.scanId) sp.set("scan", String(link.scanId));
  if (link.lifecycle?.length) sp.set("lifecycle", link.lifecycle.join(","));
  // Göreli pencere (`detectedDays`) bağlantıya yazılmaz: açıldığı anda varsayılan pencere yeniden hesaplanır.
  if (link.detectedSince !== undefined && link.detectedDays === undefined)
    sp.set("detectedSince", String(link.detectedSince));
  if (link.archived) sp.set("archived", "1");
  const q = sp.toString();
  return q ? `/?${q}` : "/";
}
