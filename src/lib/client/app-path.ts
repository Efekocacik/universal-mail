/**
 * Uygulama içi yol doğrulaması: bildirimin bağlantısı (zil ve işletim sistemi bildirimi tıklaması) YALNIZCA bu
 * uygulamanın bir sayfasına gidebilir; dış adres, protokol göreli adres (`//host`), `..`/`.` bölümleri ve kodlanmış
 * eğik çizgiler reddedilir. Kural `src/lib/notifications/service.ts` içindeki `NOTIFICATION_URL_RE` ile AYNIDIR
 * (tests/notification-bell.test.ts eşitliği denetler); burada ayrıca tutulur çünkü o modül veritabanı katmanını içe
 * aktarır ve tarayıcı paketine/Electron ana sürecine girmemelidir.
 */
export const APP_PATH_RE =
  /^\/(?!\/)(?![^?]*\/\/)(?!(?:[^?]*\/)?\.{1,2}(?:[/?]|$))(?![^?]*%(?:2[fFeE]|5[cC]))[A-Za-z0-9/_\-?=&.%]*$/;

const MAX_PATH = 500;

/** Geçerli bir uygulama içi yolsa kendisini, değilse güvenli varsayılanı (`/`) döndürür. */
export function safeAppPath(url: unknown, fallback = "/"): string {
  return typeof url === "string" && url.length <= MAX_PATH && APP_PATH_RE.test(url)
    ? url
    : fallback;
}

/**
 * Yolu verilen kökene bağlar ve sonucun AYNI kökende kaldığını doğrular (ikinci savunma hattı). Geçersizse kökün
 * kendisi döner; sonuç asla başka bir siteye işaret etmez.
 */
export function joinAppPath(origin: string, url: unknown): string {
  const safe = safeAppPath(url);
  try {
    const u = new URL(safe, origin);
    return u.origin === new URL(origin).origin ? u.toString() : `${origin}/`;
  } catch {
    return `${origin}/`;
  }
}
