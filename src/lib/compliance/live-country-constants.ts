/**
 * Canlı ülke aktivasyonu/geri alma ortak sabitleri (içe aktarma yasağına takılmayan, saf modül).
 * Kullanıcıya dönük özet: `live-country-activation.ts`.
 */

/** Ülke geri alındığında duraklatılan kampanyaların `pauseReason` değeri (devam yalnızca açık onayla). */
export const COUNTRY_REVOKED_PAUSE_REASON = "country_revoked";

/** Aktivasyonda "kendime test gönder" kanıtının en çok kaç gün eski olabileceği. */
export const ACTIVATION_SELF_TEST_MAX_AGE_DAYS = 30;

/** Hukuki onay belgesinin tarihi bugünden en çok kaç gün eski olabilir (şirket kararı; öneri 90). */
export const ACTIVATION_DOCUMENT_MAX_AGE_DAYS = 90;

/** Bir işlemde en çok kaç ülke açılabilir. */
export const ACTIVATION_MAX_COUNTRIES = 10;
