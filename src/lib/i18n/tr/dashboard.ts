/**
 * Gösterge paneli (Paket E) Türkçe anahtarları. Karşılığı `en/dashboard.ts` (tamamı çevrilidir).
 */
export const dashboard = {
  "nav.dashboard": "Gösterge paneli",
  "dash.title": "Gösterge paneli",
  "dash.desc": "Yeni bulunan işletmeler, bugünkü gönderimler ve aylık harcama tek bakışta.",
  "dash.cta.explore": "Keşfe git",
  "dash.updated": "Son güncelleme: {time}. Sayfa her dakika kendini yeniler.",
  "dash.refresh": "Yenile",
  "dash.loadError": "Gösterge paneli yüklenemedi.",
  "dash.loadError.next": "Birkaç saniye sonra yeniden deneyin; sürerse uygulamayı kapatıp açın.",
  "dash.sectionError": "Bu bölüm şu an yüklenemedi. Sayfa bir dakika içinde yeniden dener.",
  "dash.stats.label": "Özet sayılar",
  "dash.stat.businesses": "İşletme",
  "dash.stat.businesses.help": "Keşif'te kayıtlı bütün işletmeler. Arşivlenenler sayılmaz.",
  "dash.stat.withEmail": "E-postası bulunan",
  "dash.stat.withEmail.help": "İşletmenin kendi web sitesinde iletişim e-postası bulunanlar.",
  "dash.stat.newThisWeek": "Bu hafta yeni",
  "dash.stat.newThisWeek.help":
    "Pazartesiden bu yana taramalarda ilk kez görülen işletmeler. Tıklayınca Keşif'te listelenir.",
  "dash.stat.openedThisWeek": "Bu hafta açılan",
  "dash.stat.openedThisWeek.help":
    'Daha önce "yakında açılacak" görünen ve bu hafta açıldığı görülen işletmeler.',
  "dash.stat.activeCampaigns": "Aktif kampanya",
  "dash.stat.activeCampaigns.paused": "{n} duraklatıldı",
  "dash.stat.sentToday": "Bugün gönderilen",
  "dash.stat.sentToday.help":
    "Bugün (sizin saatinizle, gece yarısından beri) gönderilen kampanya e-postaları. Posta kutusu günlük sınırları ise UTC gününe göre sayılır ve Türkiye saatiyle 03:00'te sıfırlanır; iki sayı farklıysa altta gösterilir.",
  "dash.stat.sentToday.limitDay": "Günlük sınır sayacında {n} ({time} itibarıyla)",
  "dash.stat.sentMonth": "Bu ay gönderilen",
  "dash.stat.replies": "Yanıtlar (bu ay)",
  "dash.stat.replies.pending": "{n} incelemede bekliyor",
  "dash.stat.replies.negative": "{n} tanesi ilgilenmiyor",
  "dash.stat.replies.help":
    "Bu ay işletmelerden gelen gerçek yanıtlar; “ilgilenmiyorum” diyenler de dahildir. Otomatik yanıtlar, geri dönen e-postalar ve abonelikten çıkma istekleri sayılmaz.",
  "dash.queue.title": "Bugünkü gönderim sırası",
  "dash.queue.help":
    "Her posta kutusunun bugünkü sınırı ve sıradaki gönderimi. Gönderimler arasında en az 90 saniye beklenir; sınırlar UTC gününe göre sayılır.",
  "dash.queue.used": "{used} / {cap} gönderildi",
  "dash.queue.waiting": "{n} kişi sırada",
  "dash.queue.state.due":
    "Sırası gelen {n} kişi var; gönderim penceresi açıkken ve kurallar uygunsa sırayla gönderilir.",
  "dash.queue.state.next": "Sonraki gönderim {when}.",
  "dash.queue.state.capReached": "Bugünkü sınır doldu; gönderim {time} sonrasında sürer.",
  "dash.queue.state.capReachedNoTime": "Bugünkü sınır doldu; gönderim yarın sürer.",
  "dash.queue.state.backoff":
    "Google bu kutuyu geçici olarak beklemeye aldı; {when} yeniden denenecek.",
  "dash.queue.state.reauth":
    "Gmail bağlantısının yenilenmesi gerekiyor. Ayarlar → Posta kutuları bölümünden yeniden bağlayın.",
  "dash.queue.state.idle": "Çalışan kampanyada bu kutudan sırada bekleyen kişi yok.",
  "dash.queue.empty":
    "Bağlı posta kutusu yok. Kampanya göndermek için önce bir posta kutusu bağlayın.",
  "dash.queue.empty.cta": "Posta kutularına git",
  "dash.queue.editLimit": "Günlük sınırı değiştir",
  "dash.budget.title": "Google harcaması (bu ay)",
  "dash.budget.help":
    "Google Haritalar aramalarının bu ayki tahmini maliyeti. Bütçe dolunca yeni aramalar ay sonuna kadar durur; e-posta gönderimi etkilenmez.",
  "dash.budget.spent": "{spent} / {limit}",
  "dash.budget.left": "Kalan: {left}",
  "dash.budget.projection": "Bu hızla ay sonunda yaklaşık {usd} olur.",
  "dash.budget.projectionOver": "Bu hızla ay sonundan önce bütçe dolabilir (tahmini {usd}).",
  "dash.budget.warning": "Bütçenin büyük kısmı kullanıldı.",
  "dash.budget.blocked": "Bütçe doldu: yeni Google aramaları ay sonuna kadar durdu.",
  "dash.budget.mock": "Demo veri kullanılıyor; Google ücreti oluşmaz.",
  "dash.budget.edit": "Bütçeyi değiştir",
  "dash.new.title": "Bu hafta yeni açılanlar",
  "dash.new.desc": "Pazartesiden bu yana açıldığı görülen veya ilk kez bulunan işletmeler.",
  "dash.new.kind.opened": "Açıldı",
  "dash.new.kind.new": "Yeni",
  "dash.new.unnamed": "Adı henüz yüklenmedi",
  "dash.new.more": "ve {n} işletme daha",
  "dash.new.seeOpened": "Açılanları Keşif'te gör",
  "dash.new.seeNew": "Yenileri Keşif'te gör",
  "dash.new.empty": "Bu hafta henüz yeni işletme yok. Taramalar düzenli çalıştıkça burada görünür.",
  "dash.scans.title": "Yaklaşan taramalar",
  "dash.scans.help":
    "Düzenli taramalar uygulama açıkken kendiliğinden başlar. Bütçe veya ayarlar uygun değilse atlanır ve bildirim gelir.",
  "dash.scans.active": "{n} tarama şu an sürüyor.",
  "dash.scans.every": "her {days} günde bir",
  "dash.scans.overdue": "Zamanı geldi; uygulama açıkken başlar.",
  "dash.scans.skipped": "Son çalışma atlandı; ayrıntı için Taramalar sayfasına bakın.",
  "dash.scans.empty":
    "Planlı tarama yok. Bir bölgeyi düzenli taratmak için Taramalar sayfasını kullanın.",
  "dash.scans.cta": "Taramalara git",
  "dash.notif.title": "Son bildirimler",
  "dash.notif.unread": "{n} okunmamış",
  "dash.notif.empty":
    "Henüz bildirim yok. Tarama bittiğinde veya yeni işletme bulunduğunda burada görünür.",
  "dash.notif.open": "Aç",
  "dash.notif.unreadItem": "Okunmamış",
  "dash.notif.openLabel": "Bildirimi aç: {title}",
} as const;
