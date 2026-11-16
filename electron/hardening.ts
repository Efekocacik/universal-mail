/**
 * Faz 6 (P0.6; sahibi: paket G): pencere ve oturum sertleştirmesi. `electron/main.ts`'ten birebir taşındı; davranış
 * aynıdır. Paket G burada will-redirect, will-attach-webview, izin DENETİM işleyicisi, aygıt izinleri, yazım denetimi
 * (sözlük indirmesi) ve benzerlerini ekler.
 *
 * Bağımlılıklar enjekte edilir (gerçek Electron olmadan birim testi için); türler yapısaldır.
 */

/** `hardenWebContents`'in kullandığı WebContents alt kümesi. */
export interface HardenableWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (e: { preventDefault(): void }, url: string) => void): void;
}

export interface HardenWebContentsDeps {
  /** Adres uygulamanın kendi yerel kökeni mi? */
  isLocal: (url: string) => boolean;
  /** Dış http(s) bağlantısını varsayılan tarayıcıda aç. */
  openExternal: (url: string) => void;
  log: (message: string) => void;
}

const isHttp = (url: string) => /^https?:/i.test(url);

export function hardenWebContents(wc: HardenableWebContents, deps: HardenWebContentsDeps): void {
  // Yeni pencere hiçbir zaman açılmaz; dış http(s) bağlantıları varsayılan tarayıcıya gider, gerisi düşürülür.
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttp(url) && !deps.isLocal(url)) deps.openExternal(url);
    return { action: "deny" };
  });
  // Uygulama penceresi yalnızca yerel kökende gezinir; dış http(s) tarayıcıya yönlendirilir.
  wc.on("will-navigate", (e, url) => {
    if (!deps.isLocal(url)) {
      e.preventDefault();
      if (isHttp(url)) deps.openExternal(url);
    }
  });
}

/** `hardenSession`'ın kullandığı Session alt kümesi. */
export interface HardenableSession {
  setPermissionRequestHandler(
    handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
}

export function hardenSession(session: HardenableSession): void {
  // Kamera, mikrofon, konum, bildirim izni vb. hiçbir izin istenmez/verilmez.
  session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
}
