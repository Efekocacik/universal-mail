import type { Db } from "@/lib/db/client";

/**
 * Faz 6 (P0 yer tutucusu; sahibi: paket Y): işçi açıldığında çağrılır. Y burada "bugün açılış yedeği alınmadıysa
 * `backup.auto {reason:"startup"}` işini `backup.auto:startup:<gün>` tekilleştirmesiyle kuyruğa ekle" mantığını kurar
 * (bkz. sözleşme Y.4). Hata işçiyi DÜŞÜRMEMELİDİR: çağıran yakalar ve günlüğe yazar.
 *
 * P0: hiçbir şey yapmaz ve hiçbir şey yazmaz.
 */
export async function onWorkerStarted(_db: Db, _opts: { now: number }): Promise<void> {
  // Bilerek boş: paket Y doldurur.
}
