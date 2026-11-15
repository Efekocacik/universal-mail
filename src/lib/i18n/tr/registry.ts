/**
 * Paket R (Faz 5): resmî sicil sayfası, ayar kartı, çalışma durumları, eşleşme nedenleri, `registry.error.*` ve `apiError.REGISTRY_*`. P0 başlattı; sonrasında yalnızca R düzenler.
 * Karşılığı `en/registry.ts`.
 */
export const registry = {
  "registry.title": "Sicil kayıtları",
  "registry.subtitle":
    "Resmî şirket sicilinde yeni kurulan işletmeleri bulun ve haritadaki işletmelerle eşleştirin.",
  "registry.settings.title": "Resmî siciller",
  "registry.settings.desc":
    "Birleşik Krallık (Companies House) ve Fransa (INSEE Sirene) sicillerinden yeni kurulan işletmeler.",
  "registry.settings.help":
    "Sicil, yeni kurulan şirketlerin resmî listesidir. Kayıtlar Google haritasındaki işletmelerle ad ve posta koduna göre eşleştirilir; eşleşmeyenler ayrı listede kalır ve isterseniz lead olarak eklenir.",
  "registry.matchBadge": "Sicilde kayıtlı",
  "registry.matchBadge.detail": "Sicil: {name} · kuruluş {date}",
  "registry.matchBadge.demo": "Demo sicil kaydı",

  "registry.demoBanner":
    "Demo sicil verisi: bu kayıtlar gerçek değildir. Demo haritadaki işletmelerden türetilir ve gerçek veriyle karışmaz.",
  "registry.note":
    "Sicildeki kuruluş tarihi açılış tarihi değildir. Haritada eşleşmeyen kayıtlar kendiliğinden yeni işletme sayılmaz; doğrulanmış iletişim bilgisi olmadan onlara e-posta gönderilmez.",
  "registry.source.companies_house": "Birleşik Krallık · Companies House",
  "registry.source.insee": "Fransa · INSEE Sirene",
  "registry.source.short.companies_house": "Companies House",
  "registry.source.short.insee": "INSEE",

  "registry.form.title": "Yeni sicil çalışması",
  "registry.form.source": "Sicil",
  "registry.form.locality": "Yer (isteğe bağlı)",
  "registry.form.localityHint": "Şehir adı veya posta kodu. Boş bırakılırsa tüm ülkede aranır.",
  "registry.form.codes": "Faaliyet kodları",
  "registry.form.codesRequired": "En az bir faaliyet kodu seçin.",
  "registry.form.window": "Son kaç günde kurulanlar",
  "registry.form.windowHint": "1 ile 365 gün arası.",
  "registry.form.windowInvalid": "1 ile 365 arasında bir gün sayısı girin.",
  "registry.form.run": "Çalıştır",
  "registry.form.started": "Sicil çalışması başladı. Kayıtlar birkaç saniye içinde listelenir.",
  "registry.form.liveOff":
    "Bu sicil canlıda kapalı. Ayarlar → Resmî siciller bölümünden açıp anahtarı girin.",
  "registry.form.openSettings": "Ayarları aç",

  "registry.runs.title": "Çalışmalar",
  "registry.runs.empty": "Henüz sicil çalışması yok",
  "registry.runs.emptyBody": "Yukarıdan bir sicil seçip Çalıştır'a basın.",
  "registry.runs.window": "Kuruluş: {from} – {to}",
  "registry.runs.counts": "Çekilen: {fetched} · yeni: {new}",
  "registry.runs.rate": "Eşleşme: {rate}",
  "registry.runs.matching": "Eşleştiriliyor…",
  "registry.status.queued": "Kuyrukta",
  "registry.status.running": "Çekiliyor",
  "registry.status.done": "Tamamlandı",
  "registry.status.failed": "Başarısız",
  "registry.error.REGISTRY_AUTH": "Sicil anahtarı reddedildi. Ayarlardan anahtarı yeniden girin.",
  "registry.error.REGISTRY_RATE": "Sicil hız sınırına takıldı. Biraz sonra yeniden çalıştırın.",
  "registry.error.REGISTRY_UPSTREAM":
    "Sicil hizmetine ulaşılamadı veya çalışma yarıda kaldı. Yeniden çalıştırın.",
  "registry.error.REGISTRY_BAD_RESPONSE":
    "Sicil beklenmeyen bir yanıt verdi. Yeniden deneyin; sürerse kodları değiştirin.",
  "registry.error.REGISTRY_KEY_MISSING": "Sicil anahtarı girilmemiş. Ayarlardan ekleyin.",
  "registry.error.REGISTRY_TOO_MANY":
    "5000'den fazla kayıt bulundu. Gün sayısını azaltın veya bir yer girin.",

  "registry.rematch": "Yeniden eşleştir",
  "registry.rematch.started": "Eşleştirme başladı. Sonuçlar birkaç saniye içinde güncellenir.",
  "registry.stats.rate": "Eşleşme oranı",
  "registry.stats.summary":
    "Toplam {total} kayıttan {matched} tanesi haritadaki bir işletmeyle eşleşti.",
  "registry.tabs.matched": "Haritada eşleşti",
  "registry.tabs.unmatched": "Sicilde var, haritada eşleşmedi",
  "registry.list.search": "Sicil adında ara",
  "registry.list.empty.matched": "Henüz eşleşen kayıt yok",
  "registry.list.empty.matchedBody":
    "Önce aynı şehirde bir harita taraması yapın, sonra Yeniden eşleştir'e basın.",
  "registry.list.empty.unmatched": "Eşleşmeyen kayıt yok",
  "registry.list.empty.unmatchedBody":
    "Bu sicil kayıtlarının hepsi haritadaki bir işletmeyle eşleşti.",
  "registry.list.incorporated": "Kuruluş: {date}",
  "registry.list.empty.none": "Henüz sicil kaydı yok",
  "registry.list.empty.noneBody":
    "Yukarıdaki formla bir sicil taraması başlatın; bulunan kayıtlar burada listelenir.",
  "registry.list.empty.noResults": "Bu aramada sonuç yok",
  "registry.list.empty.noResultsBody": "Başka bir ad deneyin veya arama kutusunu temizleyin.",
  "registry.stats.inSearch": "Bu aramada: {n} kayıt",
  "registry.list.score": "Benzerlik: {score}",
  "registry.list.openLead": "Haritadaki işletmeyi aç",
  "registry.list.addLead": "Lead olarak ekle",
  "registry.list.leadCreated":
    "Lead oluşturuldu. Keşif ekranında “Resmî sicil” kaynağıyla görünür.",
  "registry.list.openCreatedLead": "Lead'i aç",
  "registry.list.more": "Daha fazla göster",
  "registry.list.demoTag": "Demo",
  "registry.list.pending": "Eşleşme bekliyor",
  "registry.reason.name_address": "Ad ve adres eşleşti",
  "registry.reason.name_postcode": "Ad ve posta kodu eşleşti",
  "registry.reason.name_city": "Ad ve şehir eşleşti",
  "registry.reason.ambiguous": "Birden çok benzer işletme var; elle kontrol edin.",
  "registry.reason.below_threshold": "Haritada yeterince benzer adlı işletme yok.",
  "registry.reason.no_candidates": "Bu bölgedeki benzer işletmeler başka kayıtlarla eşleşti.",
  "registry.reason.no_cache":
    "Bu bölgede harita verisi yok. Önce bu şehirde bir tarama yapın, sonra Yeniden eşleştir.",

  "registry.code.56102": "56102 · Kafe ve alkolsüz lokanta",
  "registry.code.56302": "56302 · Pub ve bar",
  "registry.code.56101": "56101 · Restoran (alkollü)",
  "registry.code.56103": "56103 · Paket servis",
  "registry.code.56301": "56301 · Lisanslı kulüp ve bar",
  "registry.code.55100": "55100 · Otel",
  "registry.code.56.30Z": "56.30Z · İçecek servisi (kafe, bar)",
  "registry.code.56.10A": "56.10A · Geleneksel restoran",
  "registry.code.56.10C": "56.10C · Hızlı servis",
  "registry.code.55.10Z": "55.10Z · Otel",

  "registry.settings.demo":
    "Demo kipindesiniz: siciller anahtarsız, demo verisiyle çalışır. Gerçek sicil için Google bağlantısını canlıya alın ve anahtarı girin.",
  "registry.settings.ch.enable": "Companies House (Birleşik Krallık)",
  "registry.settings.ch.hint":
    "Ücretsiz API anahtarı Companies House geliştirici sitesinden alınır. Yalnızca açık (aktif) şirketler çekilir.",
  "registry.settings.insee.enable": "INSEE Sirene (Fransa)",
  "registry.settings.insee.hint":
    "API anahtarı INSEE API portalından alınır. Şahıs işletmeleri ve yayımlanmasına izin verilmeyen kayıtlar alınmaz.",
  "registry.settings.codes": "Varsayılan faaliyet kodları",
  "registry.settings.window": "Varsayılan pencere (gün)",
  "registry.settings.scheme": "Kod tablosu",
  "registry.settings.scheme.NAFRev2": "NAF rév. 2",
  "registry.settings.scheme.NAF2025": "NAF 2025 (henüz yayımlanmadı)",
  "registry.settings.naf2025Note":
    "INSEE 1 Ocak 2027'de NAF rév. 2025'e geçiyor. Yeni kod tablosu yayımlanınca burada seçilebilecek; o zamana kadar NAF rév. 2 kullanılır.",
  "registry.settings.chKey": "Companies House API anahtarı",
  "registry.settings.inseeKey": "INSEE API anahtarı",
  "registry.settings.keyHelp":
    "Anahtar bu bilgisayarda şifreli saklanır ve yalnızca ilgili sicile gönderilir.",
  "registry.settings.test": "Bağlantıyı sına",
  "registry.settings.test.ok": "Bağlantı çalışıyor.",
  "registry.settings.test.okDemo": "Demo kipi: bağlantı gerekmiyor.",
  "registry.settings.limit":
    "Bilinen sınır: Companies House'taki kayıtlı ofis adresi çoğu zaman işletmenin bulunduğu yer değildir; gerçek eşleşme oranı düşük olabilir.",
  "registry.settings.openPage": "Sicil kayıtlarına git",

  "registry.filter.source": "Kaynak",
  "registry.filter.help":
    "Lead'in nereden geldiğini ve resmî sicilde eşleşen bir kaydı olup olmadığını seçin.",
  "registry.filter.source.google": "Google haritası",
  "registry.filter.source.demo": "Demo harita",
  "registry.filter.source.registry": "Resmî sicil",
  "registry.filter.source.import": "İçe aktarma",
  "registry.filter.match": "Sicil eşleşmesi",
  "registry.filter.match.any": "Fark etmez",
  "registry.filter.match.yes": "Sicil eşleşmesi var",
  "registry.filter.match.no": "Sicil eşleşmesi yok",

  "apiError.REGISTRY_DISABLED": "Bu sicil kaynağı kapalı. Ayarlar → Siciller bölümünden açın.",
  "apiError.REGISTRY_KEY_MISSING":
    "Sicil API anahtarı girilmemiş. Ayarlar → Siciller bölümüne anahtarı ekleyin veya demo kipini kullanın.",
  "apiError.REGISTRY_RUN_ACTIVE":
    "Bu kaynak için bir sicil çalışması zaten sürüyor. Bitmesini bekleyin.",
  "apiError.REGISTRY_MATCH_ACTIVE":
    "Eşleştirme zaten sürüyor. Bitince sonuçlar kendiliğinden güncellenir.",
  "apiError.REGISTRY_ALREADY_LEAD": "Bu sicil kaydından zaten bir lead oluşturuldu.",
  "apiError.REGISTRY_MATCHED":
    "Bu kayıt haritadaki bir işletmeyle eşleşti. Yeni lead yerine o işletmeyi kullanın.",
  "apiError.REGISTRY_AUTH": "Sicil API anahtarı reddedildi. Anahtarı kontrol edip yeniden girin.",
  "apiError.REGISTRY_RATE": "Sicil hizmeti çok fazla istek aldı. Bir dakika sonra yeniden deneyin.",
  "apiError.REGISTRY_UPSTREAM": "Sicil hizmetine şu an ulaşılamıyor. Biraz sonra yeniden deneyin.",
  "apiError.REGISTRY_SCHEME_UNAVAILABLE":
    "NAF 2025 kod tablosu henüz yayımlanmadı. Şimdilik NAF rév. 2 kullanın.",
} as const;
