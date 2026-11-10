/**
 * Hukuki ve operasyonel onay durumları (Aşama 14).
 *
 * BU DEĞERLERİN HİÇBİRİ ÇALIŞMA ANINDA, KULLANICI BEYANIYLA veya ayarla değişmez. Kullanıcının "yasal saklama
 * yükümlülüğü yok" demesi hukuki onay yerine GEÇMEZ. Bir değer yalnızca yazılı hukuki onay alındıktan sonra, kaydı
 * tutulan yeni bir yazılım sürümüyle `true` yapılır (canlı ülke politikası kilidi ve `LIVE_SENDING_ENABLED` ile
 * aynı yöntem). Hepsi bu sürümde `false`'tur.
 */

export const LEGAL_APPROVALS = {
  /** `docs/LIA.md` şirket ve hukuk tarafından tamamlandı ve onaylandı. */
  lia: false,
  /** `docs/UYUM.md` kullanıcıya sunulacak biçimiyle hukuk tarafından onaylandı. */
  uyum: false,
  /** Canlı ülke politikalarının kilidinin açılmasına yazılı hukuki onay verildi. */
  liveCountryPolicies: false,
  /**
   * Gerçek bir posta kutusundan fiilen gönderilmiş iletilerin kayıtlarının (alıcı adresi, konu) silme talebinde
   * anonimleştirilmesi/silinmesi ile yasal saklama yükümlülükleri arasındaki ilişki hukuken değerlendirildi.
   */
  erasureOfTransmissionRecords: false,
  /** Silme talebinden sonra suppression özetinin (e-posta özeti) saklanmasının hukuki dayanağı onaylandı. */
  suppressionHashRetention: false,
  /**
   * Türkiye'ye yönelik gönderimlerde MERSİS / ticaret sicil gibi kurumsal tanımlayıcıların ZORUNLULUK kuralı hukuken
   * belirlendi. Alanlar isteğe bağlıdır; bu kural belirlenene kadar hiçbir gönderim bu yüzden engellenmez ve
   * canlı gönderim zaten kapalıdır.
   */
  trSenderIdentifierRules: false,
  /** Genel HTTPS tek tıklamalı çıkış uç noktası kuruldu ve doğrulandı. */
  httpsUnsubscribeEndpoint: false,
} as const;

export type LegalApprovalKey = keyof typeof LEGAL_APPROVALS;

/** Gerçek posta kutusuyla gönderilmiş iletilerin kayıtları silme talebinde işlenebilir mi? */
export const ERASURE_OF_TRANSMISSION_RECORDS_APPROVED: boolean =
  LEGAL_APPROVALS.erasureOfTransmissionRecords;
