/**
 * electron-builder yapılandırması (Faz 6; sahibi: paket K). Ayrıntılı açıklama: docs/PAKETLEME.md.
 *
 * Kimlik: `appId` ve `productName` electron/main.ts'teki `app.setName` / AppUserModelId ile AYNI kalmalıdır. Eski
 * sürümün üzerine kurulumda kullanıcı verileri (`%APPDATA%\Universal Mail`, `~/Library/Application Support/Universal
 * Mail`) bu kimlik sayesinde korunur. tests/packaging-config.test.ts bunu denetler.
 *
 * İmzalama İSTEĞE BAĞLIDIR ve varsayılan olarak KAPALIDIR: ortam değişkenleri boşsa paket bugünkü gibi imzasız üretilir.
 *   - macOS: `CSC_LINK` (veya `CSC_NAME`) varsa Developer ID ile imzalanır (sertleştirilmiş çalışma zamanı + yetkiler);
 *     `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` ve `APPLE_TEAM_ID` üçü birden varsa ayrıca notarize edilir.
 *   - Windows: `WIN_CSC_LINK` (veya `CSC_LINK`) varsa yürütülebilir dosya ve kurulum programı imzalanır.
 * Ortam değişkenleri yalnızca bu dosya yüklenirken okunur; değerleri hiçbir yere yazılmaz.
 */
const env = process.env;
const has = (name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * Hedef mimari. macOS: `UM_MAC_ARCH` = `arm64` (varsayılan, Apple Silicon) veya `x64` (Intel). Yerel modül (libsql)
 * mimariye özgüdür ve paket, o mimarinin kendi makinesinde (CI: arm64 → macos-26, x64 → macos-26-intel) derlenir;
 * ana bilgisayar mimarisi hedefle uyuşmuyorsa derleme DURUR (yanlış mimarili yerel modülle sessizce paket üretilmez).
 * Windows: yalnızca x64. libsql'in Windows ARM64 yerel ikilisi YOKTUR (npm'de `@libsql/win32-arm64-msvc` yok), bu
 * yüzden ARM64 Windows'ta yerel paket üretilmez; Windows 11 ARM bilgisayarlar x64 paketini x64 öykünmesiyle çalıştırır
 * (docs/PAKETLEME.md "Platform desteği").
 */
const macArch = (env.UM_MAC_ARCH || "arm64").trim();
if (macArch !== "arm64" && macArch !== "x64") {
  throw new Error(`UM_MAC_ARCH "${macArch}" desteklenmiyor: yalnızca arm64 veya x64.`);
}
if (process.platform === "darwin" && macArch !== process.arch) {
  throw new Error(
    `macOS ${macArch} paketi ${process.arch} makinesinde derlenemez: yerel modüller (libsql) hedef mimariyle eşleşmeli.`,
  );
}
if (process.platform === "win32" && process.arch !== "x64") {
  throw new Error(
    "Windows ARM64'te yerel paket desteklenmiyor (libsql için win32-arm64 ikilisi yok). x64 paketini kullanın.",
  );
}

const macSigning = has("CSC_LINK") || has("CSC_NAME");
const macNotarize =
  macSigning && has("APPLE_ID") && has("APPLE_APP_SPECIFIC_PASSWORD") && has("APPLE_TEAM_ID");
const winSigning = has("WIN_CSC_LINK") || has("CSC_LINK");

/**
 * Geliştiricinin yerel verisi pakete GİRMEMELİ. Next'in dosya izleyicisi (output file tracing) proje kökündeki `.data/`
 * klasörünü (geliştirme veritabanı, `master.key`, `secrets.json`) ve `.env*` dosyalarını `.next/standalone` içine
 * kopyalayabilir; yerelde `npm run dist` çalıştırıldığında bunlar kurulum paketine taşınırdı. CI temiz checkout'tan
 * derlediği için orada bu dosyalar yoktur; bu süzgeç yerel derlemeyi de güvenli kılar (tests/packaging-config.test.ts
 * süzgeci electron-builder'ın kendi eşleyicisiyle gerçek bir klasör ağacına uygular).
 *
 * İki katman:
 *   1. Kara liste (her yerde): `.data*` adlı HER klasör (`.data`, `.data-demo`, `.data-arsiv-…`), `.env*`, SQLite
 *      dosyaları, `master.key*`, `secrets.json`, şifreli yedekler (`*.umbk`).
 *   2. İzin listesi (`data/`): izleyicinin taşıdığı statik veri klasöründen YALNIZCA bilinen dosyalar girer
 *      (`staticDataDir()` yalnızca şehir listesini okur). `data/backups/`, dışa aktarımlar, günlükler vb. girmez.
 * Sıra önemlidir: electron-builder kalıpları sırayla uygular; izin listesi en sonda olmalıdır.
 */
