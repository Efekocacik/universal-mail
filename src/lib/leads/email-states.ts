/**
 * E-posta durumları (SRS email_status ve bulma işinin işlem durumları). Saf modül: hem sunucu (gösterge paneli
 * sayacı, `EMAIL_STATE` süzgeci) hem istemci (Keşif süzgeci, gösterge panelinden gelen bağlantı) aynı listeyi kullanır;
 * böylece "E-postası bulunan" sayacının saydığı küme ile kutucuğun açtığı liste birbirinden kopamaz.
 */
export const EMAIL_STATES = [
  "found_verified",
  "generic",
  "found_unverified",
  "invalid",
  "not_found",
  "unchecked",
  "queued",
  "running",
  "no_website",
  "needs_google",
  "blocked",
  "failed",
] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

/** E-postası bulunmuş sayılan durumlar. */
export const EMAIL_FOUND_STATES = [
  "found_verified",
  "found_unverified",
  "generic",
] as const satisfies readonly EmailState[];
