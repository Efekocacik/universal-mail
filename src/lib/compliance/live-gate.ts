import { LEGAL_APPROVALS } from "./legal-status";
import { LIVE_SENDING_ENABLED } from "./policies";

/**
 * Gerçek gönderimin TEK birleşik kapısı (Aşama 15.7 incelemesi).
 *
 * Gerçek gönderim yalnızca iki koşul BİRLİKTE sağlanırsa serbesttir:
 *  1. `LIVE_SENDING_ENABLED` (kodda sabit; yalnızca bilinçli bir sürümle değişir),
 *  2. `LEGAL_APPROVALS` içindeki HER onay `true` (yazılı hukuki/operasyonel onay; kullanıcı beyanıyla değişmez).
 * Böylece biri yanlışlıkla `true` yapılsa bile (ör. yalnızca bayrak açılsa) gönderim açılmaz: hukuki onaylar, hazırlık
 * ekranında olduğu gibi GÖNDERİM YOLUNDA da zorunludur. Uygunluk/ülke politikası, suppression, kota ve çıkış bağlantısı
 * kontrolleri bu kapıdan BAĞIMSIZ olarak ayrıca uygulanır.
 */
export function isLiveSendingPermitted(): boolean {
  return (
    LIVE_SENDING_ENABLED && (Object.values(LEGAL_APPROVALS) as boolean[]).every((v) => v === true)
  );
}
