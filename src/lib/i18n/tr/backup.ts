/**
 * Paket Y (Faz 6): Ayarlar → Yedekler bölümü (yedek parolası, otomatik yedek, yedek listesi, geri yükleme, saklama süresi,
 * "tüm verilerimi sil"), Electron dosya seçme süzgeci ve `apiError.BACKUP_*` / `RESTORE_*` / `WIPE_*` / `LIFECYCLE_*` /
 * `RETENTION_*` metinleri. P0 başlattı; sonrasında yalnızca Y düzenler. Karşılığı `en/backup.ts`.
 * Bildirim metinleri (`notif.backupFailed.*`, `notif.retentionPurged.*`) `notifications.ts`'tedir.
 */
export const backup = {
  "settings.nav.backup": "Yedekler",
  "backup.title": "Yedekler ve veri saklama",
  "backup.desc":
    "Verilerinizin şifreli yedeklerini alın, gerekirse geri yükleyin; eski kayıtların ne kadar saklanacağını seçin.",
  "backup.fileFilter": "Universal Mail yedeği",
  "backup.loadError": "Yedek bilgileri yüklenemedi.",
  "backup.retry": "Yeniden dene",
  "backup.pending.restore.title": "Geri yükleme yeniden başlatmayı bekliyor",
  "backup.pending.restore.body":
    "Uygulama yeniden başladığında seçtiğiniz yedek geri yüklenecek. Mevcut verileriniz önce ayrıca kopyalanır.",
  "backup.pending.wipe.title": "Verileri silme yeniden başlatmayı bekliyor",
  "backup.pending.wipe.body":
    "Uygulama yeniden başladığında bu bilgisayardaki bütün Universal Mail verileri silinecek ve kurulum ekranı açılacak.",
  "backup.pending.wipe.backups": "Yedek dosyaları da silinecek.",
  "backup.pending.wipe.keepBackups": "Şifreli yedek dosyaları korunacak.",
  "backup.restart": "Şimdi yeniden başlat",
  "backup.restart.manual": "Uygulamayı kapatıp yeniden açın; işlem açılışta uygulanır.",
  "backup.pending.cancel": "İşlemi iptal et",
  "backup.pending.cancelled": "Bekleyen işlem iptal edildi.",
  "backup.result.restore.ok": "Yedek geri yüklendi.",
  "backup.result.restore.okSecrets": "Yedek, kayıtlı anahtarlarla birlikte geri yüklendi.",
  "backup.result.restore.fail":
    "Geri yükleme uygulanamadı; mevcut verileriniz değiştirilmedi. Yedeği yeniden seçip deneyin.",
  "backup.result.wipe.ok": "Verileriniz silindi. Uygulama ilk kurulumdaki gibi.",
  "backup.result.wipe.partial":
    "Verileriniz silindi ancak bazı dosyalar silinemedi. Ayrıntılar günlük dosyasında.",
  "backup.result.restore.paused":
    "Çalışan kampanyalar güvenlik için duraklatıldı ({n}). Yedekten sonra kimlere yazıldığını kontrol edip Kampanyalar sayfasından elle sürdürün.",
  "backup.result.restore.kept":
    "Yedekten sonra eklenen engel kayıtları (listeden çıkanlar, şikâyetler, silme talepleri) korundu: {n}.",
  "backup.result.restore.stopped":
    "Yedekten sonra e-posta gönderilmiş alıcıların sıradaki e-postaları iptal edildi (aynı kişiye ikinci kez yazılmasın diye): {n}.",
  "backup.result.restore.folderReset":
    "Yedekteki yedek klasörü bu bilgisayarda kullanılamıyor; yedekler artık varsayılan klasöre alınıyor.",
  "backup.result.restore.carryFailed":
    "Geri yükleme öncesindeki engel kayıtları aktarılamadı. Kampanyaları sürdürmeden önce engel listesini kontrol edin.",
  "backup.result.dismiss": "Tamam",
  "backup.pass.title": "Yedek parolası",
  "backup.pass.desc":
    "Yedekler bu parolayla şifrelenir. Parolayı güvenli bir yere not edin: unutursanız yedekler açılamaz ve kimse kurtaramaz.",
  "backup.pass.set": "Parola ayarlı",
  "backup.pass.missing": "Parola yok: otomatik yedek alınmıyor",
  "backup.pass.new": "Yeni parola",
  "backup.pass.confirm": "Parolayı tekrar yazın",
  "backup.pass.save": "Parolayı kaydet",
  "backup.pass.saved": "Yedek parolası kaydedildi.",
  "backup.pass.changeWarn":
    "Parolayı değiştirirseniz eski yedekler eski parolayla açılır. Eski parolayı da saklayın.",
  "backup.pass.rule": "En az 10 karakter; hepsi aynı karakter olmasın.",
  "backup.pass.mismatch": "İki parola aynı değil.",
  "backup.pass.strength": "Güç: {level}",
  "backup.pass.strength.weakest": "çok zayıf",
  "backup.pass.strength.weak": "zayıf",
  "backup.pass.strength.good": "iyi",
  "backup.pass.strength.strong": "güçlü",
  "backup.pass.show": "Parolayı göster",
  "backup.pass.hide": "Parolayı gizle",
  "backup.auto.title": "Otomatik yedek",
  "backup.auto.desc":
    "Uygulama her gün ilk açıldığında ve haftada bir kendiliğinden şifreli yedek alır.",
  "backup.auto.enabled": "Otomatik yedek al",
  "backup.auto.enabled.hint": "Kapatırsanız yedek yalnızca “Şimdi yedekle” ile alınır.",
  "backup.auto.onStartup": "Açılışta (günde bir kez)",
  "backup.auto.onStartup.hint": "Günün ilk açılışında yedek alınır.",
  "backup.auto.weekly": "Haftalık",
  "backup.auto.weekly.hint": "Son haftalık yedekten 7 gün sonra yeni yedek alınır.",
  "backup.auto.keepStartup": "Saklanacak açılış yedeği",
  "backup.auto.keepWeekly": "Saklanacak haftalık yedek",
  "backup.auto.keepHint":
    "Daha eski otomatik yedekler kendiliğinden silinir. Elle aldığınız yedekler silinmez.",
  "backup.auto.includeSecrets": "Kayıtlı anahtarları da yedekle",
  "backup.auto.includeSecrets.hint":
    "Google, Gmail ve diğer servis anahtarları yedeğe şifreli olarak eklenir; başka bir bilgisayarda geri yüklerken yeniden girmeniz gerekmez.",
  "backup.auto.noPass":
    "Önce bir yedek parolası belirleyin; parola olmadan otomatik yedek alınmaz.",
  "backup.auto.saved": "Yedek ayarları kaydedildi.",
  "backup.auto.keepInvalid": "Açılış için 1–30, haftalık için 1–52 arası bir sayı girin.",
  "backup.folder.label": "Yedek klasörü",
  "backup.folder.default": "Varsayılan klasör",
  "backup.folder.choose": "Klasör seç…",
  "backup.folder.reset": "Varsayılana dön",
  "backup.folder.input": "Klasörün tam yolu",
  "backup.folder.hint":
    "Harici bir disk veya bulutla eşitlenen bir klasör önerilir: bilgisayar arızalanırsa yedekler de kaybolmaz.",
  "backup.list.title": "Yedekler",
  "backup.list.desc": "Alınan yedekler. Dosyayı indirip başka bir yere de kopyalayabilirsiniz.",
  "backup.list.empty": "Henüz yedek yok.",
  "backup.list.missing": "Dosya bulunamadı",
  "backup.list.secrets": "Anahtarlar dahil",
  "backup.list.preMigrate":
    "Güncellemeler öncesi otomatik kopyalar (veri klasöründe, şifresiz): {n}",
  "backup.col.date": "Tarih",
  "backup.col.kind": "Tür",
  "backup.col.size": "Boyut",
  "backup.col.actions": "İşlemler",
  "backup.now": "Şimdi yedekle",
  "backup.now.done": "Yedek alındı.",
  "backup.now.skipped": "Yedek alındı. Okunamadığı için eklenmeyen anahtar sayısı: {n}",
  "backup.kind.manual": "Elle",
  "backup.kind.startup": "Açılış",
  "backup.kind.weekly": "Haftalık",
  "backup.status.running": "Sürüyor",
  "backup.status.failed": "Başarısız",
  "backup.download": "İndir",
  "backup.delete.title": "Yedek silinsin mi?",
  "backup.delete.body": "{name} dosyası kalıcı olarak silinir.",
  "backup.deleted": "Yedek silindi.",
  "backup.size.kb": "{size} KB",
  "backup.size.mb": "{size} MB",
  "backup.restore.title": "Geri yükle",
  "backup.restore.desc":
    "Bir yedeği geri yüklediğinizde şu anki verilerin yerini yedekteki veriler alır. Mevcut verileriniz önce ayrıca kopyalanır.",
  "backup.restore.this": "Geri yükle",
  "backup.restore.chooseFile": "Dosya seç…",
  "backup.restore.upload": "Yedek dosyası yükle",
  "backup.restore.otherHint":
    "Listedeki bir yedeği “Geri yükle” ile seçin ya da başka bir yerdeki .umbk dosyasını açın.",
  "backup.restore.dialog.title": "Yedeği geri yükle",
  "backup.restore.dialog.passphrase": "Bu yedeğin parolası",
  "backup.restore.dialog.passHint": "Yedeğin alındığı andaki yedek parolası.",
  "backup.restore.verify": "Yedeği denetle",
  "backup.restore.summary":
    "{leads} işletme, {campaigns} kampanya, {messages} e-posta, {templates} şablon",
  "backup.restore.summaryMeta": "{date} tarihinde alındı ({ago}), sürüm {version}",
  "backup.restore.migration":
    "Bu yedek eski bir sürümle alınmış; açılışta veritabanı kendiliğinden güncellenecek.",
  "backup.restore.secrets": "Kayıtlı anahtarları da geri yükle",
  "backup.restore.secrets.hint":
    "Yedekteki Google, Gmail ve diğer servis anahtarları şu ankilerin yerine geçer.",
  "backup.restore.confirm":
    "Bu bilgisayardaki şu anki verilerin yerini bu yedeğin alacağını anlıyorum.",
  "backup.restore.schedule": "Geri yüklemeyi başlat",
  "backup.restore.scheduled": "Geri yükleme hazır. Uygulama yeniden başlayınca uygulanacak.",
  "backup.restore.expires": "Bu hazırlık bir saat geçerlidir.",
  "backup.restore.after":
    "Geri yüklemeden sonra çalışan kampanyalar duraklatılır; siz kontrol edip sürdürürsünüz. Yedekten sonra eklenen engel kayıtları ve silme talepleri korunur.",
  "backup.restore.scheduledSafety":
    "Geri yükleme hazır. Şu anki verileriniz de şifreli bir yedek olarak kaydedildi; gerekirse listeden ona geri dönebilirsiniz.",
  "backup.restore.uploadLimit":
    "Yüklenebilecek en büyük dosya {mb} MB. Daha büyük yedekleri masaüstü uygulamasında “Dosya seç…” ile açın.",
  "campaign.pause.restore":
    "Kampanya, yedek geri yüklendiği için duraklatıldı. Yedekten sonra kimlere yazıldığını kontrol edip devam ettirin.",
  "backup.ret.title": "Saklama süresi",
  "backup.ret.desc":
    "Hiç e-posta gönderilmemiş ve kampanyaya eklenmemiş eski işletme kayıtları bu süreden sonra kendiliğinden silinir (en çok 12 ay).",
  "backup.ret.enabled": "Eski kayıtları kendiliğinden sil",
  "backup.ret.enabled.hint": "Her gün bir kez denetlenir.",
  "backup.ret.months": "Saklama süresi",
  "backup.ret.monthsValue": "{months} ay",
  "backup.ret.kept":
    "Korunanlar: e-posta gönderilmiş veya kampanyaya eklenmiş işletmeler, “iletişim kurma” işaretliler, engel listesi ve yasal kayıtlar.",
  "backup.ret.preview": "Şu an silinecek: {n}",
  "backup.ret.previewHint": "{date} öncesinde eklenmiş kayıtlar.",
  "backup.ret.run": "Şimdi uygula",
  "backup.ret.run.title": "Eski kayıtlar şimdi silinsin mi?",
  "backup.ret.run.body":
    "Kalıcı olarak silinecek işletme kaydı: {n}. Bu işlem geri alınamaz; yedekleriniz etkilenmez.",
  "backup.ret.done": "Silinen kayıt: {n}",
  "backup.ret.lastRun": "Son çalışma: {date} · silinen: {n}",
  "backup.ret.saved": "Saklama süresi kaydedildi.",
  "backup.wipe.title": "Tüm verilerimi sil",
  "backup.wipe.desc":
    "Bu bilgisayardaki bütün Universal Mail verilerini (işletmeler, kampanyalar, e-postalar, ayarlar, kayıtlı anahtarlar, günlükler) siler. Uygulama yeniden başlayınca kurulum ekranı açılır. Gmail hesabınızdaki e-postalar ve Google hesabınız etkilenmez.",
  "backup.wipe.open": "Verilerimi silmeye başla",
  "backup.wipe.dialog.title": "Bütün veriler silinsin mi?",
  "backup.wipe.dialog.body": "Bu işlem geri alınamaz. Devam etmek için kutuya {phrase} yazın.",
  "backup.wipe.phrase": "VERİLERİMİ SİL",
  "backup.wipe.input": "Onay ifadesi",
  "backup.wipe.deleteBackups": "Yedek dosyalarını da sil",
  "backup.wipe.deleteBackups.hint":
    "İşaretlemezseniz şifreli yedek dosyaları kalır; ileride geri yükleyebilirsiniz.",
  "backup.wipe.confirm": "Silmeyi planla",
  "backup.wipe.scheduled": "Silme planlandı. Uygulama yeniden başlayınca uygulanacak.",
  "apiError.BACKUP_PASSPHRASE_REQUIRED":
    "Önce bir yedek parolası belirleyin. Yedekler bu parolayla şifrelenir.",
  "apiError.BACKUP_PASSPHRASE_WEAK":
    "Parola çok kısa veya çok basit. En az 10 karakter kullanın ve hepsi aynı karakter olmasın.",
  "apiError.BACKUP_PASSPHRASE_MISMATCH": "İki parola aynı değil. Lütfen yeniden yazın.",
  "apiError.BACKUP_IN_PROGRESS": "Şu anda bir yedek alınıyor. Bitmesini bekleyip yeniden deneyin.",
  "apiError.BACKUP_FOLDER_INVALID":
    "Bu klasör kullanılamaz. Var olan bir klasör seçin (uygulamanın kendi klasörü olamaz).",
  "apiError.BACKUP_FOLDER_UNWRITABLE":
    "Bu klasöre yazılamıyor. Başka bir klasör seçin veya varsayılan klasöre dönün.",
  "apiError.BACKUP_DISK_FULL": "Diskte yeterli yer yok. Yer açıp yeniden deneyin.",
  "apiError.BACKUP_FAILED":
    "Yedek alınamadı. Yeniden deneyin; sürerse günlük klasörünü destek ekibine iletin.",
  "apiError.BACKUP_FILE_MISSING":
    "Yedek dosyası bulunamadı. Taşınmış veya silinmiş olabilir; listeden kaldırabilirsiniz.",
  "apiError.BACKUP_BAD_FORMAT": "Bu dosya bir Universal Mail yedeği değil veya okunamıyor.",
  "apiError.BACKUP_WRONG_PASSPHRASE":
    "Parola bu yedeğe uymuyor. Yedeğin alındığı andaki parolayı yazın.",
  "apiError.BACKUP_CORRUPT":
    "Yedek dosyası bozulmuş veya değiştirilmiş; geri yüklenemez. Başka bir yedek deneyin.",
  "apiError.BACKUP_SCHEMA_NEWER":
    "Bu yedek uygulamanın daha yeni bir sürümüyle alınmış. Önce uygulamayı güncelleyin.",
  "apiError.BACKUP_TOO_LARGE":
    "Dosya yükleme için çok büyük (en çok 9 MB). Masaüstü uygulamasında “Dosya seç…” ile seçin.",
  "apiError.RESTORE_STAGE_NOT_FOUND":
    "Geri yükleme hazırlığının süresi doldu. Yedeği yeniden seçip parolayı tekrar girin.",
  "apiError.RESTORE_CONFIRM_REQUIRED": "Geri yüklemeyi başlatmak için onay kutusunu işaretleyin.",
  "apiError.WIPE_CONFIRM_MISMATCH":
    "Onay metni uyuşmuyor. Kutuya tam olarak gösterilen ifadeyi yazın.",
  "apiError.LIFECYCLE_PENDING":
    "Yeniden başlatmayı bekleyen bir işlem var. Önce uygulamayı yeniden başlatın veya o işlemi iptal edin.",
  "apiError.RETENTION_PREVIEW_STALE":
    "Silinecek kayıt sayısı siz bakarken arttı. Güncel sayıya bakıp yeniden onaylayın.",
} as const;
