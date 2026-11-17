/**
 * Test alıcı sınırı ("test modu") metinleri: Ayarlar kartı, test modu uyarı bandı, kampanya devam onayı ve hata kodları
 * (`src/features/settings/recipient-restriction-card.tsx`, `src/components/test-mode-banner.tsx`,
 * `src/lib/compliance/recipient-restriction.ts`). Karşılığı `en/restriction.ts`.
 */
export const restriction = {
  "restriction.title": "Test modu (izinli alıcılar)",
  "restriction.desc":
    "Gerçek (Gmail) kutusuyla yapılan denemelerde kampanya iletilerini yalnızca burada yazdığınız tam e-posta adreslerine gönderir. Kapalıyken hiçbir sınır yoktur.",
  "restriction.status.on":
    "Test modu AÇIK: kampanya iletileri yalnızca {n} izinli adrese gönderilir.",
  "restriction.status.off": "Test modu kapalı: alıcı sınırı yok.",
  "restriction.toggle": "Test modunu aç",
  "restriction.addresses.label": "İzinli adresler (her satıra bir tam e-posta adresi)",
  "restriction.addresses.hint":
    "Alan adı veya joker (*) kullanılamaz. Yalnızca sizin veya açıkça izin verdiğiniz test adreslerini yazın. Mevcut uygunluk kuralları bu adreslere de uygulanır: kişisel posta sağlayıcıları (ör. gmail.com) ve kişi adlı adresler kampanyada zaten gönderime uygun sayılmaz; info@ veya sales@ gibi genel işletme adresleri kullanın.",
  "restriction.note.consumer":
    "{address}: kişisel posta sağlayıcısı; kampanyada gönderime uygun sayılmaz.",
  "restriction.note.personal":
    "{address}: genel işletme adresi değil (ör. info@, sales@); kampanyada gönderime uygun sayılmaz.",
  "restriction.save": "Kaydet",
  "restriction.saved": "Test modu ayarı kaydedildi.",
  "restriction.paused":
    "{n} çalışan canlı kampanya güvenlik için duraklatıldı; yalnızca açık onayla yeniden başlatılabilir.",
  "restriction.running": "Şu an {n} çalışan canlı kampanya var.",
  "restriction.corrupt":
    "Test modu ayarı okunamadı; güvenlik için canlı gönderim engelleniyor. Listeyi yeniden kaydedin.",
  "restriction.loosen.title": "Sınırı gevşetmek üzeresiniz",
  "restriction.loosen.body":
    "Bu değişiklik daha fazla adrese gönderime izin verir. {n} çalışan canlı kampanya güvenlik için duraklatılacak; bunları yalnızca açık onayla yeniden başlatabilirsiniz. Ertelenen alıcılara kendiliğinden gönderim başlamaz.",
  "restriction.loosen.confirm": "Gevşet ve kampanyaları duraklat",
  "restriction.banner":
    "Test modu açık: kampanya iletileri yalnızca {n} izinli adrese gönderilir. Normal gönderim için Ayarlar'dan kapatın.",
  "restriction.banner.link": "Ayarlar",
  "restriction.resume.title": "Bekleyen alıcılar var",
  "restriction.resume.body":
    "Bu kampanyada {waiting} alıcı gönderim sırasında bekliyor; bir kısmı test alıcı sınırı nedeniyle bekletiliyor olabilir. Devam ettirirseniz, sınır kalktıysa veya liste genişlediyse bu alıcılara e-posta gönderilmeye başlanır.",
  "restriction.resume.stillOn": "Test modu hâlâ açık: yalnızca {allowed} izinli adrese gönderilir.",
  "restriction.resume.off": "Test modu kapalı: bekleyen alıcıların hepsine gönderilebilir.",
  "restriction.resume.confirm": "Onaylıyorum, devam ettir",
  "preflight.held":
    "{n} alıcı test modu nedeniyle bekletilecek; hariç tutulmayacak, sınır kalkınca açık onayla devam eder.",
  "campaign.pause.restriction":
    "Kampanya, test alıcı sınırı değiştiği için duraklatıldı. Bekleyen alıcıları kontrol edip açık onayla devam ettirin.",
  "reason.recipient_not_allowed": "Test modu: adres izinli listede değil (bekletilir)",
  "apiError.LIST_REQUIRED": "Test modunu açmak için en az bir izinli adres yazın.",
  "apiError.TOO_MANY_ADDRESSES": "Çok fazla adres girildi; en çok 50 adres yazabilirsiniz.",
  "apiError.INVALID_ADDRESS":
    "Yalnızca geçerli tam e-posta adresleri yazılabilir (alan adı, joker veya görünen ad olmaz).",
  "apiError.LOOSENING_ACK_REQUIRED":
    "Sınırı gevşetmek için onay gerekir; çalışan canlı kampanyalar duraklatılır.",
  "apiError.RESTRICTION_ACK_REQUIRED":
    "Test alıcı sınırı nedeniyle bekleyen alıcılar var; kampanyayı sürdürmek için açık onay gerekir.",
} as const;
