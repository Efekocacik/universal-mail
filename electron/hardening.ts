/**
 * Faz 6 (paket G, NFR-02): pencere ve oturum sertleştirmesi.
 *
 * `hardenWebContents` her WebContents için (`app.on("web-contents-created")`):
 *  - yeni pencere hiçbir zaman açılmaz; dış http(s) bağlantıları varsayılan tarayıcıya gider, gerisi (file:, javascript:,
 *    özel şemalar) düşürülür;
 *  - `will-navigate` ve `will-redirect`: yalnızca uygulamanın yerel kökeni (sürüklenip bırakılan dosya da `file:` olarak
 *    buraya düşer ve engellenir);
 *  - `will-attach-webview`: `<webview>` hiçbir zaman eklenmez;
 *  - paketli uygulamada geliştirici araçları açılırsa hemen kapatılır.
 * `hardenSession` (varsayılan oturum):
 *  - izin İSTEKLERİ ve izin DENETİMLERİ reddedilir (kamera, mikrofon, konum, bildirim…); tek istisna yerel sayfanın
 *    "kopyala" düğmesi için panoya YAZMA (`clipboard-sanitized-write`, kullanıcı hareketi gerekir, okuma değildir);
 *  - aygıt (USB/HID/seri) izinleri reddedilir;
 *  - yazım denetimi kapatılır ve sözlük indirme adresi yerel, ulaşılamaz bir adrese çevrilir: Chromium aksi hâlde
 *    Windows/Linux'ta sözlükleri Google CDN'den indirir (geliştiriciye/üçüncü tarafa giden trafik, NFR-01).
 *
 * Bağımlılıklar enjekte edilir (gerçek Electron olmadan birim testi için: `tests/electron-hardening.test.ts`); türler
 * yapısaldır. Yeni yöntemler isteğe bağlıdır (`?.`), böylece eski bir Electron sürümü çökmez.
 */

/** `hardenWebContents`'in kullandığı WebContents alt kümesi. */
export interface HardenableWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (e: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-redirect", listener: (e: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-attach-webview", listener: (e: { preventDefault(): void }) => void): void;
  on(event: "devtools-opened", listener: () => void): void;
  closeDevTools?(): void;
}

export interface HardenWebContentsDeps {
  /** Adres uygulamanın kendi yerel kökeni mi? */
  isLocal: (url: string) => boolean;
  /** Dış http(s) bağlantısını varsayılan tarayıcıda aç. */
  openExternal: (url: string) => void;
  log: (message: string) => void;
  /**
   * Geliştirici araçlarına izin var mı? Verilmezse: yalnızca paketlenmemiş geliştirme çalıştırmasında (`electron .`,
   * `process.defaultApp === true`). Paketli uygulamada kapalıdır.
   */
  allowDevTools?: boolean;
}

/** Varsayılan tarayıcıda açılabilecek adres: yalnızca http(s), kimlik bilgisi içermeyen. */
export function isExternalHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Geliştirme çalıştırması mı (`electron .`)? Paketli uygulamada `process.defaultApp` tanımsızdır. */
export function isDevRun(): boolean {
  return (process as { defaultApp?: boolean }).defaultApp === true;
}

export function hardenWebContents(wc: HardenableWebContents, deps: HardenWebContentsDeps): void {
  const openOutside = (url: string, why: string) => {
    if (isExternalHttp(url) && !deps.isLocal(url)) deps.openExternal(url);
    else deps.log(`[güvenlik] ${why} engellendi: ${safeScheme(url)}`);
  };
  // Yeni pencere hiçbir zaman açılmaz; dış http(s) bağlantıları varsayılan tarayıcıya gider, gerisi düşürülür.
  wc.setWindowOpenHandler(({ url }) => {
    openOutside(url, "yeni pencere");
    return { action: "deny" };
  });
  // Uygulama penceresi yalnızca yerel kökende gezinir; dış http(s) tarayıcıya yönlendirilir.
  wc.on("will-navigate", (e, url) => {
    if (deps.isLocal(url)) return;
    e.preventDefault();
    openOutside(url, "gezinme");
  });
  // Sunucu yönlendirmesi de aynı kurala tabidir (yerel sayfa dış bir adrese yönlendiremez).
  wc.on("will-redirect", (e, url) => {
    if (deps.isLocal(url)) return;
    e.preventDefault();
    deps.log(`[güvenlik] yönlendirme engellendi: ${safeScheme(url)}`);
  });
  wc.on("will-attach-webview", (e) => {
    e.preventDefault();
    deps.log("[güvenlik] webview eklenmesi engellendi");
  });
  const allowDevTools = deps.allowDevTools ?? isDevRun();
  if (!allowDevTools) {
    wc.on("devtools-opened", () => {
      wc.closeDevTools?.();
      deps.log("[güvenlik] geliştirici araçları kapatıldı (paketli uygulama)");
    });
  }
}

