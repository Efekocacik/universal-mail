import { api, ApiError } from "./api";
import { safeAppPath } from "./app-path";

/**
 * Bildirim zili (Faz 4) istemci tarafı: paylaşılan sözleşmeye göre (Paket B uçları)
 *   GET  /api/notifications?limit=1..50 → {items:[{id,kind,title,body,url,createdAt,readAt}], unread}
 *   POST /api/notifications/read {ids:number[]} | {all:true} → {updated}
 *   GET  /api/status → unreadNotifications:number
 * Uçlar henüz yoksa (404) zil sessizce "kullanılamıyor" durumuna düşer; uygulamanın geri kalanı etkilenmez.
 * Bu dosyadaki saf işlevler DOM'suz test edilir (tests/notification-bell.test.ts).
 */

export interface BellItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  readAt: number | null;
}

export interface BellList {
  items: BellItem[];
  unread: number;
}

export const BELL_LIMIT = 20;
export const BELL_QUERY_KEY = ["notifications", "bell"] as const;

/** Rozet metni: 0 → gösterilmez; 9'dan fazlası "9+". */
export function badgeText(unread: number | null | undefined): string | null {
  if (!unread || unread < 1 || !Number.isFinite(unread)) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

const toNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const toStr = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Sunucu yanıtını savunmacı biçimde ayrıştırır: kimliği olmayan satır atılır, bağlantı uygulama içi değilse `/`
 * yapılır (dış adrese asla gidilmez), en çok `BELL_LIMIT` satır tutulur.
 */
export function parseBellList(data: unknown): BellList {
  const d = (data ?? {}) as { items?: unknown; unread?: unknown };
  const raw = Array.isArray(d.items) ? d.items : [];
  const items: BellItem[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = toNum(o.id);
    if (id === null) continue;
    items.push({
      id,
      kind: toStr(o.kind),
      title: toStr(o.title),
      body: toStr(o.body),
      url: safeAppPath(o.url),
      createdAt: toNum(o.createdAt) ?? 0,
      readAt: toNum(o.readAt),
    });
    if (items.length >= BELL_LIMIT) break;
  }
  const unread = toNum(d.unread) ?? items.filter((i) => i.readAt === null).length;
  return { items, unread: Math.max(0, unread) };
}

/** Okunmamış sayı ARTTI mı (ilk yüklemede değil)? Tarayıcıda yeni bildirim için kısa uyarı göstermekte kullanılır. */
export function unreadIncreased(prev: number | undefined, next: number | undefined): boolean {
  return prev !== undefined && next !== undefined && next > prev;
}

/**
 * Yeni bildirimi işletim sistemi bildirimi mi gösterecek? Yalnızca masaüstünde (Electron) VE "Masaüstü bildirimleri"
 * (`notifications.os`) açıkken; aksi halde uygulama içi kısa uyarı gösterilir (kapatan kullanıcı haberi kaçırmasın).
 */
export function osToastHandles(desktop: boolean, osEnabled: boolean): boolean {
  return desktop && osEnabled;
}

/** Listeyi getirir; uç yoksa (henüz kurulmamış, 404) `null`. Diğer hatalar fırlatılır. */
export async function fetchBell(limit = BELL_LIMIT): Promise<BellList | null> {
  try {
    return parseBellList(await api<unknown>(`/api/notifications?limit=${limit}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Okundu işaretler: belirli kimlikler (en çok 200) veya tümü. */
export function markBellRead(target: { ids: number[] } | { all: true }): Promise<unknown> {
  const json = "all" in target ? { all: true } : { ids: target.ids.slice(0, 200) };
  return api("/api/notifications/read", { method: "POST", json });
}
