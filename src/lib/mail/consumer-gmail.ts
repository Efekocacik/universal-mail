/**
 * Kişisel (tüketici) Gmail hesabı desteği. Gönderen kutu bir Google Workspace hesabı olabileceği gibi sıradan bir
 * `@gmail.com` (veya eski `@googlemail.com`) hesabı da olabilir.
 *
 *  - Bu alan adlarının DNS'i (SPF, DKIM, DMARC) Google tarafından yönetilir: kullanıcı kayıt ekleyemez ve eklemesi
 *    gerekmez (Google iletiyi `gmail.com` adına kendisi imzalar; `gmail.com` DMARC politikası Google'ın kararıdır).
 *    Bu yüzden DNS denetimi bu alan adları için "sağlayıcı yönetimli" sonuç verir ve ağ sorgusu yapmaz.
 *  - Kişisel Gmail'in günlük gönderim sınırı Workspace'ten çok düşüktür; ısınma ve günlük tavan daha sıkıdır
 *    (`scheduler/throttle.ts`).
 *  - Kutu adresi hesabın BİRİNCİL adresi olmalıdır. Google kimlik belirtecindeki e-posta hesabın kanonik adresidir
 *    (küçük harf, hesap açılırken yazılan noktalarla); eşleştirme büyük/küçük harf duyarsız ama birebirdir. Gmail
 *    noktaları yok saysa da `ad.soyad@gmail.com` ile `adsoyad@gmail.com` farklı yazım sayılır; `+etiket` takma adı
 *    birincil adres olamaz.
 */

/** Google'ın yönettiği kişisel Gmail alan adları. */
export const GOOGLE_CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

/** Adresin alan adı (küçük harf); adres yoksa veya `@` içermiyorsa null. */
export function domainOfAddress(address: string | null | undefined): string | null {
  if (!address || !address.includes("@")) return null;
  const d = address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return d.length > 0 ? d : null;
}

/** Alan adı Google'ın yönettiği kişisel Gmail alan adı mı? */
export function isConsumerGmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return GOOGLE_CONSUMER_DOMAINS.has(domain.trim().toLowerCase().replace(/\.$/, ""));
}

/** Adres kişisel bir Gmail adresi mi (`@gmail.com` / `@googlemail.com`)? */
export function isConsumerGmailAddress(address: string | null | undefined): boolean {
  return isConsumerGmailDomain(domainOfAddress(address));
}
