import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SPELLCHECK_DICTIONARY_URL,
  hardenSession,
  hardenWebContents,
  isExternalHttp,
  isLoopbackOrigin,
  permissionAllowed,
  secureWebPreferences,
  type HardenableSession,
  type HardenableWebContents,
} from "../electron/hardening";

/** Faz 6 (paket G): Electron sertleştirmesi, sahte WebContents/Session ile (gerçek Electron gerekmez). */

const LOCAL = "http://127.0.0.1:4321";

function fakeWebContents() {
  const listeners = new Map<string, (...a: unknown[]) => void>();
  let openHandler: ((d: { url: string }) => { action: "deny" }) | null = null;
  const wc = {
    setWindowOpenHandler: (h: (d: { url: string }) => { action: "deny" }) => {
      openHandler = h;
    },
    on: (event: string, l: (...a: unknown[]) => void) => {
      listeners.set(event, l);
    },
    closeDevTools: vi.fn(),
  };
  const fire = (event: string, url?: string) => {
    const e = { preventDefault: vi.fn() };
    listeners.get(event)!(e, url);
    return e.preventDefault.mock.calls.length > 0;
  };
  return {
    wc: wc as unknown as HardenableWebContents,
    listeners,
    open: (url: string) => openHandler!({ url }),
    fire,
    closeDevTools: wc.closeDevTools,
  };
}

function setup(allowDevTools?: boolean) {
  const f = fakeWebContents();
  const openExternal = vi.fn();
  const log = vi.fn();
  hardenWebContents(f.wc, {
    isLocal: (u) => {
      try {
        return new URL(u).origin === LOCAL;
      } catch {
        return false;
      }
    },
    openExternal,
    log,
    ...(allowDevTools === undefined ? {} : { allowDevTools }),
  });
  return { ...f, openExternal, log };
}

describe("hardenWebContents", () => {
  it("yeni pencere hiç açılmaz; dış http(s) varsayılan tarayıcıya gider, diğer şemalar düşürülür", () => {
    const s = setup();
    expect(s.open("https://kafe.firma.com/menu")).toEqual({ action: "deny" });
    expect(s.openExternal).toHaveBeenCalledWith("https://kafe.firma.com/menu");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://host/share",
      "ms-settings:privacy",
      "https://user:pw@firma.com/",
      "bozuk adres",
      `${LOCAL}/settings`,
    ]) {
      s.openExternal.mockClear();
      expect(s.open(url)).toEqual({ action: "deny" });
      expect(s.openExternal, url).not.toHaveBeenCalled();
    }
  });

  it("gezinme yalnızca yerel kökende; dış http(s) tarayıcıya, dosya sürükle-bırak ve diğer şemalar engellenir", () => {
    const s = setup();
    expect(s.fire("will-navigate", `${LOCAL}/explore`)).toBe(false);
    expect(s.fire("will-navigate", "https://firma.com/")).toBe(true);
    expect(s.openExternal).toHaveBeenCalledWith("https://firma.com/");
    s.openExternal.mockClear();
    for (const url of [
      "file:///Users/x/Desktop/liste.csv",
      "javascript:void(0)",
      "data:text/html,x",
    ]) {
      expect(s.fire("will-navigate", url), url).toBe(true);
    }
    expect(s.openExternal).not.toHaveBeenCalled();
    // Aynı makinede başka bir bağlantı noktası yerel köken DEĞİLDİR.
    expect(s.fire("will-navigate", "http://127.0.0.1:9999/")).toBe(true);
  });

  it("yönlendirme yalnızca yerel kökende kalabilir; dış adrese yönlendirme tarayıcıya da açılmaz", () => {
    const s = setup();
    expect(s.fire("will-redirect", `${LOCAL}/setup`)).toBe(false);
    expect(s.fire("will-redirect", "https://evil.example.com/")).toBe(true);
    expect(s.openExternal).not.toHaveBeenCalled();
    // Günlüğe yol/sorgu yazılmaz.
    expect(s.log.mock.calls.flat().join(" ")).not.toContain("evil.example.com/");
  });

  it("<webview> eklenemez", () => {
    const s = setup();
    expect(s.fire("will-attach-webview")).toBe(true);
  });

  it("geliştirici araçları: izin yoksa açıldığı anda kapatılır, geliştirmede açık kalır", () => {
    const off = setup(false);
    off.listeners.get("devtools-opened")!();
    expect(off.closeDevTools).toHaveBeenCalledTimes(1);
    const on = setup(true);
    expect(on.listeners.has("devtools-opened")).toBe(false);
    // Varsayılan: paketli uygulamada (process.defaultApp tanımsız) kapalı.
    const d = (process as { defaultApp?: boolean }).defaultApp;
    delete (process as { defaultApp?: boolean }).defaultApp;
    try {
      expect(setup().listeners.has("devtools-opened")).toBe(true);
      (process as { defaultApp?: boolean }).defaultApp = true;
      expect(setup().listeners.has("devtools-opened")).toBe(false);
    } finally {
      if (d === undefined) delete (process as { defaultApp?: boolean }).defaultApp;
      else (process as { defaultApp?: boolean }).defaultApp = d;
    }
  });
});

