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

const macSigning = has("CSC_LINK") || has("CSC_NAME");
const macNotarize =
  macSigning && has("APPLE_ID") && has("APPLE_APP_SPECIFIC_PASSWORD") && has("APPLE_TEAM_ID");
const winSigning = has("WIN_CSC_LINK") || has("CSC_LINK");
/**
 * Windows .exe kaynaklarını (simge, sürüm bilgisi) düzenleme. electron-builder bunu imzalamayla aynı adımda (rcedit)
 * yapar; Faz 1'den beri imzasız derlemede KAPALIDIR, bu yüzden imzasız .exe ve kısayollar Electron'un varsayılan
 * simgesini taşır (kurulum programının kendi simgesi yine Universal Mail'dir). `UM_WIN_EDIT_EXE=1` imzasız derlemede de
 * açar; CI'da bir kez denenip doğrulandıktan sonra varsayılan yapılabilir (docs/PAKETLEME.md).
 */
const winEditExe = winSigning || env.UM_WIN_EDIT_EXE === "1";

/**
 * Geliştiricinin yerel verisi pakete GİRMEMELİ. Next'in dosya izleyicisi (output file tracing) proje kökündeki `.data/`
 * klasörünü (geliştirme veritabanı, `master.key`, `secrets.json`) ve `.env*` dosyalarını `.next/standalone` içine
 * kopyalayabilir; yerelde `npm run dist` çalıştırıldığında bunlar kurulum paketine taşınırdı. CI temiz checkout'tan
 * derlediği için orada bu dosyalar yoktur; bu süzgeç yerel derlemeyi de güvenli kılar (tests/packaging-config.test.ts).
 */
const DEVELOPER_DATA_EXCLUDES = [
  "!.data/**",
  "!.data-demo/**",
  "!**/.env",
  "!**/.env.*",
  "!**/*.db",
  "!**/*.db-wal",
  "!**/*.db-shm",
  "!**/*.db-journal",
  "!**/master.key",
  "!**/secrets.json",
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
    target: [{ target: "dmg", arch: ["arm64"] }],
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
    signAndEditExecutable: winEditExe,
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
