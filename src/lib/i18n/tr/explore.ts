/**
 * Paket C (keşif: harita, seçim, kayıtlı süzgeçler, toplu işlemler, kısayollar) için yeni Türkçe anahtarlar.
 * Yalnızca C düzenler; karşılığı `en/explore.ts`.
 */
export const explore = {
  // Harita
  "map.selectInView": "Görünümdekileri seç ({n})",
  "map.selectInView.hint": "Haritada şu an görünen işletmelerin hepsini seçer.",
  "map.onlyThisArea": "Listede yalnızca bu alan",
  "map.legend.show": "Göstergeyi göster",
  "map.legend.hide": "Göstergeyi gizle",
  "map.legend.sent": "E-posta gönderildi",
  "map.legend.replied": "Yanıt verdi / müşteri",
  "map.legend.stopped": "İlgilenmiyor / iletişime geçme",
  "map.legend.selected": "Seçili",
  "map.marker.label": "İşletme: {novelty}",
  "map.marker.labelContact": "İşletme: {novelty} · {contact}",
  "map.schematic.badge": "Şematik demo görünümü",
  "map.schematic.hint": "Gerçek harita için Ayarlar'dan Google Maps anahtarı ekleyin.",

  // Seçim
  "selection.count": "{n} işletme seçili",
  "selection.hidden": "{n} tanesi bu listede görünmüyor",
  "selection.clear": "Seçimi temizle",
  "selection.allMatching": "Süzgece uyan {n} işletmenin tümü seçili",
  "selection.view": "Harita alanındaki {n} işletme seçili",
  "selection.invalidated": "Süzgeç değiştiği için seçim temizlendi.",
  "selection.cap":
    "Tek tek en fazla {n} işletme seçilebilir. Daha fazlası için “Süzgece uyan tümünü seç”i kullanın.",
  "selection.selectAll": "Süzgece uyan tümünü seç ({n})",
  "selection.capped":
    "Bir seferde en fazla {max} işletme işlenir; kalanlar için işlemi yeniden çalıştırın.",
  "list.row.select": "Seç: {name}",

  // Toplu işlemler
  "bulk.toolbar": "Seçili işletmeler için işlemler",
  "bulk.more": "Diğer işlemler",
  "bulk.archive": "Arşivle",
  "bulk.unarchive": "Arşivden çıkar",
  "bulk.dnc": "“İletişime geçme” olarak işaretle",
  "bulk.export": "Seçilenleri dışa aktar",
  "bulk.archive.title": "{n} işletme arşivlensin mi?",
  "bulk.archive.body":
    "Arşivlenen işletmeler listede, haritada ve dışa aktarımda görünmez; yeni taramalar da onları geri getirmez. Gönderim geçmişi korunur. İstediğiniz zaman “Arşivdekileri göster”den geri alabilirsiniz.",
  "bulk.archive.confirm": "Arşivle",
  "bulk.unarchive.title": "{n} işletme arşivden çıkarılsın mı?",
  "bulk.unarchive.body": "İşletmeler yeniden listede ve haritada görünür.",
  "bulk.unarchive.confirm": "Arşivden çıkar",
  "bulk.dnc.title": "{n} işletme “İletişime geçme” olarak işaretlensin mi?",
  "bulk.dnc.body":
    "Bu işletmelere hiçbir kampanyadan e-posta gönderilmez. İşaret toplu olarak kaldırılamaz; gerekirse işletmenin ayrıntısından tek tek kaldırabilirsiniz.",
  "bulk.dnc.confirm": "İşaretle",
  "bulk.preview.loading": "Etkilenecek işletmeler sayılıyor…",
  "bulk.preview.changed": "Değişecek",
  "bulk.preview.unchanged": "Zaten bu durumda",
  "bulk.preview.activeCampaign": "Kampanyası sürdüğü için atlanacak",
  "bulk.preview.notFound": "Artık bulunmayan",
  "bulk.preview.capped": "Süzgece {total} işletme uyuyor; bu seferde ilk {max} tanesi işlenecek.",
  "bulk.preview.nothing": "Değişecek işletme yok; seçilenlerin hepsi zaten bu durumda.",
  "bulk.done.archive": "{n} işletme arşivlendi.",
  "bulk.done.unarchive": "{n} işletme arşivden çıkarıldı.",
  "bulk.done.do_not_contact": "{n} işletme “İletişime geçme” olarak işaretlendi.",
  "bulk.done.skipped": "{n} işletme atlandı (zaten bu durumdaydı veya kampanyası sürüyor).",
  "bulk.undo": "Geri al",
  "bulk.undone": "Geri alındı.",
  "bulk.export.title": "Seçilen {n} işletmeyi CSV olarak dışa aktar",
  "bulk.export.started": "CSV dosyası indirildi.",
  "bulk.export.failed": "Dosya hazırlanamadı. Yeniden deneyin.",

  // Arşiv görünümü
  "filters.archived": "Arşivdekileri göster",
  "filters.archived.chip": "Arşiv",
  "list.archived.banner":
    "Arşivdeki işletmeleri görüyorsunuz. Geri almak için seçip “Arşivden çıkar”a basın.",

  // Yaşam döngüsü (yeni açılanlar vb.)
  "filters.lifecycle": "Gelişme",
  "lifecycle.opened": "Yeni açılanlar",
  "lifecycle.future": "Açılışı beklenenler",
  "lifecycle.new": "Yeni tespit edilenler",
  "filters.detected": "Ne zamandan beri",
  "filters.detected.any": "Tüm zamanlar",
  "filters.detected.7": "Son 7 gün",
  "filters.detected.30": "Son 30 gün",
  "filters.detected.days": "Son {n} gün",
  "filters.detected.since": "{date} tarihinden beri",

  // Kayıtlı süzgeçler
  "savedFilters.button": "Kayıtlı süzgeçler",
  "savedFilters.title": "Kayıtlı süzgeçler",
  "savedFilters.empty":
    "Henüz kayıtlı süzgeç yok. Süzgeçleri seçip “Bu süzgeci kaydet”e basın; sonra tek tıkla geri getirin.",
  "savedFilters.save": "Bu süzgeci kaydet…",
  "savedFilters.save.disabled": "Kaydetmek için önce en az bir süzgeç seçin.",
  "savedFilters.saveTitle": "Süzgeci kaydet",
  "savedFilters.saveBody":
    "Seçtiğiniz süzgeçler bu adla saklanır; sonra tek tıkla yeniden uygularsınız.",
  "savedFilters.name": "Ad",
  "savedFilters.name.placeholder": "Örn. Londra yeni kafeler",
  "savedFilters.includeArea": "Haritadaki alanı da kaydet",
  "savedFilters.includeArea.hint":
    "Açarsanız süzgeç uygulandığında harita bu alana gider ve liste yalnızca bu alanı gösterir.",
  "savedFilters.apply": "Uygula: {name}",
  "savedFilters.rename": "Yeniden adlandır",
  "savedFilters.renameLabel": "{name} süzgecini yeniden adlandır",
  "savedFilters.renameTitle": "Süzgeci yeniden adlandır",
  "savedFilters.deleteLabel": "{name} süzgecini sil",
  "savedFilters.deleteTitle": "“{name}” süzgeci silinsin mi?",
  "savedFilters.deleteBody": "Yalnızca kayıtlı süzgeç silinir; işletmeler etkilenmez.",
  "savedFilters.update": "Değişti · Güncelle",
  "savedFilters.updateLabel": "“{name}” süzgecini şu anki seçimlerle güncelle",
  "savedFilters.updated": "“{name}” güncellendi.",
  "savedFilters.saved": "“{name}” kaydedildi.",
  "savedFilters.deleted": "“{name}” silindi.",
  "savedFilters.exists":
    "Bu adla bir süzgeç zaten var. Üzerine yazabilir veya başka bir ad seçebilirsiniz.",
  "savedFilters.overwrite": "Üzerine yaz",
  "savedFilters.invalid": "Bu süzgeç artık kullanılamıyor (seçenekler değişmiş). Silebilirsiniz.",
  "savedFilters.partial": "Bazı kategoriler artık yok; süzgeç onlarsız uygulandı.",
  "savedFilters.active": "Kayıtlı süzgeç: {name}",
  "savedFilters.area": "Alan",

  // Klavye kısayolları
  "shortcuts.title": "Klavye kısayolları",
  "shortcuts.open": "Klavye kısayolları",
  "shortcuts.body": "Bir metin kutusuna yazarken kısayollar çalışmaz.",
  "shortcuts.group.global": "Her yerde",
  "shortcuts.group.explore": "Keşif ekranı",
  "shortcuts.next": "Sonraki işletme",
  "shortcuts.prev": "Önceki işletme",
  "shortcuts.search": "Aramaya git",
  "shortcuts.select": "İşletmeyi seç / seçimden çıkar",
  "shortcuts.findEmails": "E-posta bul",
  "shortcuts.addToCampaign": "Kampanyaya ekle",
  "shortcuts.fit": "Haritayı sonuçlara sığdır",
  "shortcuts.onlyInView": "Listede yalnızca harita alanı (aç/kapat)",
  "shortcuts.escape": "Çizimi iptal et, seçimi temizle, ayrıntıyı kapat",
  "shortcuts.help": "Bu yardımı aç",
  "shortcuts.or": "veya",

  // E-posta bulma ve kampanyaya ekleme (seçimle)
  "findEmails.capped":
    "Süzgece {matched} işletme uyuyor; bu seferde ilk {max} tanesi işlenir. Arama bitince yeniden başlatın; taranmış olanlar atlanır.",
  "addToCampaign.bodySelected":
    "Seçilen {n} işletme kampanyaya eklenir. Her biri uygunluk denetiminden geçer; uygun olmayanlar gerekçesiyle hariç tutulur.",
  "addToCampaign.progress": "Ekleniyor: {done} / {total}",

  // Tekil ayrıntı: uyum kilidini kaldırma onayı
  "detail.unblock.title": "“İletişime geçme” işareti kaldırılsın mı?",
  "detail.unblock.body":
    "Bu işletme iletişim istemediği için işaretlenmişti. İşareti kaldırırsanız yeniden kampanyalara eklenebilir. Bu değişiklik kayda geçer.",
  "detail.unblock.confirm": "İşareti kaldır",
} as const;
