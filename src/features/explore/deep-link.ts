import type { LeadLifecycle } from "@/lib/leads/query";

/** Keşif bağlantısından gelen başlangıç süzgeçleri (bkz. state.tsx `InitialExploreState`). */
export interface ExploreLink {
  scanId?: number;
  lifecycle?: LeadLifecycle[];
  detectedSince?: number;
  archived?: boolean;
}

const LIFECYCLES: readonly LeadLifecycle[] = ["opened", "future", "new"];
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/?scan=…&lifecycle=opened,new&detectedSince=…&archived=1` bağlantısını çözer (saf; sınanır). Bağlantı dışarıdan
 * (bildirim, gösterge paneli) gelir: bilinmeyen ve geçersiz değerler sessizce atılır, sayfa hata vermez.
 */
export function parseExploreLink(sp: Record<string, string | string[] | undefined>): ExploreLink {
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
  if (first(sp.archived) === "1") out.archived = true;
  return out;
}

/** Ters yön: keşif bağlantısı üretir (gösterge paneli ve bildirimler bunu kullanabilir). */
export function exploreHref(link: ExploreLink): string {
  const sp = new URLSearchParams();
  if (link.scanId) sp.set("scan", String(link.scanId));
  if (link.lifecycle?.length) sp.set("lifecycle", link.lifecycle.join(","));
  if (link.detectedSince !== undefined) sp.set("detectedSince", String(link.detectedSince));
  if (link.archived) sp.set("archived", "1");
  const q = sp.toString();
  return q ? `/?${q}` : "/";
}
