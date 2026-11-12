import { ExplorePage } from "@/features/explore/explore-page";
import { parseExploreLink } from "@/features/explore/deep-link";
import { database } from "@/lib/api/http";
import { getSetting } from "@/lib/settings";

/** Ayar okunamazsa (ör. ilk kurulum) "yeni" penceresinin varsayılanı. */
const FALLBACK_WINDOW_DAYS = 60;

async function newWindowDays(): Promise<number> {
  try {
    return (await getSetting(await database(), "novelty.thresholds")).newWindowDays;
  } catch (e) {
    console.warn(
      `[explore] "yeni" penceresi okunamadı (${(e as Error).name}); varsayılan kullanılıyor.`,
    );
    return FALLBACK_WINDOW_DAYS;
  }
}

/**
 * Keşif. Bağlantı parametreleri (gösterge paneli ve bildirimler kullanır): `scan`, `lifecycle=opened|future|new`
 * (virgülle birden çok), `detectedSince=<epoch ms>`, `archived=1`, `emailStatus=<durum,…>` ve ayrıntısı açılacak
 * işletme için `lead=<id>`. Geçersiz değerler yok sayılır. `opened`/`new`
 * bağlantısı `detectedSince` taşımıyorsa ayarlardaki "yeni" penceresi (son N gün) uygulanır; bkz. `parseExploreLink`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const lc = String(sp.lifecycle ?? "");
  const needsWindow = /\b(opened|new)\b/.test(lc) && !sp.detectedSince;
  const initial = parseExploreLink(sp, {
    defaultWindowDays: needsWindow ? await newWindowDays() : undefined,
  });
  // Başka bir bağlantıyla (ör. gösterge panelinden) gelinirse keşif durumu o bağlantıyla yeniden kurulur.
  return <ExplorePage key={JSON.stringify(initial)} initial={initial} />;
}
