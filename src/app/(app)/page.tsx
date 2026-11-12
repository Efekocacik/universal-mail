import { ExplorePage } from "@/features/explore/explore-page";
import { parseExploreLink } from "@/features/explore/deep-link";

/**
 * Keşif. Bağlantı parametreleri (gösterge paneli ve bildirimler kullanır): `scan`, `lifecycle=opened|future|new`
 * (virgülle birden çok), `detectedSince=<epoch ms>`, `archived=1`. Geçersiz değerler yok sayılır.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initial = parseExploreLink(await searchParams);
  // Başka bir bağlantıyla (ör. gösterge panelinden) gelinirse keşif durumu o bağlantıyla yeniden kurulur.
  return <ExplorePage key={JSON.stringify(initial)} initial={initial} />;
}
