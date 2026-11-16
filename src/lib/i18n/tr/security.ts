/**
 * Paket G (Faz 6): güvenlik ve gizlilik ile ilgili arayüz metinleri (Ayarlar > Güvenlik ve gizlilik kartı,
 * `src/features/settings/privacy-card.tsx`). P0 başlattı; sonrasında yalnızca G düzenler. Karşılığı `en/security.ts`.
 * Hizmet listesi `src/lib/net/egress-allowlist.ts` ile aynıdır (`src/lib/net/privacy-view.ts`).
 */
export const security = {
  /** Ayarlar gezinme girişi (`settings-page.tsx` SECTIONS; kart oraya takılınca kullanılır). */
  "settings.nav.security": "Güvenlik ve gizlilik",
  "security.title": "Güvenlik ve gizlilik",
  "security.desc":
    "Tüm verileriniz yalnızca bu bilgisayarda tutulur. Uygulama, geliştiricisine ya da reklam ve analiz hizmetlerine hiçbir veri göndermez; yalnızca sizin açtığınız hizmetlere bağlanır.",
  "security.point.local":
    "Uygulamanın iç sunucusu yalnızca bu bilgisayardan açılabilir; ağdaki başka bir cihaz bağlanamaz.",
  "security.point.secrets":
    "API anahtarlarınız ve Gmail bağlantı bilgileriniz şifreli saklanır. Şifreyi çözen anahtar işletim sisteminizin anahtar zincirindedir; dosyalar başka bir bilgisayara kopyalansa da okunamaz.",
  "security.point.demo":
    "Demo veri kaynağında Google'a ve diğer veri servislerine bağlanılmaz; bağladığınız Gmail kutusu ve çıkış sunucusu yine kullanılır.",
  "security.point.noTelemetry":
    "Kullanım istatistiği, hata raporu ya da arka planda güncelleme denetimi yoktur.",
  "security.services.title": "Uygulamanın bağlanabileceği hizmetler",
  "security.services.desc":
    "Bir hizmet yalnızca siz onu açtığınızda ya da anahtarını girdiğinizde kullanılır. Bağlantılar (ör. Google Haritalar'da göster) varsayılan tarayıcınızda açılır.",
  "security.col.service": "Hizmet",
  "security.col.when": "Ne zaman bağlanır?",
  "security.col.hosts": "Adres",
  "security.hosts.dynamic": "Duruma göre değişir",
  "security.hosts.more": "+{n} daha",
  "security.service.places": "Google Places",
  "security.when.places":
    "Google modunda tarama yaptığınızda ve işletme bilgilerini yüklediğinizde (kendi API anahtarınızla).",
  "security.service.maps": "Google Haritalar",
  "security.when.maps": "Keşfet haritası açıkken; yalnızca harita anahtarı girdiyseniz.",
  "security.service.gmail": "Gmail",
  "security.when.gmail":
    "Gmail hesabınızı bağladığınızda: bağlanırken, e-posta gönderirken ve yanıtları denetlerken.",
  "security.service.hunter": "Hunter",
  "security.when.hunter": "Hunter anahtarınızı girip e-posta aramasında kullandığınızda.",
  "security.service.snov": "Snov.io",
  "security.when.snov": "Snov.io anahtarınızı girip e-posta aramasında kullandığınızda.",
  "security.service.anthropic": "Claude (Anthropic)",
  "security.when.anthropic": "Yapay zekâ ile tanıtım metni yazdırmayı açtığınızda.",
  "security.service.companiesHouse": "Companies House (Birleşik Krallık)",
  "security.when.companiesHouse":
    "Birleşik Krallık şirket sicilini kendi anahtarınızla taradığınızda.",
  "security.service.insee": "INSEE Sirene (Fransa)",
  "security.when.insee": "Fransa şirket sicilini kendi anahtarınızla taradığınızda.",
  "security.service.rdap": "Alan adı kayıtları (RDAP)",
  "security.when.rdap": "Alan adı yaşı denetimini açtığınızda (yenilik puanı için).",
  "security.service.websites": "İşletmelerin web siteleri",
  "security.when.websites":
    "E-posta bulma sırasında işletmenin kendi sitesi okunurken. Yerel ağ adreslerine hiç bağlanılmaz.",
  "security.service.dns": "DNS",
  "security.when.dns":
    "E-posta adreslerinin alan adı ve kendi gönderim ayarlarınız (SPF, DKIM, DMARC) denetlenirken.",
  "security.service.relay": "Abonelikten çıkma aktarıcısı",
  "security.when.relay":
    "Kendi kurduğunuz aktarıcının adresini girdiyseniz, abonelikten çıkma isteklerini almak için.",
  /* Faz 6 entegrasyonu: Ayarlar'daki "Bu nedir?" balonu. */
  "security.help":
    "Bu tablo uygulamanın internette nereye, ne zaman bağlanabileceğini gösterir. Listede olmayan bir adrese bağlanılmaz; bir hizmeti kullanmıyorsanız (anahtarını girmediyseniz) ona hiç bağlanılmaz.",
} as const;