describe("hardenSession", () => {
  function fakeSession() {
    const h: Record<string, (...a: never[]) => unknown> = {};
    const s = {
      setPermissionRequestHandler: (f: never) => (h.request = f),
      setPermissionCheckHandler: (f: never) => (h.check = f),
      setDevicePermissionHandler: (f: never) => (h.device = f),
      setSpellCheckerEnabled: vi.fn(),
      setSpellCheckerDictionaryDownloadURL: vi.fn(),
    };
    hardenSession(s as unknown as HardenableSession);
    return { s, h };
  }

  it("tüm izin istekleri ve denetimleri reddedilir; yalnızca yerel sayfanın panoya yazması serbest", () => {
    const { h } = fakeSession();
    const request = (permission: string, url?: string) => {
      let granted: boolean | undefined;
      (h.request as (...a: unknown[]) => void)(
        null,
        permission,
        (g: boolean) => (granted = g),
        url ? { requestingUrl: url } : undefined,
      );
      return granted;
    };
    const check = (permission: string, origin: string) =>
      (h.check as (...a: unknown[]) => boolean)(null, permission, origin, {});
    for (const p of [
      "media",
      "geolocation",
      "notifications",
      "midi",
      "openExternal",
      "clipboard-read",
      "fullscreen",
      "hid",
      "serial",
      "usb",
    ]) {
      expect(request(p, `${LOCAL}/`), p).toBe(false);
      expect(check(p, LOCAL), p).toBe(false);
    }
    expect(request("clipboard-sanitized-write", `${LOCAL}/explore`)).toBe(true);
    expect(check("clipboard-sanitized-write", LOCAL)).toBe(true);
    expect(request("clipboard-sanitized-write", "https://firma.com/")).toBe(false);
    expect(request("clipboard-sanitized-write")).toBe(false);
    expect(check("clipboard-sanitized-write", "https://maps.googleapis.com")).toBe(false);
    expect((h.device as () => boolean)()).toBe(false);
  });

  it("yazım denetimi kapalı ve sözlük indirme adresi yerel (Google CDN'e istek yok)", () => {
    const { s } = fakeSession();
    expect(s.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    expect(s.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith(SPELLCHECK_DICTIONARY_URL);
    expect(isLoopbackOrigin(SPELLCHECK_DICTIONARY_URL)).toBe(true);
  });

  it("eski Electron (isteğe bağlı yöntemler yok) çökmez", () => {
    const request = vi.fn();
    expect(() =>
      hardenSession({ setPermissionRequestHandler: request } as unknown as HardenableSession),
    ).not.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("yardımcılar", () => {
  it("isExternalHttp / isLoopbackOrigin / permissionAllowed", () => {
    expect(isExternalHttp("https://firma.com")).toBe(true);
    expect(isExternalHttp("http://firma.com")).toBe(true);
    expect(isExternalHttp("ftp://firma.com")).toBe(false);
    expect(isExternalHttp("https://a:b@firma.com")).toBe(false);
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:3000")).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.2")).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin("::")).toBe(false);
    expect(permissionAllowed("clipboard-sanitized-write", "http://127.0.0.1:1")).toBe(true);
    expect(permissionAllowed("clipboard-read", "http://127.0.0.1:1")).toBe(false);
  });
});

describe("secureWebPreferences", () => {
  it("paketli uygulama: yalıtım ve kum havuzu açık; yazım denetimi, webview, sürükle-bırak gezinmesi ve geliştirici araçları kapalı", () => {
    const p = secureWebPreferences(true);
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: false,
    });
    expect(secureWebPreferences(false).devTools).toBe(true);
  });
});

describe("pencere ayarları (electron/main.ts, statik)", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "GUVENLIK.md"), "utf8");
  /** main.ts `secureWebPreferences` ve `app.enableSandbox()` ile bağlandı mı (P0 entegrasyon adımı)? */
  const wired =
    /webPreferences:\s*\{[^}]*\.\.\.secureWebPreferences\(app\.isPackaged\)/.test(main) &&
    /app\.enableSandbox\(\)[\s\S]*app\.whenReady\(\)/.test(main);
  const PENDING = "[ENTEGRASYON BEKLİYOR: secureWebPreferences]";

  it("bağlam yalıtımı, kum havuzu, düğüm entegrasyonu kapalı, web güvenliği açık", () => {
    if (!wired) {
      expect(main).toMatch(/contextIsolation:\s*true/);
      expect(main).toMatch(/sandbox:\s*true/);
      expect(main).toMatch(/nodeIntegration:\s*false/);
      expect(main).toMatch(/webSecurity:\s*true/);
    }
    expect(main).not.toMatch(
      /nodeIntegrationInSubFrames:\s*true|allowRunningInsecureContent:\s*true/,
    );
    expect(main).not.toMatch(/webviewTag:\s*true|experimentalFeatures:\s*true/);
  });
  it("her WebContents ve varsayılan oturum sertleştirilir", () => {
    expect(main).toMatch(/app\.on\("web-contents-created"[\s\S]{0,80}hardenWebContents\(/);
    expect(main).toMatch(/hardenSession\(session\.defaultSession\)/);
  });
  it("secureWebPreferences ve app.enableSandbox() main.ts'e bağlı; bağlı değilse GUVENLIK.md bunu açıkça 'bekliyor' yazar", () => {
    // Paket G yardımcıyı yazdı; main.ts P0'a aittir. Bağlantı yapılana kadar bu açık unutulmasın: belge "bekliyor"
    // işaretini taşımak ZORUNDA; bağlandığında işaret kaldırılmalıdır (aksi hâlde test yine kırılır).
    if (wired) expect(doc).not.toContain(PENDING);
    else expect(doc).toContain(PENDING);
    // Kum havuzu çağrısı varsa pencere oluşturulmadan (whenReady'den) önce olmalıdır.
    if (/app\.enableSandbox\(\)/.test(main))
      expect(main.indexOf("app.enableSandbox()")).toBeLessThan(main.indexOf("app.whenReady()"));
  });
  it("geliştirici araçları menüsü yalnızca paketlenmemiş çalıştırmada", () => {
    expect(main).toMatch(/!app\.isPackaged \? \[\{ role: "toggleDevTools" \}\]/);
  });
});
