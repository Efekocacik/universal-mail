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
    "Dosya yükleme için çok büyük. Masaüstü uygulamasında “Dosya seç…” ile seçin.",
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
