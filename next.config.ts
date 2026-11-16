import path from "node:path";
import type { NextConfig } from "next";

/**
 * Faz 6 (paket G, NFR-01/02): içerik güvenliği politikası (yalnızca üretim derlemesinde; `next dev` HMR için eval
 * kullanır). Arayüz yalnızca kendi kökenine bağlanır; tek dış kaynak, kullanıcı bir Google Maps tarayıcı anahtarı
 * girdiğinde yüklenen Google Maps JavaScript API'sidir (anahtar yoksa hiç yüklenmez). Maps kısımları Google'ın Maps JS
 * için belgelediği "izin listesi" CSP'sinin birebir aynısıdır (developers.google.com/maps/documentation/javascript/
 * content-security-policy): script-src `'unsafe-eval' blob: *.googleapis.com maps.gstatic.com *.ggpht.com *.google.com`,
 * img-src, connect-src (`data: blob:` dahil), frame-src `*.google.com`, font/style ve worker-src `blob:` (vektör harita
 * ve gelişmiş işaretçiler). `'unsafe-inline'` Next'in satır içi önyükleme betikleri içindir. Asıl kazanç: veri sızdırma
 * yollarını (connect/img/frame/form/base) kendi kökenimizle ve Google Maps ile sınırlamak.
 * E-posta önizleme çerçevesi (`srcdoc`) kendi, daha katı CSP'sini taşır (bkz. preview-doc.ts).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://*.googleapis.com https://maps.gstatic.com https://*.ggpht.com https://*.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.ggpht.com https://*.google.com https://*.googleusercontent.com",
  "connect-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "worker-src 'self' blob:",
  "frame-src https://*.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(production: boolean): { key: string; value: string }[] {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(production ? [{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY }] : []),
  ];
}

const nextConfig: NextConfig = {
  output: "standalone",
  // İzleme kökü proje klasörüne sabitlenir: üst klasörde başka bir package-lock.json olduğunda (ör. git worktree)
  // Next kökü yanlış tahmin edip server.js'i .next/standalone/<göreli yol>/ altına koymasın.
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
  poweredByHeader: false,
  // Yerel (native) paketler paketlenmez; standalone çıktıya olduğu gibi kopyalanır.
  serverExternalPackages: ["@libsql/client", "libsql"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NODE_ENV === "production"),
      },
    ];
  },
};

export default nextConfig;
