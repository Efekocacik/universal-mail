import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "@/lib/util/file-lock";

/**
 * Bakım kilidi (Aşama 15.10-1, K3): şema geçişi sürerken bu sürümün diğer süreçleri (web, çalışan, zamanlayıcı) veritabanı
 * çağrılarını BEKLETİR; yazma kilidine takılıp SQLITE_BUSY almazlar. Kilit, veritabanı dosyasıyla aynı klasördeki
 * `maintenance.lock` dosyasıdır ({ pid, startedAt, purpose }). Bayatlık: sahibi ölmüşse veya 6 saatten eskiyse.
 *
 * SINIR: Bu kilide uymayan (eski sürüm) süreçleri durduramaz; onlar için yalnızca SQLite yazma kilidi geçerlidir.
 */

export interface MaintenanceInfo {
  pid: number;
  startedAt: number;
  purpose: string;
}

export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

const MAX_AGE_MS = 6 * 3_600_000;

export const maintenancePathFor = (dbFile: string): string =>
  path.join(path.dirname(dbFile), "maintenance.lock");

function readInfo(file: string): MaintenanceInfo | "unreadable" | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const v = JSON.parse(text) as Partial<MaintenanceInfo>;
    if (typeof v.pid === "number" && typeof v.startedAt === "number")
      return { pid: v.pid, startedAt: v.startedAt, purpose: String(v.purpose ?? "") };
  } catch {
    /* yarım yazılmış olabilir */
  }
  return "unreadable";
}

/** Geçerli (bayat olmayan) bakım kaydı; yoksa null. Bayat kilit kaldırılır. */
export function activeMaintenance(dbFile: string): MaintenanceInfo | null {
  const file = maintenancePathFor(dbFile);
  const info = readInfo(file);
  if (info === null) return null;
  if (info === "unreadable") {
    // Yazılırken görülmüş olabilir: kısa süre geçerli say, çok eskiyse bayat.
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 30_000) fs.rmSync(file, { force: true });
      else return { pid: -1, startedAt: Date.now(), purpose: "bilinmiyor" };
    } catch {
      return null;
    }
    return null;
  }
  if (!isProcessAlive(info.pid) || Date.now() - info.startedAt > MAX_AGE_MS) {
    fs.rmSync(file, { force: true });
    return null;
  }
  return info;
}

export interface MaintenanceHandle {
  release: () => void;
}

/**
 * Bakım kilidini alır. Başka bir canlı süreç tutuyorsa `timeoutMs` boyunca bekler, sonra `MaintenanceError` fırlatır.
 * (Kilidi alan çağıran, bekleme sonrası "yapılacak iş kaldı mı" kontrolünü yeniden yapmalıdır.)
 */
export async function acquireMaintenance(
  dbFile: string,
  purpose: string,
  timeoutMs = 600_000,
): Promise<MaintenanceHandle> {
  const file = maintenancePathFor(dbFile);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), purpose }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const cur = activeMaintenance(dbFile);
      if (cur === null) continue; // bayat kilit kaldırıldı veya bırakıldı
      if (Date.now() - started > timeoutMs)
        throw new MaintenanceError(
          "Bakım kilidi alınamadı (zaman aşımı): başka bir süreç şema güncelliyor.",
        );
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        const cur = readInfo(file);
        if (cur !== null && cur !== "unreadable" && cur.pid !== process.pid) return; // başkasının kilidi
        fs.rmSync(file, { force: true });
      } catch {
        /* zaten kaldırılmış */
      }
    },
  };
}

/**
 * Bakım sürüyorsa (kendi sürecimiz tutmuyorsa) bitene kadar bekler. Veritabanı katmanı her çağrıdan önce kullanır;
 * dosya denetimi `CHECK_EVERY_MS` aralıkla önbelleğe alınır. Zaman aşımında `MaintenanceError`.
 */
const CHECK_EVERY_MS = 200;
const lastCheck = new Map<string, number>();

export async function waitForMaintenance(dbFile: string, timeoutMs = 300_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    const last = lastCheck.get(dbFile) ?? 0;
    if (now - last < CHECK_EVERY_MS && now >= last) return;
    const m = activeMaintenance(dbFile);
    if (m === null || m.pid === process.pid) {
      lastCheck.set(dbFile, Date.now());
      return;
    }
    if (Date.now() - started > timeoutMs)
      throw new MaintenanceError(
        "Veritabanı bakımda (şema güncellemesi sürüyor); lütfen birkaç dakika sonra yeniden deneyin.",
      );
    await new Promise((r) => setTimeout(r, 100));
  }
}
