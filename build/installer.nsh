; Universal Mail: NSIS ek betiği (Faz 6, paket K). electron-builder.config.cjs `nsis.include` ile eklenir.
; Dosya UTF-8 (BOM'lu) kaydedilir; NSIS Türkçe karakterleri ancak böyle doğru okur.
;
; Kaldırırken "verilerimi de sil" sorusu (varsayılan: HAYIR):
;   - Yalnızca kullanıcı kaldırırken sorulur. Yeni sürüm eskisinin üzerine kurulurken electron-builder eski kaldırıcıyı
;     `--updated` ile çalıştırır; o durumda (${isUpdated}) HİÇBİR ŞEY sorulmaz ve veriler korunur.
;   - Sessiz kaldırmada (/S) sorulmaz ve veriler korunur.
;   - Yalnızca uygulamanın veri klasörü silinir: "$APPDATA\Universal Mail" (Electron userData). Başka klasöre dokunulmaz;
;     kullanıcının başka bir klasöre aldığı yedekler yerinde kalır.
;   - Soru, kaldırıcının diline göre Türkçe (1055) veya İngilizce gösterilir.
; Ayrıntı: docs/PAKETLEME.md. Denetim: tests/packaging-config.test.ts.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent um_keep_data
    SetShellVarContext current
    IfFileExists "$APPDATA\Universal Mail\*.*" 0 um_keep_data
    StrCmp $LANGUAGE "1055" 0 um_ask_en
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Universal Mail kaldırılıyor.$\n$\nVerilerinizi de silmek istiyor musunuz? (işletme listesi, kampanyalar, ayarlar, API anahtarları ve bu klasördeki yedekler)$\n$\n$APPDATA\Universal Mail$\n$\nBu işlem geri alınamaz. Verilerinizi saklamak için «Hayır»ı seçin." /SD IDNO IDYES um_delete_data IDNO um_keep_data
    um_ask_en:
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Universal Mail is being uninstalled.$\n$\nDo you also want to delete your data? (business list, campaigns, settings, API keys and the backups in this folder)$\n$\n$APPDATA\Universal Mail$\n$\nThis cannot be undone. Choose $\"No$\" to keep your data." /SD IDNO IDYES um_delete_data IDNO um_keep_data
    um_delete_data:
      RMDir /r "$APPDATA\Universal Mail"
    um_keep_data:
  ${endIf}
!macroend
