import { RelayConfigError, loadRelayConfig, startRelayServer } from "./server";

/**
 * Aktarıcı sunucusunun çalıştırılabilir girişi (`dist/relay/relay.cjs`; bkz. scripts/build-bundles.mjs --relay).
 * Modül mantığı server.ts içindedir; bu dosya yalnızca ortamdan yapılandırır, başlatır ve SIGTERM/SIGINT ile
 * düzgün kapatır. Testler server.ts'yi doğrudan içe aktarır (bu dosya içe aktarılınca sunucu başlar).
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadRelayConfig(process.env);
  } catch (e) {
    console.error(e instanceof RelayConfigError ? e.message : "Yapılandırma okunamadı.");
    process.exit(2);
  }
  const running = await startRelayServer(config);
  console.log(
    `um-relay listening on ${running.address.address}:${running.address.port} origin=${config.origin}`,
  );
  if (!running.app.keyFile.ready()) {
    console.log(
      "um-relay: no valid key file yet; /u and /spool answer 503 until keys are deployed",
    );
  }
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`um-relay: ${signal} received, closing`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  // Ayrıntı yalnızca hata adı/kodu; yol ve içerik yazılmaz.
  const err = e as { code?: string; name?: string } | null;
  console.error(`um-relay failed to start: ${err?.code ?? err?.name ?? "error"}`);
  process.exit(1);
});
