import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Faz 6 (sözleşme K.1): kurulum paketi yapılandırması. Paket yalnızca GitHub Actions'ta derlenir; burada derlemeden
 * doğrulanabilen her şey denetlenir:
 *   - electron-builder.config.cjs, electron-builder'ın KENDİ şemasıyla geçerli (yanlış yazılmış seçenek CI'ı bozmasın);
 *   - kimlik (appId, productName) electron/main.ts ile aynı (eskisinin üzerine kurulumda veri korunur);
 *   - imzalama ortam değişkenleri boşken imzasız (bugünkü davranış), doluyken imzalı/notarize;
 *   - NSIS seçenekleri ve build/installer.nsh korumaları (güncellemede ve sessiz kaldırmada veri silinmez; yalnızca
 *     uygulamanın veri klasörü silinir; varsayılan yanıt Hayır);
 *   - simge boyutu ve macOS yetkileri.
 */

const REPO = path.resolve(__dirname, "..");
const CONFIG = path.join(REPO, "electron-builder.config.cjs");
const req = createRequire(__filename);
const SIGN_VARS = [
  "CSC_LINK",
  "CSC_NAME",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "UM_WIN_EDIT_EXE",
] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(
  SIGN_VARS.map((k) => [k, process.env[k]]),
);
afterEach(() => {
  for (const k of SIGN_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Config = Record<string, any>;
/** Yapılandırmayı verilen ortamla, önbelleksiz yükler (dosya ortamı yüklenirken okur). */
function load(env: Partial<Record<(typeof SIGN_VARS)[number], string>> = {}): Config {
  for (const k of SIGN_VARS) delete process.env[k];
  Object.assign(process.env, env);
  delete req.cache[req.resolve(CONFIG)];
  return req(CONFIG) as Config;
}

/** electron-builder'ın kendi şema doğrulaması (çevrimdışı; paketleme yapmaz). */
async function validate(config: Config): Promise<void> {
  const { validateConfiguration } = req("app-builder-lib/out/util/config/config") as {
    validateConfiguration: (c: Config, logger: unknown) => Promise<void>;
  };
  const { DebugLogger } = req("builder-util") as { DebugLogger: new (on: boolean) => unknown };
  await validateConfiguration(structuredClone(config), new DebugLogger(false));
}

function pngSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe("electron-builder.config.cjs", () => {
  it("electron-builder şemasına uyar (imzasız ve imzalı ortamda); hatalı seçenek reddedilir", async () => {
    await validate(load());
    await validate(
      load({
        CSC_LINK: "base64-sertifika",
        APPLE_ID: "dev@firma.example",
        APPLE_APP_SPECIFIC_PASSWORD: "x",
        APPLE_TEAM_ID: "TEAM000000",
        WIN_CSC_LINK: "base64-sertifika",
      }),
    );
    await expect(validate({ ...load(), nsis: { bogusOption: true } })).rejects.toThrow(
      /configuration/i,
    );
  });

  it("kimlik electron/main.ts ile aynı (eskisinin üzerine kurulumda veriler korunur)", () => {
    const c = load();
    const main = fs.readFileSync(path.join(REPO, "electron", "main.ts"), "utf8");
    expect(c.appId).toBe("com.universalmail.app");
    expect(c.productName).toBe("Universal Mail");
    expect(main).toContain(`app.setName(${JSON.stringify(c.productName)})`);
    expect(main).toContain(`app.setAppUserModelId(${JSON.stringify(c.appId)})`);
    expect(c.nsis.shortcutName).toBe(c.productName);
    expect(c.nsis.uninstallDisplayName).toBe(c.productName);
  });

  it("ortam boşken imzasız: bugünkü davranış (sertifika aranmaz, notarize yok)", () => {
    const c = load();
    expect(c.mac.identity).toBeNull();
    expect(c.mac.hardenedRuntime).toBe(false);
    expect(c.mac.notarize).toBe(false);
    expect(c.win.signAndEditExecutable).toBe(false);
    expect(c.dmg.sign).toBe(false);
    // Boş dize de "yok" sayılır (CI'da tanımsız sır boş dize olarak gelir).
    const empty = load({ CSC_LINK: "", WIN_CSC_LINK: " ", APPLE_ID: "" });
    expect(empty.mac.identity).toBeNull();
    expect(empty.win.signAndEditExecutable).toBe(false);
  });

  it("macOS sertifikası verilince imzalı + sertleştirilmiş; notarize yalnızca üç Apple değişkeni birlikteyse", () => {
    const signed = load({ CSC_LINK: "base64-sertifika" });
    expect(signed.mac.identity).toBeUndefined();
    expect(signed.mac.hardenedRuntime).toBe(true);
    expect(signed.mac.notarize).toBe(false);
    expect(load({ CSC_NAME: "Developer ID Application: Firma" }).mac.identity).toBeUndefined();
    const partial = load({ CSC_LINK: "x", APPLE_ID: "dev@firma.example", APPLE_TEAM_ID: "T" });
    expect(partial.mac.notarize).toBe(false);
    const full = load({
      CSC_LINK: "x",
      APPLE_ID: "dev@firma.example",
      APPLE_APP_SPECIFIC_PASSWORD: "y",
      APPLE_TEAM_ID: "T",
    });
    expect(full.mac.notarize).toBe(true);
    // Sertifika olmadan Apple bilgileri tek başına notarize açmaz.
    expect(
      load({ APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b", APPLE_TEAM_ID: "c" }).mac.notarize,
    ).toBe(false);
    for (const c of [signed, full]) {
      expect(c.mac.entitlements).toBe("build/entitlements.mac.plist");
      expect(c.mac.entitlementsInherit).toBe("build/entitlements.mac.plist");
    }
  });

  it("Windows: WIN_CSC_LINK veya CSC_LINK ile imzalı; UM_WIN_EDIT_EXE=1 yalnızca simge/sürüm bilgisini açar", () => {
    expect(load({ WIN_CSC_LINK: "x" }).win.signAndEditExecutable).toBe(true);
    expect(load({ CSC_LINK: "x" }).win.signAndEditExecutable).toBe(true);
    expect(load({ UM_WIN_EDIT_EXE: "1" }).win.signAndEditExecutable).toBe(true);
    expect(load({ UM_WIN_EDIT_EXE: "0" }).win.signAndEditExecutable).toBe(false);
  });

  it("NSIS: kullanıcı başına, yönetici izni yok, kısayollar, kurulum sonrası çalıştır, veriler kendiliğinden silinmez", () => {
    const n = load().nsis;
    expect(n).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: "always",
      createStartMenuShortcut: true,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      include: "build/installer.nsh",
      installerLanguages: ["tr_TR", "en_US"],
      language: "1055",
    });
    expect(fs.existsSync(path.join(REPO, n.include))).toBe(true);
  });

  it("hedefler: macOS arm64 dmg, Windows x64 NSIS; paket içeriği değişmedi", () => {
    const c = load();
    expect(c.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    expect(c.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(c.files).toEqual(["dist/electron/**", "package.json"]);
    expect(c.extraResources.map((r: { to: string }) => r.to)).toEqual([
      "server",
      "server/node_modules",
    ]);
    expect(c.directories.output).toBe("release");
  });

  it("geliştiricinin yerel verisi (.data, .env, veritabanı, anahtar dosyaları) pakete girmez", () => {
    // Next'in dosya izleyicisi proje kökündeki .data/ ve .env* dosyalarını .next/standalone içine kopyalayabilir.
    const server = load().extraResources.find((r: { to: string }) => r.to === "server") as {
      from: string;
      filter: string[];
    };
    expect(server.from).toBe(".next/standalone");
    expect(server.filter[0]).toBe("**/*");
    for (const pattern of [
      "!node_modules/**",
      "!.data/**",
      "!.data-demo/**",
      "!**/.env",
      "!**/.env.*",
      "!**/*.db",
      "!**/*.db-wal",
      "!**/*.db-shm",
      "!**/master.key",
      "!**/secrets.json",
    ])
      expect(server.filter).toContain(pattern);
    // Paketin çalışması için gereken klasörler dışarıda bırakılmaz.
    for (const kept of [".next", "data", "drizzle"])
      expect(server.filter.some((f) => f === `!${kept}/**` || f === `!${kept}`)).toBe(false);
  });

  it("simge: 1024 px PNG (macOS için ≥ 512, Windows için ≥ 256), kare", () => {
    const c = load();
    for (const [os, min] of [
      ["mac", 512],
      ["win", 256],
    ] as const) {
      const size = pngSize(path.join(REPO, c[os].icon));
      expect(size.width, os).toBeGreaterThanOrEqual(min);
      expect(size.height, os).toBe(size.width);
    }
  });

  it("macOS yetkileri yalnızca JIT/yerel modül için gerekenler (ağ, kamera vb. yok)", () => {
    const plist = fs.readFileSync(path.join(REPO, "build", "entitlements.mac.plist"), "utf8");
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]);
  });
});

describe("build/installer.nsh (kaldırırken 'verilerimi de sil')", () => {
  const raw = fs.readFileSync(path.join(REPO, "build", "installer.nsh"));
  const src = raw.toString("utf8");
  const code = src
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(";"))
    .join("\n");

  it("UTF-8 BOM ile kaydedildi (NSIS Türkçe karakterleri doğru okusun)", () => {
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("customUnInstall makrosu: güncellemede (isUpdated) ve sessiz kaldırmada sorulmaz", () => {
    expect(code).toMatch(/!macro customUnInstall[\s\S]*!macroend/);
    const body = code.slice(code.indexOf("!macro customUnInstall"), code.indexOf("!macroend"));
    // isUpdated koruması her şeyi sarar; içinde ilk iş sessiz kipi atlamak.
    expect(body).toMatch(/\$\{ifNot\} \$\{isUpdated\}\s+IfSilent um_keep_data/);
    expect(body.trimEnd()).toMatch(/um_keep_data:\s+\$\{endIf\}$/);
    // Varsayılan düğme ve sessiz yanıt HAYIR.
    const boxes = body.match(/MessageBox [^\n]+/g) ?? [];
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b).toContain("MB_YESNO");
      expect(b).toContain("MB_DEFBUTTON2");
      expect(b).toContain("/SD IDNO");
      expect(b).toMatch(/IDYES um_delete_data IDNO um_keep_data$/);
    }
    // Türkçe (1055) ve İngilizce metin.
    expect(body).toContain('StrCmp $LANGUAGE "1055"');
    expect(boxes[0]).toContain("Verilerinizi de silmek istiyor musunuz?");
    expect(boxes[1]).toContain("Do you also want to delete your data?");
  });

  it("yalnızca uygulamanın veri klasörü silinir", () => {
    const deletes = code.match(/^\s*(RMDir|Delete)\b[^\n]*$/gm) ?? [];
    expect(deletes.map((l) => l.trim())).toEqual(['RMDir /r "$APPDATA\\Universal Mail"']);
    // Silme yalnızca onay etiketinden sonra ve tek yerde.
    expect(code.indexOf("um_delete_data:")).toBeLessThan(code.indexOf("RMDir /r"));
    expect(code).toContain("SetShellVarContext current");
    // Klasör adı ürün adıyla aynı (Electron userData = %APPDATA%\<productName>).
    expect(code).toContain(`$APPDATA\\${load().productName}`);
  });
});

describe("CI paket işi", () => {
  const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  it("imzalama sırları yalnızca 'Derle ve paketle' adımına ortam değişkeni olarak verilir", () => {
    const step = ci.slice(
      ci.indexOf("- name: Derle ve paketle"),
      ci.indexOf("- name: Paketlenmiş"),
    );
    for (const k of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
      "WIN_CSC_LINK",
      "WIN_CSC_KEY_PASSWORD",
    ])
      expect(step).toContain(`${k}: \${{ secrets.${k} }}`);
    // Sırlar başka hiçbir adımda kullanılmaz (ör. test adımlarına sızmaz).
    expect(ci.split("secrets.").length - 1).toBe(7);
  });
});