const STATIC_DATA_FILES = ["data/cities.eu-tr.json", "data/ATTRIBUTION.md"];
const DEVELOPER_DATA_EXCLUDES = [
  "!.data*",
  "!.data*/**",
  "!**/.env",
  "!**/.env.*",
  "!**/*.db",
  "!**/*.db-wal",
  "!**/*.db-shm",
  "!**/*.db-journal",
  "!**/master.key*",
  "!**/secrets.json",
  "!**/*.umbk",
  "!data/**",
  ...STATIC_DATA_FILES,
];

module.exports = {
  appId: "com.universalmail.app",
  productName: "Universal Mail",
  copyright: "Copyright © 2026",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/electron/**", "package.json"],
  asar: true,
  // Next.js standalone sunucusu, işçi ve şema geçişi paketleri, migrasyonlar ve şehir verisi tek klasörde (server) taşınır.
  extraResources: [
    {
      from: ".next/standalone",
      to: "server",
      filter: ["**/*", "!node_modules/**", ...DEVELOPER_DATA_EXCLUDES],
    },
    // electron-builder "node_modules" adını varsayılan olarak dışarıda bıraktığından ayrıca, açıkça kopyalanır.
    {
      from: ".next/standalone/node_modules",
      to: "server/node_modules",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.business",
    // DMG (ana) ve ZIP (alternatif) AYNI derlemenin çıktısıdır. Mimari: `UM_MAC_ARCH` (varsayılan arm64); universal
    // derleme YOKTUR (yerel modüller mimariye özgü, her mimari kendi makinesinde derlenir).
    target: [
      { target: "dmg", arch: [macArch] },
      { target: "zip", arch: [macArch] },
    ],
    // 1024×1024 PNG; electron-builder .icns dosyasını kendisi üretir.
    icon: "build/icon.png",
    // `null` = imzalama yok (bugünkü davranış); `undefined` = electron-builder sertifikayı CSC_LINK/CSC_NAME'den bulur.
    identity: macSigning ? undefined : null,
    hardenedRuntime: macSigning,
    gatekeeperAssess: false,
    // libsql yerel modülü ve Node alt süreçleri (sunucu, işçi) sertleştirilmiş çalışma zamanında bu yetkileri ister.
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: macNotarize,
  },
  dmg: {
    title: "Universal Mail",
    sign: false,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // 1024×1024 PNG; electron-builder .ico dosyasını (256 px dahil) kendisi üretir.
    icon: "build/icon.png",
    // .exe kaynak düzenleme (simge, ürün adı/sürüm bilgisi) HER ZAMAN açık; imzalama yalnızca sertifika varsa. (Eskiden
    // `signAndEditExecutable: false` ikisini birden kapatıyordu: imzasız .exe ve kısayollar Electron simgesini taşıyordu.)
    // CI Windows işi `scripts/check-win-exe.mjs` ile ürün adının .exe'ye gömüldüğünü doğrular.
    signAndEditExecutable: true,
    signExecutable: winSigning,
  },
  nsis: {
    // Kullanıcı başına kurulum: yönetici izni istemez, veriler kullanıcının %APPDATA% klasöründe kalır.
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "Universal Mail",
    runAfterFinish: true,
    // Veriler kendiliğinden SİLİNMEZ; kaldırırken "verilerimi de sil" sorusu build/installer.nsh'tedir (varsayılan Hayır,
    // güncellemede ve sessiz kaldırmada sorulmaz).
    deleteAppDataOnUninstall: false,
    include: "build/installer.nsh",
    installerLanguages: ["tr_TR", "en_US"],
    language: "1055",
    uninstallDisplayName: "Universal Mail",
  },
  artifactName: "Universal-Mail-${version}-${os}-${arch}.${ext}",
};
