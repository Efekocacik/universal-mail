import type { PlacesErrorKind } from "@/lib/places/errors";

/**
 * Tarama duraklatma kodları (`scans.pause_code`) ve zamanlamanın "kendi çalışması duraklı" atlama kodları (Faz 4).
 * Ayrı modül: çalıştırıcı, zamanlayıcı, işçi kurtarması ve bildirim üreticisi aynı sınıflandırmayı kullanır (döngüsel
 * içe aktarma olmadan).
 *
 *  pause_code            neden                                   zamanlanmış taramada kendiliğinden sürer mi?
 *  null                  kullanıcı duraklattı (veya eski kayıt)  hayır (kullanıcının kararı)
 *  CALL_LIMIT            güvenlik çağrı sınırı aşıldı            hayır (maliyet kontrolü; kullanıcı onaylar)
 *  APP_STOPPED           uygulama kapanırken güvenle duraklatıldı evet
 *  INTERRUPTED           işçi beklenmedik şekilde durdu          evet
 *  PROVIDER_QUOTA|RATE|NETWORK|SERVER  geçici Google hatası       evet (bir saat sonra yeniden denenir)
 *  BUDGET_BLOCKED        (status = budget_stopped) bütçe doldu   evet, bütçe yeniden izin verince
 */
export const APP_STOPPED = "APP_STOPPED";
export const INTERRUPTED = "INTERRUPTED";
export const CALL_LIMIT = "CALL_LIMIT";
export const BUDGET_STOP_CODE = "BUDGET_BLOCKED";

export function providerPauseCode(kind: PlacesErrorKind): string {
  return `PROVIDER_${kind.toUpperCase()}`;
}

const AUTO_RESUME_PAUSE_CODES = new Set([
  APP_STOPPED,
  INTERRUPTED,
  "PROVIDER_QUOTA",
  "PROVIDER_RATE",
  "PROVIDER_NETWORK",
  "PROVIDER_SERVER",
]);

/** Zamanlanmış bir tarama bu durumda kullanıcı onayı olmadan sürdürülebilir mi (bütçe/kurulum kapıları ayrıca)? */
export function isAutoResumable(status: string, pauseCode: string | null): boolean {
  if (status === "budget_stopped") return true;
  return status === "paused" && pauseCode !== null && AUTO_RESUME_PAUSE_CODES.has(pauseCode);
}

/**
 * Zamanlamanın SON taraması bitmeden yeni çalışma zamanı geldiğinde kaydedilen atlama kodları (`last_skip_code`).
 * `last_outcome` CHECK'i yalnızca started/skipped/completed/failed izin verir; bu kodlar "skipped" ile yazılır ve arayüz
 * bunları "Duraklatıldı"/"Çalışıyor" olarak gösterir.
 */
export const OWN_RUN_CODES = [
  "PREVIOUS_RUN_ACTIVE",
  "SCAN_RETRYING",
  "SCAN_BUDGET_STOPPED",
  "SCAN_PAUSED",
] as const;
export type OwnRunCode = (typeof OWN_RUN_CODES)[number];

/** Duraklamış/durmuş taramanın zamanlamaya yansıyan kodu. */
export function ownRunCodeFor(
  status: string,
  pauseCode: string | null,
): Exclude<OwnRunCode, "PREVIOUS_RUN_ACTIVE"> {
  if (status === "budget_stopped") return "SCAN_BUDGET_STOPPED";
  return isAutoResumable(status, pauseCode) ? "SCAN_RETRYING" : "SCAN_PAUSED";
}
