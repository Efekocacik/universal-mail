/**
 * Süreç içi, tipli olay yayıncısı. Sonraki fazlar (e-posta bulma, kampanya) mevcut kodu değiştirmeden
 * bu olaylara abone olur. Örn. Faz 2: `place.enriched` olayında web sitesinden e-posta taramasını başlatır.
 * Not: Olaylar yalnızca yayıldığı süreç içindedir (worker veya web sunucusu); süreçler arası iş akışı
 * için `jobs` tablosu kullanılır.
 */
export interface AppEvents {
  "scan.completed": { scanId: number; newPlaces: number; totalPlaces: number };
  "scan.failed": { scanId: number; error: string };
  "place.discovered": { scanId: number; placeIds: string[] };
  "place.enriched": { placeIds: string[] };
  "lead.noveltyChanged": { leadIds: number[] };
}

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void | Promise<void>;

const handlers = new Map<keyof AppEvents, Set<Handler<never>>>();

export function onEvent<K extends keyof AppEvents>(name: K, handler: Handler<K>): () => void {
  const set = handlers.get(name) ?? new Set();
  set.add(handler as Handler<never>);
  handlers.set(name, set);
  return () => set.delete(handler as Handler<never>);
}

export async function emitEvent<K extends keyof AppEvents>(name: K, payload: AppEvents[K]): Promise<void> {
  for (const h of handlers.get(name) ?? []) {
    try {
      await (h as Handler<K>)(payload);
    } catch (e) {
      console.error(`[events] ${String(name)} işleyicisi hata verdi:`, e);
    }
  }
}

export function clearEventHandlers(): void {
  handlers.clear();
}
