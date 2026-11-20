import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    expect(c.win.signExecutable).toBe(false);
    expect(c.dmg.sign).toBe(false);
    // Boş dize de "yok" sayılır (CI'da tanımsız sır boş dize olarak gelir).
    const empty = load({ CSC_LINK: "", WIN_CSC_LINK: " ", APPLE_ID: "" });
    expect(empty.mac.identity).toBeNull();
    expect(empty.win.signExecutable).toBe(false);
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

  it("Windows: simge/sürüm bilgisi HER ZAMAN gömülür; imzalama yalnızca WIN_CSC_LINK veya CSC_LINK ile", () => {
    // electron-builder 26: signAndEditExecutable=false hem imzalamayı hem simgeyi kapatır; signExecutable=false yalnızca
    // imzalamayı. İmzasız derlemede .exe ve kısayollar Electron simgesini taşımasın.
    for (const env of [{}, { WIN_CSC_LINK: "x" }, { CSC_LINK: "x" }])
      expect(load(env).win.signAndEditExecutable).toBe(true);
    expect(load().win.signExecutable).toBe(false);
    expect(load({ WIN_CSC_LINK: "x" }).win.signExecutable).toBe(true);
    expect(load({ CSC_LINK: "x" }).win.signExecutable).toBe(true);
    // Kurulu electron-builder sürümü bu ayrımı gerçekten yapıyor (sürüm yükseltmesinde anlam değişirse test kırılır).
    const winPackager = fs.readFileSync(req.resolve("app-builder-lib/out/winPackager.js"), "utf8");
    expect(winPackager).toMatch(
      /signExecutable === false\) \{\s+builder_util_1\.log\.info\(logFields, "file signing skipped/,
    );
    const signApp = winPackager.slice(winPackager.indexOf("async signApp("));
    // Kaynak düzenlemeyi atlayan TEK koşul signAndEditExecutable === false'tur.
    expect(signApp.slice(0, signApp.indexOf("signAndEditResources("))).not.toMatch(
      /signExecutable === false\) \{\s+builder_util_1\.log\.info\(\{ exe/,
    );
  });

  it("CI kontrolü: ürün adı .exe sürüm bilgisinde UTF-16 olarak aranır", async () => {
    const { hasEmbeddedProductName } = (await import(
      pathToFileURL(path.join(REPO, "scripts", "check-win-exe.mjs")).href
    )) as {
      hasEmbeddedProductName: (b: Buffer, n: string) => boolean;
    };
    const versionInfo = (name: string) =>
      Buffer.concat([
        Buffer.from([0x30, 0x00, 0x0d, 0x00, 0x01, 0x00]),
        Buffer.from(`ProductName\0\0${name}\0`, "utf16le"),
      ]);
    expect(hasEmbeddedProductName(versionInfo("Universal Mail"), "Universal Mail")).toBe(true);
    expect(hasEmbeddedProductName(versionInfo("Electron"), "Universal Mail")).toBe(false);
    // Düz ASCII (ör. asar içeriği) sayılmaz.
    expect(
      hasEmbeddedProductName(Buffer.from("ProductName Universal Mail"), "Universal Mail"),
    ).toBe(false);
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/if: runner\.os == 'Windows'\s+run: node scripts\/check-win-exe\.mjs/);
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

  it("hedefler: macOS arm64 dmg + zip (aynı derleme), Windows x64 NSIS; paket içeriği değişmedi", () => {
    const c = load();
    // Varsayılan arm64; x64 yalnızca UM_MAC_ARCH ile (aşağıdaki test). Universal yok.
    expect(c.mac.target).toEqual([
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ]);
    expect(c.artifactName).toBe("Universal-Mail-${version}-${os}-${arch}.${ext}");
    expect(c.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(c.files).toEqual(["dist/electron/**", "package.json"]);
    expect(c.extraResources.map((r: { to: string }) => r.to)).toEqual([
      "server",
      "server/node_modules",
    ]);
    expect(c.directories.output).toBe("release");
  });

  it("geliştiricinin yerel verisi pakete girmez: süzgeç gerçek klasör ağacına electron-builder eşleyicisiyle uygulanır", () => {
    // Next'in dosya izleyicisi proje kökündeki .data*/ ve .env* dosyalarını .next/standalone içine kopyalayabilir.
    const server = load().extraResources.find((r: { to: string }) => r.to === "server") as {
      from: string;
      filter: string[];
    };
    expect(server.from).toBe(".next/standalone");
    expect(server.filter[0]).toBe("**/*");
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-pack-"));
    try {
      const shipped = [
        "server.js",
        "package.json",
        "migrate.cjs",
        ".next/server/app/page.js",
        ".next/server/app/api/backups/route.js",
        ".next/static/chunks/main.js",
        "drizzle/0000_init.sql",
        "drizzle/meta/_journal.json",
        "data/cities.eu-tr.json",
        "data/ATTRIBUTION.md",
        "public/icon.svg",
      ];
      const leaked = [
        "node_modules/x/index.js",
        ".data/universal-mail.db",
        ".data/master.key",
        ".data/secrets.json",
        ".data/ui-prefs.json",
        ".data-demo/universal-mail.db",
        ".data-arsiv-2026-10-18-demo/notes.json",
        ".data-x/logs/main.log",
        ".data-x/export.csv",
        ".env",
        ".env.local",
        "data/backups/x.umbk",
        "data/backups/pre-migrate-2026.db",
        "data/backups/export.json",
        "data/export-leads.csv",
        "data/master.key.enc",
        "data/logs/main.log",
        "data/ui-prefs.json",
        "yedek/x.umbk",
        "sub/master.key.enc",
        "sub/app.db-wal",
      ];
      for (const rel of [...shipped, ...leaked]) {
        const p = path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
      const { FileMatcher } = req("app-builder-lib/out/fileMatcher") as {
        FileMatcher: new (
          from: string,
          to: string,
          expand: (s: string) => string,
          patterns: string[],
        ) => { createFilter: () => (file: string, stat: fs.Stats) => boolean };
      };
      const filter = new FileMatcher(root, "server", (x) => x, server.filter).createFilter();
      // electron-builder'ın kopyalama yürüyüşü gibi: süzgeçten geçmeyen klasöre girilmez.
      const included: string[] = [];
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          if (!filter(p, st)) continue;
          if (st.isDirectory()) walk(p);
          else included.push(path.relative(root, p).split(path.sep).join("/"));
        }
      };
      walk(root);
      expect(included.sort()).toEqual([...shipped].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("platform ve mimari", () => {
  const withEnv = (v: string | undefined, fn: () => void) => {
    const old = process.env.UM_MAC_ARCH;
    if (v === undefined) delete process.env.UM_MAC_ARCH;
    else process.env.UM_MAC_ARCH = v;
    try {
      fn();
    } finally {
      if (old === undefined) delete process.env.UM_MAC_ARCH;
      else process.env.UM_MAC_ARCH = old;
    }
  };

  it("UM_MAC_ARCH: varsayılan arm64, x64 seçilebilir; geçersiz değer (ör. universal) derlemeyi durdurur", () => {
    withEnv(undefined, () => expect(load().mac.target[0].arch).toEqual(["arm64"]));
    if (process.platform !== "darwin")
      withEnv("x64", () => {
        const c = load();
        expect(c.mac.target).toEqual([
          { target: "dmg", arch: ["x64"] },
          { target: "zip", arch: ["x64"] },
        ]);
        expect(c.artifactName).toContain("${arch}");
      });
    withEnv("universal", () => expect(() => load()).toThrow(/desteklenmiyor/));
    withEnv("ia32", () => expect(() => load()).toThrow(/desteklenmiyor/));
  });

  it("Windows paketi yalnızca x64'tür (libsql Windows ARM64 ikilisi yok); mimari uyuşmazlığı yalnızca ilgili ana bilgisayarda durdurur", () => {
    expect(load().win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    // Gerekçe kanıtı: kilit dosyasında libsql için Windows ARM64 ikilisi yok (x64 ve macOS ikilileri var).
    expect(lock.packages["node_modules/@libsql/win32-arm64-msvc"]).toBeUndefined();
    for (const p of ["win32-x64-msvc", "darwin-x64", "darwin-arm64"])
      expect(lock.packages[`node_modules/@libsql/${p}`], p).toBeDefined();
  });
});

describe("CI paket işi", () => {
  // CRLF/LF farkından bağımsız (Windows çalışma kopyası satır sonlarını dönüştürebilir).
  const ci = fs
    .readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  /** Bir işin metni: "  <ad>:" satırından bir sonraki iş başlığına kadar. */
  const job = (name: string): string => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect(start, `${name} işi yok`).toBeGreaterThan(-1);
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  /** Bir adımın metni: "- name: <ad>" satırından bir sonraki adıma ("      - ") kadar. */
  const step = (jobText: string, name: string): string => {
    const i = jobText.indexOf(`- name: ${name}`);
    expect(i, `${name} adımı yok`).toBeGreaterThan(-1);
    const rest = jobText.slice(i);
    const next = rest.slice(1).search(/\n {6}- /);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  const APPLE = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ];

  it("normal dal işleri imzalama sırlarına ERİŞEMEZ: sırlar yalnızca imzalı paket işinde, iki adımda geçer", () => {
    // Sır başvurusu yalnızca `package-signed` işinde; diğer hiçbir işte (checks, e2e, package, release) yok.
    for (const j of ["checks", "e2e", "package", "release"])
      expect(job(j), `${j} işinde sır başvurusu olmamalı`).not.toContain("secrets.");
    const signed = job("package-signed");
    expect(ci.split("secrets.").length - 1).toBe(2 * APPLE.length);
    expect(signed.split("secrets.").length - 1).toBe(2 * APPLE.length);
    // Yalnızca Apple sırları (Windows imza sırrı CI'da yok); depo düzeyi genel `env:` veya iş düzeyi sır yok.
    expect(ci).not.toContain("WIN_CSC");
    expect(ci.slice(0, ci.indexOf("\njobs:\n"))).not.toContain("secrets.");
    for (const k of APPLE) {
      expect(step(signed, "İmzalama sırları tanımlı mı (değerler yazdırılmaz)")).toContain(
        `${k}: \${{ secrets.${k} }}`,
      );
      expect(step(signed, "Derle, imzala ve notarize et")).toContain(`${k}: \${{ secrets.${k} }}`);
    }
    // `npm ci` (üçüncü taraf kurulum betikleri) ve diğer adımlar sırları görmez.
    const afterCi = signed.slice(signed.indexOf("- run: npm ci"));
    const secretSteps = afterCi.split(/\n {6}- /).filter((s) => s.includes("secrets."));
    expect(secretSteps).toHaveLength(2);
    // Sırlar günlüğe yazdırılmaz: yalnızca varlık denetimi (değer yankısı yok).
    const check = step(signed, "İmzalama sırları tanımlı mı (değerler yazdırılmaz)");
    expect(check).toContain('[ -z "${!v}" ]');
    expect(check).not.toMatch(/echo[^\n]*\$\{?(CSC_|APPLE_)/);
  });

  it("imzalı paket işi: yalnızca sürüm etiketinde, korumalı 'release-signing' Environment'ıyla, imza eksikse BAŞARISIZ", () => {
    const signed = job("package-signed");
    expect(signed).toContain("environment: release-signing");
    expect(signed).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    // Her iki Mac mimarisi desteklenmeye devam eder; Windows bu işte yok (imzasız `package` işinde).
    expect(signed).toMatch(/os: macos-26, name: macOS-arm64[^}]*macArch: arm64/);
    expect(signed).toMatch(/os: macos-26-intel, name: macOS-x64[^}]*macArch: x64/);
    expect(signed).not.toContain("windows");
    expect(signed).toContain("UM_MAC_ARCH: ${{ matrix.macArch }}");
    // Sırlar eksikse sessizce imzasız üretilmez: iş hata verir.
    expect(step(signed, "İmzalama sırları tanımlı mı (değerler yazdırılmaz)")).toContain("exit 1");
    // Zorunlu doğrulama (koşulsuz): imza, sertleştirilmiş çalışma zamanı, Gatekeeper, notarization bileti.
    const verify = step(signed, "macOS imza ve notarization doğrulaması");
    expect(verify).not.toContain("if:");
    for (const c of [
      "codesign --verify --deep --strict",
      "runtime",
      "spctl --assess --type execute",
      "xcrun stapler validate",
    ])
      expect(verify).toContain(c);
    // İmzasız paket işi etiket dışında da çalışır ve hiçbir imza değişkeni içermez.
    const unsigned = job("package");
    expect(unsigned).not.toContain("if: startsWith(github.ref, 'refs/tags/v')\n    needs");
    expect(unsigned).not.toContain("environment:");
    for (const k of [...APPLE, "HAS_MAC_SIGNING"]) expect(unsigned).not.toContain(k);
  });

  it("teslimat: DMG+ZIP aynı işte, SHA-256 aynı derlemeden, Release yalnızca imzalı macOS + Windows ve yalnızca TASLAK", () => {
    expect(ci).toContain('exts: "dmg,zip"');
    // macOS: arm64 (macos-26) ve x64 (macos-26-intel) AYRI makinelerde, kendi yerel modülleriyle derlenir.
    const unsigned = job("package");
    expect(unsigned).toMatch(/os: macos-26, name: macOS-arm64[^}]*macArch: arm64/);
    expect(unsigned).toMatch(/os: macos-26-intel, name: macOS-x64[^}]*macArch: x64/);
    expect(unsigned).toMatch(/os: windows-2025, name: Windows-x64/);
    // Özet, derlemeden hemen sonra AYNI işte üretilir ve dosyalarla birlikte yüklenir (her iki paket işinde).
    for (const j of [unsigned, job("package-signed")]) {
      expect(j).toContain("node scripts/make-checksums.mjs teslimat");
      expect(j.indexOf("Teslimat dosyalarını topla")).toBeGreaterThan(j.indexOf("npm run dist"));
      expect(j.indexOf("path: teslimat/")).toBeGreaterThan(j.indexOf("make-checksums.mjs"));
    }
    // Release işi yeniden DERLEMEZ, özetleri doğrular, YALNIZCA imzalı macOS ve Windows artifact'larını alır.
    const release = job("release");
    expect(release).not.toContain("npm run");
    expect(release).toContain("needs: [package, package-signed]");
    expect(release).toContain("pattern: kurulum-imzali-*");
    expect(release).toContain("pattern: kurulum-Windows-*");
    expect(release).not.toMatch(/pattern: kurulum-(macOS|\*)/);
    expect(release).toContain("sha256sum -c");
    expect(release).toContain("--draft");
    expect(release).not.toMatch(/gh release (edit|publish)|--draft=false|--latest/);
    // Etiket ile package.json sürümü tutarlı olmalı (her iki paket işinde).
    expect(ci.split('if [ "$TAG" != "v$ver" ]').length - 1).toBe(2);
  });
});
