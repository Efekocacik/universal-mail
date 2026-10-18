import { NextResponse, type NextRequest } from "next/server";

/**
 * Yerel sunucu koruması (NFR-02):
 *  - Host başlığı yalnızca yerel adresler olabilir (DNS yeniden bağlama saldırısına karşı).
 *  - Durum değiştiren isteklerde Origin, Host ile aynı olmalıdır (CSRF).
 * Sunucu ayrıca yalnızca 127.0.0.1'e bağlanır.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!;
  if (!LOCAL_HOSTS.has(hostname)) {
    return new NextResponse("Yasak: yalnızca yerel erişime izin verilir.", { status: 403 });
  }

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    if (site === "cross-site")
      return NextResponse.json({ error: "Çapraz kaynaklı istek reddedildi." }, { status: 403 });
    if (!origin || new URL(origin).host !== host) {
      return NextResponse.json({ error: "Geçersiz istek kaynağı." }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
