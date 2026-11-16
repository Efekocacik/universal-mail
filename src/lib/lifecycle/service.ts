import fs from "node:fs";
import { lifecycleError } from "@/lib/backup/passphrase";
import type { LifecyclePending } from "@/lib/backup/shared";
import { dataDir } from "@/lib/config/paths";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { getSetting } from "@/lib/settings";
import {
  createPending,
  newNonce,
  readPendingState,
  readResult,
  removePending,
  removeResult,
  stageDirOf,
  STAGE_ID_RE,
  type LifecycleResult,
} from "./pending";
import { wipePhraseMatches } from "./wipe";

/**
 * Faz 6 (paket Y.6/Y.7): bekleyen yaşam döngüsü işlemi (verileri silme planlama, görüntüleme, iptal) ve son sonuç.
 */

/** "Tüm verilerimi sil"i yeniden başlatmaya planlar. Onay ifadesi tutmazsa `WIPE_CONFIRM_MISMATCH`. */
export async function scheduleWipe(
  db: Db,
  o: { confirm: string; deleteBackups: boolean; now?: number },
): Promise<void> {
  if (!wipePhraseMatches(o.confirm)) throw lifecycleError("WIPE_CONFIRM_MISMATCH");
  const folder = await getSetting(db, "backup.folder");
  const created = createPending(dataDir(), {
    v: 1,
    kind: "wipe",
    deleteBackups: o.deleteBackups,
    at: o.now ?? Date.now(),
    nonce: newNonce(),
    ...(folder ? { customBackupFolder: folder } : {}),
  });
  if (!created) throw lifecycleError("LIFECYCLE_PENDING");
  await audit(db, "data.wipe.schedule", "data", undefined, { deleteBackups: o.deleteBackups });
}

/** Arayüze gösterilen bekleyen işlem (özel klasör yolu dışarı verilmez). */
export function currentPending(): LifecyclePending | null {
  const s = readPendingState(dataDir());
  if (s.state !== "ok") return null;
  if (s.pending.kind === "wipe") {
    const { customBackupFolder: _omit, ...rest } = s.pending;
    return rest;
  }
  return s.pending;
}

/** Bekleyen işlemi iptal eder (idempotent; geri yüklemenin hazırlığı da silinir; bozuk işaret de kaldırılır). */
export async function cancelPending(db: Db): Promise<boolean> {
  const dir = dataDir();
  const s = readPendingState(dir);
  if (s.state === "none") return false;
  if (s.state === "ok" && s.pending.kind === "restore" && STAGE_ID_RE.test(s.pending.stageId))
    fs.rmSync(stageDirOf(dir, s.pending.stageId), { recursive: true, force: true });
  removePending(dir);
  await audit(db, "data.pending.cancel", "data", undefined, {
    kind: s.state === "ok" ? s.pending.kind : "invalid",
  });
  return true;
}

export function lastLifecycleResult(): LifecycleResult | null {
  return readResult(dataDir());
}

export async function dismissLifecycleResult(db: Db): Promise<boolean> {
  const had = readResult(dataDir()) !== null;
  removeResult(dataDir());
  if (had) await audit(db, "data.result.dismiss", "data");
  return had;
}
