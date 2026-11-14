/**
 * Paket I (Faz 5): CSV/XLSX içe aktarma sayfası, eşleme arayüzü, kullanım onayı, sonuç listeleri ve `apiError.IMPORT_*`. P0 başlattı; sonrasında yalnızca I düzenler.
 * Karşılığı `en/imports.ts`.
 */
export const imports = {
  "imports.title": "Listeden içe aktar",
  "imports.subtitle":
    "Elinizdeki CSV veya Excel (XLSX) listesindeki işletmeleri lead olarak ekleyin.",
  "apiError.IMPORT_TOO_LARGE": "Dosya 5 MB'tan büyük. Listeyi bölüp parça parça yükleyin.",
  "apiError.IMPORT_UNSUPPORTED": "Bu dosya türü desteklenmiyor. CSV veya XLSX dosyası seçin.",
  "apiError.IMPORT_PARSE":
    "Dosya okunamadı. Bozuk, şifreli veya farklı biçimde olabilir; CSV olarak yeniden kaydedip deneyin.",
  "apiError.IMPORT_EMPTY": "Dosyada içe aktarılacak satır yok.",
  "apiError.IMPORT_TOO_MANY_ROWS":
    "Dosyada 5.000'den fazla satır var. Listeyi bölüp parça parça yükleyin.",
  "apiError.IMPORT_MAPPING":
    "İşletme adı sütununu seçin; ülke sütunu yoksa varsayılan ülkeyi belirtin.",
  "apiError.IMPORT_ACK_REQUIRED":
    "Listeyi kullanma hakkınız olduğunu onaylayın ve kaynağını yazın.",
} as const;