/** Günlüğe yalnızca şema ve ana bilgisayar yazılır (yol, sorgu ve kişisel veri yazılmaz). */
function safeScheme(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:"
      ? `${u.protocol}//${u.host}`
      : u.protocol;
  } catch {
    return "geçersiz-adres";
  }
}

/** İzin isteğinin ayrıntısı (Electron `details`); yalnızca kullandığımız alanlar. */
interface PermissionDetails {
  requestingUrl?: string;
}

/** `hardenSession`'ın kullandığı Session alt kümesi. */
export interface HardenableSession {
  setPermissionRequestHandler(
    handler: (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details?: PermissionDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler?(
    handler: (
      wc: unknown,
      permission: string,
      requestingOrigin: string,
      details?: unknown,
    ) => boolean,
  ): void;
  setDevicePermissionHandler?(handler: (details: unknown) => boolean): void;
  setSpellCheckerEnabled?(enabled: boolean): void;
  setSpellCheckerDictionaryDownloadURL?(url: string): void;
}

/** Yalnızca yerel sayfanın panoya YAZMASINA izin verilir ("kopyala" düğmesi). */
const ALLOWED_LOCAL_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Sözlük indirme adresi: yerel ve kapalı bir bağlantı noktası (yazım denetimi zaten kapalı; çifte güvence). */
export const SPELLCHECK_DICTIONARY_URL = "http://127.0.0.1:9/";

export function isLoopbackOrigin(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function permissionAllowed(permission: string, origin: string | undefined): boolean {
  return ALLOWED_LOCAL_PERMISSIONS.has(permission) && isLoopbackOrigin(origin);
}

export function hardenSession(session: HardenableSession): void {
  // Kamera, mikrofon, konum, bildirim izni vb. hiçbir izin istenmez/verilmez (pano yazma istisnası yukarıda).
  session.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(permissionAllowed(permission, details?.requestingUrl)),
  );
  session.setPermissionCheckHandler?.((_wc, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin),
  );
  session.setDevicePermissionHandler?.(() => false);
  session.setSpellCheckerEnabled?.(false);
  session.setSpellCheckerDictionaryDownloadURL?.(SPELLCHECK_DICTIONARY_URL);
}

/**
 * Ana pencerenin güvenli `webPreferences` değerleri. `electron/main.ts` (P0'a ait) bunları `createWindow` içinde
 * yaymalıdır (`webPreferences: { preload, ...secureWebPreferences(app.isPackaged) }`); bugünkü main.ts ilk dört değeri
 * zaten elle verir, geri kalanlar (yazım denetimi, sürükle-bırak gezinmesi, webview, paketli uygulamada geliştirici
 * araçları) burada toplanır. `hardenSession` ve `hardenWebContents` aynı korumaları oturum/olay düzeyinde de uygular
 * (çifte güvence: biri unutulsa bile diğeri tutar).
 */
export function secureWebPreferences(isPackaged: boolean) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    // Chromium yazım denetimi Windows/Linux'ta sözlüğü Google CDN'den indirir (NFR-01).
    spellcheck: false,
    // Pencereye bırakılan dosya/bağlantı sayfayı terk ettirmez.
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !isPackaged,
  } as const;
}
