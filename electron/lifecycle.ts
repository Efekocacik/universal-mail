/**
 * Faz 6 (P0.6; sahibi: paket Y): ana süreç yaşam döngüsü dikişleri.
 *
 *  - `applyPendingLifecycleInMain`: `whenReady` içinde ana anahtar YÜKLENMEDEN önce çağrılır. Bekleyen "tüm verilerimi
 *    sil" işleminde veri klasörü ve kullanıcı klasöründeki uygulama dosyalarını (ana anahtar, tercihler, günlükler) siler
 *    (sözleşme Y.6). P0: hiçbir şey yapmaz.
 *  - `registerLifecycleIpc`: `um:relaunch`, `um:choose-folder`, `um:choose-backup-file` IPC uçları. Her biri YALNIZCA
 *    uygulamanın kendi penceresinden (yerel köken) gelen çağrıyı kabul eder; diğerleri sessizce reddedilir.
 */

export interface LifecycleMainResult {
  applied: null | { kind: "wipe"; ok: boolean };
}

export async function applyPendingLifecycleInMain(_opts: {
  userDataDir: string;
  dataDir: string;
  log: (message: string) => void;
}): Promise<LifecycleMainResult> {
  // P0: bekleyen işlem uygulanmaz (paket Y doldurur).
  return { applied: null };
}

/** IPC olayının kullanılan alt kümesi (gerçek Electron olmadan test için). */
export interface LifecycleIpcEvent {
  senderFrame?: { url: string } | null;
}

export interface LifecycleIpcMain {
  handle(channel: string, listener: (e: LifecycleIpcEvent, ...args: unknown[]) => unknown): void;
}

export interface LifecycleIpcDeps {
  isLocal: (url: string) => boolean;
  /** Güvenli kapanış → `app.relaunch()` → `app.exit(0)`. */
  relaunch: () => Promise<void>;
  /** Klasör seçme penceresi; iptal → null. */
  chooseFolder: () => Promise<string | null>;
  /** `.umbk` yedek dosyası seçme penceresi; iptal → null. */
  chooseFile: () => Promise<string | null>;
}

export const LIFECYCLE_IPC_CHANNELS = [
  "um:relaunch",
  "um:choose-folder",
  "um:choose-backup-file",
] as const;

export function registerLifecycleIpc(ipcMain: LifecycleIpcMain, deps: LifecycleIpcDeps): void {
  const local = (e: LifecycleIpcEvent) => deps.isLocal(e.senderFrame?.url ?? "");
  ipcMain.handle("um:relaunch", async (e) => {
    if (!local(e)) return false;
    await deps.relaunch();
    return true;
  });
  ipcMain.handle("um:choose-folder", (e) => (local(e) ? deps.chooseFolder() : null));
  ipcMain.handle("um:choose-backup-file", (e) => (local(e) ? deps.chooseFile() : null));
}
