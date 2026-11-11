import type { Db, DbExecutor } from "@/lib/db/client";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Gerçek (Gmail) gelen kutusu eşitlemesinin SON SONUCU (Aşama 15.7 incelemesi): "okuma izni verildi" ile "okuma gerçekten
 * çalışıyor" ayrı şeylerdir. Hazırlık ekranı yalnızca TAZE ve BAŞARILI bir eşitleme kaydını "tamam" sayar. Kayıt yalnızca
 * eşitleme turu çalıştığında yazılır; canlı okuma kilidi kapalıyken tur hiç çalışmaz, kayıt oluşmaz ve madde "doğrulanmadı"
 * kalır. İçerik veya adres saklanmaz: yalnızca zaman, sonuç ve güvenli hata kodu.
 */

export const INBOX_SYNC_FRESH_MS = 24 * 3_600_000;

export async function recordInboxSync(
  db: Db,
  mailboxId: number,
  result: { ok: boolean; code: string },
  now = Date.now(),
): Promise<void> {
  const cur = await getSetting(db, "mail.inboxSync");
  await setSetting(db, "mail.inboxSync", {
    ...cur,
    [String(mailboxId)]: { at: now, ok: result.ok, code: result.code.slice(0, 60) },
  });
}

export type InboxSyncStatus = "ok" | "blocked" | "unknown";

/** Gerçek bağlı kutular için: hepsinde taze başarı → ok; herhangi birinde taze başarısızlık → blocked; aksi halde unknown. */
export async function evaluateInboxSync(
  db: DbExecutor,
  boxes: { id: number }[],
  now = Date.now(),
): Promise<InboxSyncStatus> {
  if (boxes.length === 0) return "unknown";
  const rec = await getSetting(db, "mail.inboxSync");
  let allOk = true;
  for (const b of boxes) {
    const r = rec[String(b.id)];
    const fresh = !!r && now - r.at <= INBOX_SYNC_FRESH_MS && r.at <= now + 5 * 60_000;
    if (!fresh) {
      allOk = false;
      continue;
    }
    if (!r.ok) return "blocked";
  }
  return allOk ? "ok" : "unknown";
}
