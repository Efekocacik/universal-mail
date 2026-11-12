import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: [
        "src/lib/novelty/**",
        "src/lib/geo/**",
        "src/lib/places/**",
        "src/lib/budget/**",
        "src/lib/scan/**",
        "src/lib/export/**",
        "src/lib/jobs/**",
        "src/lib/email/**",
        // Faz 4 (M7): yeni kütüphane dizinleri kapsam eşiğine tabidir.
        "src/lib/notifications/**",
        "src/lib/dashboard/**",
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
