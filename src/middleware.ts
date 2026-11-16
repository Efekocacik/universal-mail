import { NextResponse, type NextRequest } from "next/server";

/**
 * Yerel sunucu koruması (NFR-02):
 *  - Host başlığı yalnızca yerel adresler olabilir (DNS yeniden bağlama saldırısına karşı).
 *  - Durum değiştiren isteklerde Origin, Host ile aynı olmalıdır (CSRF).
 *  - `/api/` altındaki başka siteden gelen istekler (GET dahil) reddedilir; yalnızca OAuth geri çağrısı hariçtir.
 * Sunucu ayrıca yalnızca 127.0.0.1'e bağlanır. Faz 6 (paket G): `tests/security-route-guard.test.ts` her uç nokta
 * dosyası için bu korumayı sınar; yeni bir uç eklendiğinde test kendiliğinden kapsar.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OAUTH_CALLBACK_PATH = "/api/oauth/gmail/callback";
/**
 * Başka bir siteden tetiklenmiş istek. `same-site` da sayılır: aynı makinede başka bir bağlantı noktasında çalışan
 * yerel bir sayfa (ör. `http://127.0.0.1:8080`) tarayıcıya göre "aynı site"dir ama uygulamanın kendisi değildir.
 * Uygulama penceresi ve indirmeler `same-origin`/`none` gönderir, Electron'un sağlık yoklaması başlıksız gelir.
 */
const FOREIGN_SITES = new Set(["cross-site", "same-site"]);

function forbidden(message: string) {
  return NextResponse.json({ error: message, code: "FORBIDDEN" }, { status: 403 });
}

/** Origin başlığının host[:port] kısmı; ayrıştırılamıyorsa (`null`, bozuk değer) null. */
function originHost(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

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
  // tam tablo dışa aktaran istekler) reddedilir. İstisna: Google'ın yönlendirdiği OAuth geri çağrısı (üst düzey çapraz
  // site gezinmesi; state tek kullanımlıktır).
  if (
    site !== null &&
    FOREIGN_SITES.has(site) &&
    req.nextUrl.pathname.startsWith("/api/") &&
    req.nextUrl.pathname !== OAUTH_CALLBACK_PATH
  ) {
    return forbidden("Çapraz kaynaklı istek reddedildi.");
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (site !== null && FOREIGN_SITES.has(site))
      return forbidden("Çapraz kaynaklı istek reddedildi.");
    const origin = req.headers.get("origin");
    if (!origin || originHost(origin) !== host) return forbidden("Geçersiz istek kaynağı.");
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
