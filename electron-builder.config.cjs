/**
 * electron-builder yapılandırması (Faz 6 P0: `electron-builder.yml`'nin BİREBİR karşılığı; sahibi: paket K).
 * JS biçimi, imzalama ortam değişkenlerine bağlı koşullu alanlar (paket K) eklenebilsin diye seçildi.
 * `appId` ve `productName` electron/main.ts'teki `app.setName` / AppUserModelId ile aynı kalmalıdır: kurulu sürümün
 * üzerine kurulumda veriler bu kimlikle korunur.
 */
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
      filter: ["**/*", "!node_modules/**"],
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
    identity: null, // imzasız; Apple Developer hesabı eklenince kaldırılır (bkz. docs/05-FAZ1-NOTLARI.md)
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: "Universal Mail",
    sign: false,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  artifactName: "Universal-Mail-${version}-${os}-${arch}.${ext}",
};
