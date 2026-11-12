import { describe, expect, it } from "vitest";
import { LOG_KEEP, LOG_MAX_BYTES, rotateIfLarge, type LogFsPorts } from "../electron/logs";
import {
  DEFAULT_UI_PREFS,
  loginItemSupported,
  parseStoredPrefs,
  themeSourceFor,
  validateUiPrefsPatch,
} from "../electron/ui-prefs";

/** Faz 4 (10a-4, M4, M9): ana süreç tercihleri ve günlük döndürme — Electron'suz saf işlevler. */
describe("electron/ui-prefs: IPC girdisi güvenilmez", () => {
  it("yalnızca bilinen alan ve değerler alınır; gerisi reddedilir", () => {
    expect(validateUiPrefsPatch({ theme: "dark", language: "en", openAtLogin: true })).toEqual({
      patch: { theme: "dark", language: "en", openAtLogin: true },
      rejected: [],
    });
    const r = validateUiPrefsPatch({
      theme: "neon",
      language: "de",
      openAtLogin: "yes",
      __proto__x: 1,
      ["x".repeat(100)]: 1,
    });
    expect(r.patch).toEqual({});
    expect(r.rejected).toHaveLength(5);
    expect(r.rejected.every((k) => k.length <= 40)).toBe(true);
  });

  it("nesne olmayan gövde reddedilir", () => {
    for (const bad of [null, undefined, "dark", 1, ["theme"]])
      expect(validateUiPrefsPatch(bad)).toEqual({ patch: {}, rejected: ["(gövde)"] });
  });

  it("dosyadan okuma: bozuk/eksik/eski içerik varsayılanlara düşer", () => {
    expect(parseStoredPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseStoredPrefs("{bozuk")).toEqual(DEFAULT_UI_PREFS);
    expect(parseStoredPrefs('{"theme":"dark","eski":1}')).toEqual({
      ...DEFAULT_UI_PREFS,
      theme: "dark",
    });
    // Varsayılan nesne değiştirilemez (her çağrı yeni kopya).
    const a = parseStoredPrefs(null);
    a.theme = "dark";
    expect(DEFAULT_UI_PREFS.theme).toBe("system");
  });

  it("oturum öğesi yalnızca paketli macOS/Windows'ta", () => {
    expect(loginItemSupported("darwin", true)).toBe(true);
    expect(loginItemSupported("win32", true)).toBe(true);
    expect(loginItemSupported("linux", true)).toBe(false);
    expect(loginItemSupported("darwin", false)).toBe(false);
    expect(themeSourceFor("system")).toBe("system");
  });
});

describe("electron/logs: günlük döndürme (M9)", () => {
  function fakeFs(sizes: Record<string, number>) {
    const files = new Map(Object.entries(sizes));
    const ops: string[] = [];
    const ports: LogFsPorts = {
      size: (p) => files.get(p) ?? null,
      rename: (a, b) => {
        ops.push(`mv ${a} ${b}`);
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      remove: (p) => {
        ops.push(`rm ${p}`);
        files.delete(p);
      },
    };
    return { files, ops, ports };
  }

  it("sınırın altında dokunmaz", () => {
    const f = fakeFs({ "app.log": LOG_MAX_BYTES });
    expect(rotateIfLarge("app.log", f.ports)).toBe(false);
    expect(f.ops).toEqual([]);
    expect(rotateIfLarge("yok.log", f.ports)).toBe(false);
  });

  it("sınırı aşınca app.log → .1 → .2; en eski silinir", () => {
    const f = fakeFs({ "app.log": LOG_MAX_BYTES + 1, "app.log.1": 10, "app.log.2": 20 });
    expect(rotateIfLarge("app.log", f.ports)).toBe(true);
    expect(f.ops).toEqual(["rm app.log.2", "mv app.log.1 app.log.2", "mv app.log app.log.1"]);
    expect([...f.files.keys()].sort()).toEqual(["app.log.1", "app.log.2"]);
    expect(LOG_KEEP).toBe(2);
  });

  it("ilk döndürmede eski dosyalar yoksa yalnızca yeniden adlandırır", () => {
    const f = fakeFs({ "w.log": 11 });
    expect(rotateIfLarge("w.log", f.ports, 10, 3)).toBe(true);
    expect(f.ops).toEqual(["mv w.log w.log.1"]);
  });

  it("dosya sistemi hatası uygulamayı etkilemez", () => {
    const ports: LogFsPorts = {
      size: () => 99,
      rename: () => {
        throw new Error("EACCES");
      },
      remove: () => undefined,
    };
    expect(rotateIfLarge("a.log", ports, 10)).toBe(false);
  });
});
