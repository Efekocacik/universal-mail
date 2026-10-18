# Veri kaynakları ve atıflar

## Şehir listesi (`cities.eu-tr.json`)

Şehir adları, koordinatları ve nüfus bilgileri **GeoNames** (https://www.geonames.org) veri tabanından
(`cities15000.zip`) türetilmiştir. Lisans: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Liste `scripts/build-cities.mjs` ile yeniden üretilebilir. Nüfus ≥ 50.000 olan şehirler ve ülke başkentleri
dahildir. Rusya, Belarus ve Ukrayna bilinçli olarak kapsam dışıdır.

Not: Şehir kutuları nüfustan tahmin edilen yaklaşık merkez yarıçaplarıdır, idari sınır değildir.
Kullanıcı yarıçapı değiştirebilir veya haritada kendi alanını çizebilir.
