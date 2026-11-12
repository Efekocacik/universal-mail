/**
 * Hukuki ve operasyonel onay durumları (Aşama 14).
 *
 * BU DEĞERLERİN HİÇBİRİ ÇALIŞMA ANINDA, KULLANICI BEYANIYLA veya ayarla değişmez; yalnızca kaydı tutulan bir yazılım
 * sürümüyle değişir (canlı ülke politikası kilidi ve `LIVE_SENDING_ENABLED` ile aynı yöntem).
 *
 * SAHİP KARARI (11 Kasım 2026): yedi maddenin hepsi bu sürümde `true` yapıldı. Uygulama DIŞ HUKUKİ İNCELEME
 * OLMADAN yayımlandı; hukuki sorumluluk şirkettedir. Bu değerler bir hukukçunun onayını belgelemez; yalnızca sahibin
 * yazılım kapısını açma kararını kaydeder. Çalışma anı denetimleri (ör. HTTPS çıkış uç noktasının uçtan uca
 * doğrulanması, ülke kilidi) bu kararla atlanmaz.
 */

export const LEGAL_APPROVALS = {
  /** `docs/LIA.md`: sahip kararıyla kabul edildi (dış hukuki inceleme yok). */
  lia: true,
  /** `docs/UYUM.md`: sahip kararıyla kabul edildi (dış hukuki inceleme yok). */
  uyum: true,
  /**
   * Canlı ülke politikalarının kilidinin açılabilmesi: sahip kararı. Kilidi bu sabit AÇMAZ; ülke bazında yalnızca
   * sürüm dışı canlı ülke onay betiğiyle (`scripts/`, docs/10) sahip açar.
   */
  liveCountryPolicies: true,
  /**
   * Gerçek bir posta kutusundan fiilen gönderilmiş iletilerin kayıtlarının (alıcı adresi, konu) silme talebinde
   * anonimleştirilmesi/silinmesi: sahip kararıyla işlenir (dış hukuki inceleme yok).
   */
  erasureOfTransmissionRecords: true,
  /** Silme talebinden sonra suppression özetinin (e-posta özeti) saklanması: sahip kararı. */
  suppressionHashRetention: true,
  /**
   * Türkiye'ye yönelik gönderimlerde MERSİS / ticaret sicil gibi kurumsal tanımlayıcılar: sahip kararı. Alanlar
   * isteğe bağlı kalır; hiçbir gönderim bu yüzden engellenmez.
   */
  trSenderIdentifierRules: true,
  /**
   * Genel HTTPS tek tıklamalı çıkış uç noktasının SÜRÜM kapısı: sahip kararı. Uç noktanın kendisi yine çalışma
   * anında uçtan uca doğrulanmış olmalıdır (`isOneClickEndpointVerified`); doğrulanmamışsa canlı ileti gitmez.
   */
  httpsUnsubscribeEndpoint: true,
} as const;

export type LegalApprovalKey = keyof typeof LEGAL_APPROVALS;

/** Gerçek posta kutusuyla gönderilmiş iletilerin kayıtları silme talebinde işlenebilir mi? */
export const ERASURE_OF_TRANSMISSION_RECORDS_APPROVED: boolean =
  LEGAL_APPROVALS.erasureOfTransmissionRecords;
