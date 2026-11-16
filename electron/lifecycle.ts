import { readPendingState, removePending, writeResult } from "../src/lib/lifecycle/pending";
import { wipeDataDir, wipeUserData } from "../src/lib/lifecycle/wipe";

/**
 * Faz 6 (P0.6; sahibi: paket Y): ana süreç yaşam döngüsü dikişleri.
 *
 *  - `applyPendingLifecycleInMain`: `whenReady` içinde ana anahtar YÜKLENMEDEN önce çağrılır. Bekleyen "tüm verilerimi
 *    sil" işleminde veri klasörü ve kullanıcı klasöründeki uygulama dosyalarını (ana anahtar, tercihler, günlükler) siler
 *    (sözleşme Y.6).
 *  - `registerLifecycleIpc`: `um:relaunch`, `um:choose-folder`, `um:choose-backup-file` IPC uçları. Her biri YALNIZCA
 *    uygulamanın kendi penceresinden (yerel köken) gelen çağrıyı kabul eder; diğerleri sessizce reddedilir.
 */

export interface LifecycleMainResult {
  applied: null | { kind: "wipe"; ok: boolean };
}

/**
 * Bekleyen "tüm verilerimi sil" işlemini uygular: veri klasöründeki uygulama dosyaları (+ seçildiyse yedekler) ve
 * kullanıcı klasöründeki ana anahtar, tercihler, bildirim izi ve günlükler silinir; işaret EN SONDA ve her durumda
 * kaldırılır (kısmi hata her açılışta yeniden silme döngüsüne girmez). Geri yükleme işareti burada UYGULANMAZ (şema
 * geçişi sürecinin işidir). Bozuk işarete dokunulmaz (o da geçiş sürecinde silinir). Hiçbir hata açılışı durdurmaz.
 */
export async function applyPendingLifecycleInMain(opts: {
  userDataDir: string;
  dataDir: string;
  log: (message: string) => void;
  now?: number;
}): Promise<LifecycleMainResult> {
  try {
    const s = readPendingState(opts.dataDir);
    if (s.state !== "ok" || s.pending.kind !== "wipe") return { applied: null };
    const p = s.pending;
    const data = wipeDataDir({
      dataDir: opts.dataDir,
      deleteBackups: p.deleteBackups,
      customBackupFolder: p.customBackupFolder,
    });
    const user = wipeUserData(opts.userDataDir);
    removePending(opts.dataDir);
    const failed = data.failed.length + user.failed.length;
    const ok = failed === 0;
    writeResult(opts.dataDir, {
      v: 1,
      kind: "wipe",
      ok,
      at: opts.now ?? Date.now(),
      ...(ok ? {} : { code: "WIPE_PARTIAL" }),
    });
    opts.log(
      `tüm veriler silindi (${data.removed + user.removed} öğe${ok ? "" : `; silinemeyen ${failed}: ${[...data.failed, ...user.failed].slice(0, 10).join(", ")}`}).`,
    );
    return { applied: { kind: "wipe", ok } };
  } catch (e) {
    opts.log(`verileri silme uygulanamadı: ${e instanceof Error ? e.message : String(e)}`);
    try {
      removePending(opts.dataDir);
    } catch {
      /* yok sayılır */
    }
    return { applied: { kind: "wipe", ok: false } };
  }
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
