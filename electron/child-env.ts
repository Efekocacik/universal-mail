import path from "node:path";

/**
 * Faz 6 (P0.6; sahibi: paket G): alt süreçlerin (migrate, web sunucusu, işçi) ortamı. `electron/main.ts`'ten birebir
 * taşındı. Güvenlik sözleşmesi: sunucu YALNIZCA 127.0.0.1'e bağlanır (`HOSTNAME`), Next telemetrisi kapalıdır, ana anahtar
 * yalnızca ortamla verilir ve `UM_REQUIRE_MASTER_KEY=1` anahtarsız açılışı engeller.
 */
export interface ChildEnvOptions {
  port: number;
  masterKey: string;
  dataDir: string;
  serverDir: string;
  baseEnv: NodeJS.ProcessEnv;
}

export function childEnv(o: ChildEnvOptions): NodeJS.ProcessEnv {
  return {
    ...o.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(o.port),
    UM_DATA_DIR: o.dataDir,
    UM_MASTER_KEY: o.masterKey,
    UM_REQUIRE_MASTER_KEY: "1",
    UM_MIGRATIONS_DIR: path.join(o.serverDir, "drizzle"),
    UM_STATIC_DATA_DIR: path.join(o.serverDir, "data"),
  };
}
