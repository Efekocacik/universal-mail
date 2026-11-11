import path from "node:path";
import type { NextConfig } from "next";

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
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
