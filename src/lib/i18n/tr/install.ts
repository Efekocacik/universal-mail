/**
 * Paket K (Faz 6): "Kurulumu tamamlayın" kartı (gösterge paneli), geçiş hatası kurtarma iletişim kutuları (Electron ana
 * süreci `t()` ile kullanır) ve menü eklemeleri. P0 başlattı; sonrasında yalnızca K düzenler. Karşılığı `en/install.ts`.
 */
export const install = {
  "onboarding.title": "Kurulumu tamamlayın",
  "onboarding.progress": "{done}/{total} tamamlandı",
  "onboarding.desc":
    "Universal Mail'i gerçek kullanıma hazırlamak için kalan adımlar. Her satırdaki bağlantı ilgili ekranı açar.",
  "onboarding.progressLabel": "Kurulum ilerlemesi",
  "onboarding.allDone.title": "Kurulum tamam",
  "onboarding.allDone.desc": "Bütün adımlar tamamlandı. Bu kartı artık gizleyebilirsiniz.",
  "onboarding.hide": "Gizle",
  "onboarding.hideLabel": "Kurulum listesini gizle",
  "onboarding.hidden": "Kurulum listesi gizlendi.",
  "onboarding.undo": "Geri al",
  "onboarding.show": "Kurulum listesini göster ({done}/{total})",
  "onboarding.statusDone": "Tamamlandı",
  "onboarding.statusTodo": "Yapılacak",
  "onboarding.demo": "Demo",
  "onboarding.demoHint": "Demo moduyla tamamlandı; gerçek kullanım için bu adımı ayrıca yapın.",
  "onboarding.open": "Aç",
  "onboarding.loadError": "Kurulum listesi yüklenemedi.",
  "onboarding.item.setup.title": "Kurulum sihirbazını bitirin",
  "onboarding.item.setup.desc":
    "Kullanım onayı, gönderen firma, hedef pazarlar, veri kaynağı ve bütçe.",
  "onboarding.item.dataSource.title": "Veri kaynağını bağlayın",
  "onboarding.item.dataSource.desc":
    "Google Places API anahtarınızı girin. Demo modu yalnızca denemek içindir.",
  "onboarding.item.firstScan.title": "İlk taramayı yapın",
  "onboarding.item.firstScan.desc": "Bir şehir veya alan seçip yeni açılan işletmeleri bulun.",
  "onboarding.item.mailbox.title": "Gmail kutunuzu bağlayın",
  "onboarding.item.mailbox.desc": "Gönderim izni verilmiş, bağlı bir Gmail kutusu gerekir.",
  "onboarding.item.testEmail.title": "Kendinize test e-postası gönderin",
  "onboarding.item.testEmail.desc":
    "İletinin ve alt bilginin alıcıya doğru göründüğünü kendi kutunuzda görün.",
  "onboarding.item.unsubscribe.title": "Abonelikten çıkış bağlantısını doğrulayın",
  "onboarding.item.unsubscribe.desc":
    "Alıcının tek tıkla çıkabildiği adresin uçtan uca çalıştığı sınanır.",
  "onboarding.item.backup.title": "Yedek parolası belirleyip ilk yedeği alın",
  "onboarding.item.backup.desc":
    "Parolayı yalnızca siz bilirsiniz; unutulursa yedek açılamaz. Yedeği ayrıca harici bir diske kopyalayın.",

  "electron.migrate.title": "Veritabanı güncellenemedi",
  "electron.migrate.body.BLOCKED":
    "Veritabanını şu an başka bir Universal Mail penceresi veya süreci kullanıyor. Diğer Universal Mail pencerelerini kapatıp «Yeniden dene»ye basın. Verilerinizde hiçbir değişiklik yapılmadı.",
  "electron.migrate.body.DISK_FULL":
    "Diskte yeterli boş yer yok. Diskte yer açın (ör. büyük dosyaları silin veya Çöp Kutusu'nu boşaltın) ve «Yeniden dene»ye basın.",
  "electron.migrate.body.CORRUPT":
    "Veritabanı dosyası bozuk görünüyor. Güncelleme öncesi kopya (varsa) güncellemeden birkaç saniye önce aynı dosyadan alındığı için aynı sorunu taşıyor olabilir. Şifreli otomatik yedekleriniz (.umbk) veri klasöründeki «backups» klasöründe durur; ancak şimdilik yalnızca uygulama açıkken (Ayarlar → Yedekler) geri yüklenebilir. Hiçbir dosyayı silmeyin; veri klasörünün yerini ve günlük klasörünü paylaşarak destek isteyin.",
  "electron.migrate.body.VERIFY_FAILED":
    "Güncelleme uygulandı ama sonrasındaki bütünlük denetimi başarısız oldu. Güncelleme öncesi yedeğe dönmeniz önerilir.",
  "electron.migrate.body.FAILED":
    "Verileriniz bu sürüme güncellenirken beklenmeyen bir hata oluştu. Yeniden deneyebilir, güncelleme öncesi yedeğe dönebilir veya destek isteyebilirsiniz.",
  "electron.migrate.backupAvailable":
    "Güncellemeden hemen önce alınmış otomatik bir yedek var; verilerinizi o hâline döndürebilirsiniz.",
  "electron.migrate.noBackup":
    "Güncelleme öncesi yedek yok (ilk kurulumda ve hiçbir değişiklik yapılmadığında yedek alınmaz).",
  "electron.migrate.retryExhausted":
    "Birkaç kez denendi ve sorun sürüyor. Uygulamayı kapatıp destek isteyin.",
  "electron.migrate.dataDir": "Veri klasörü: {dir}",
  "electron.migrate.btn.retry": "Yeniden dene",
  "electron.migrate.btn.restore": "Güncelleme öncesi yedeğe dön",
  "electron.migrate.btn.logs": "Günlük klasörünü aç",
  "electron.migrate.btn.quit": "Çık",
  "electron.migrate.btn.ok": "Tamam",
  "electron.migrate.confirm.title": "Güncelleme öncesi yedeğe dönülsün mü?",
  "electron.migrate.confirm.body":
    "Şu anki veritabanı silinmez; yedek klasörüne «{file}» adıyla taşınır ve yerine güncelleme öncesi kopya konur. Güncelleme açılışta yapıldığı için arada kaybolan bir değişiklik olmaz.",
  "electron.migrate.confirm.yes": "Yedeğe dön",
  "electron.migrate.confirm.no": "Vazgeç",
  "electron.migrate.restored.title": "Verileriniz güncelleme öncesi hâline döndü",
  "electron.migrate.restored.body":
    "Bu sürüm veritabanını güncelleyemedi. Önceki Universal Mail sürümünü yeniden kurun veya günlük klasörüyle birlikte destek isteyin. Uygulama şimdi kapanacak.",
  "electron.migrate.inUse.title": "Veritabanı şu an kullanımda",
  "electron.migrate.inUse.body":
    "Başka bir Universal Mail penceresi veya süreci veritabanını kullanıyor; dosyalar bu sırada değiştirilemez. Hiçbir şey değiştirilmedi. Diğer Universal Mail pencerelerini kapatıp yeniden deneyin.",
  "electron.migrate.restoreFailed.title": "Yedeğe dönülemedi",
  "electron.migrate.restoreFailed.body":
    "Yedeğe dönüş tamamlanamadı. Hiçbir dosya silinmedi ve veritabanınız olduğu gibi duruyor. Destek isterken günlük klasörünü paylaşın.",
  "electron.migrate.restoreFailed.partial":
    "Yedeğe dönüş yarıda kaldı ve bazı dosyalar geri alınamadı. Hiçbir dosya silinmedi: önceki veritabanınız yedek klasöründe «failed-migrate-…» adıyla duruyor. Uygulamayı açmadan destek isteyin.",
} as const;
