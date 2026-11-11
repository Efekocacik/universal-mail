import { NextResponse, type NextRequest } from "next/server";

/**
 * Yerel sunucu koruması (NFR-02):
 *  - Host başlığı yalnızca yerel adresler olabilir (DNS yeniden bağlama saldırısına karşı).
 *  - Durum değiştiren isteklerde Origin, Host ile aynı olmalıdır (CSRF).
 *  - `/api/` altındaki çapraz site istekleri (GET dahil) reddedilir; yalnızca OAuth geri çağrısı hariçtir.
 * Sunucu ayrıca yalnızca 127.0.0.1'e bağlanır.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OAUTH_CALLBACK_PATH = "/api/oauth/gmail/callback";

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!;
  if (!LOCAL_HOSTS.has(hostname)) {
    return new NextResponse("Yasak: yalnızca yerel erişime izin verilir.", { status: 403 });
  }

  const method = req.method.toUpperCase();
  const site = req.headers.get("sec-fetch-site");
  // Başka bir sitenin tetiklediği HER API isteği (GET dahil: `<img src=…/api/…/export>` gibi denetim kaydı yazan ve
  // tam tablo dışa aktaran istekler) reddedilir. Tarayıcılar bu başlığı her zaman gönderir; uygulama penceresi ve aynı
  // kaynaklı indirme bağlantıları `same-origin`/`none`, Electron'un sağlık yoklaması başlıksız gelir. İstisna: Google'ın
  // yönlendirdiği OAuth geri çağrısı (üst düzey çapraz site gezinmesi; state tek kullanımlıktır).
  if (
    site === "cross-site" &&
    req.nextUrl.pathname.startsWith("/api/") &&
    req.nextUrl.pathname !== OAUTH_CALLBACK_PATH
  ) {
    return NextResponse.json({ error: "Çapraz kaynaklı istek reddedildi." }, { status: 403 });
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = req.headers.get("origin");
    if (site === "cross-site")
      return NextResponse.json({ error: "Çapraz kaynaklı istek reddedildi." }, { status: 403 });
    if (!origin || new URL(origin).host !== host) {
      return NextResponse.json({ error: "Geçersiz istek kaynağı." }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
