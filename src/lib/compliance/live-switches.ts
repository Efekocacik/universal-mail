/**
 * Gerçek (canlı) gönderim ve gelen kutusu okuma KOD KAPILARI. Bu dosya yalnızca iki sabit içerir; başka hiçbir mantık
 * veya içe aktarma yoktur. Sabitler `policies.ts` üzerinden yeniden dışa aktarılır, uygulamanın geri kalanı bunları
 * `@/lib/compliance/policies` yolundan içe aktarmaya devam eder.
 *
 * NEDEN AYRI DOSYA: `resolveCountryPolicy` (policies.ts) kapıyı kendi modülünden okurdu; bir testin kapıyı "açık"
 * varsayması için modülün DIŞINDAN geçersiz kılınabilen tek yer burasıdır. Böylece kapı AÇIKKEN çalışma anı korumaları
 * (ülke kilidi, DNS, çıkış bağlantısı, suppression) gerçek kodla sınanabilir, gerçek sabitler ise KAPALI kalır. Üretimde
 * bu dosya hiçbir testle geçersiz kılınmaz; yalnızca `NODE_ENV=test` altında Vitest bunu yapar.
 */

/**
 * Gerçek gönderimin kod kapısı. KAPALI (güvenli varsayılan; fix/live-gates-fail-closed): bu sürümde hiçbir Gmail
 * kutusundan gerçek kampanya iletisi gönderilmez, yalnızca demo posta kutusu ve demo sağlayıcısı çalışır. Daha önce
 * sahip kararıyla (11 Kasım 2026) açılmıştı; bu karar müşteriye teslimat öncesi geri alındı. Yeniden açılması, şirketin
 * yetkili temsilcisinin yetkilendirmesi ve gerekli hukuki doğrulamalar tamamlandıktan sonra, kaydı tutulan AYRI bir
 * yazılım sürümüyle yapılır; bu sabitin `true` yazması hukuki onay yerine geçmez. Açıldığında bile kapı tek başına
 * gönderim DEMEK DEĞİLDİR: bağlı Gmail kutusu (`gmail.send`), taze ve geçen DNS denetimi, doğrulanmış HTTPS çıkış uç
 * noktası, sağlıklı çıkış çekme işi ve kilidi açılmış canlı ülke politikası çalışma anında ayrıca zorunludur (bkz.
 * `send-service.ts`, `eligibility.ts`). "Kendime test gönder" bu kapıdan BAĞIMSIZDIR ve yalnızca kutunun kendi
 * adresine gider (bkz. `test-send.ts`).
 */
export const LIVE_SENDING_ENABLED = false;

/**
 * Gerçek (Gmail) gelen kutusunu OKUMA kilidi (Aşama 15.5). Gönderim kilidinden ayrıdır. KAPALI (güvenli varsayılan;
 * fix/live-gates-fail-closed): gerçek gelen kutusu okunmaz, yalnızca demo gelen kutusu çalışır. Açılması gönderim
 * kilidiyle aynı koşullara bağlıdır ve ayrıca `gmail.readonly` izni ister. Açıldığında okuyucu yalnızca bağlı ve
 * `gmail.readonly` izni verilmiş Gmail kutularını okur; başlık güveni (`GMAIL_HEADER_TRUST_VERIFIED`) kapalı kaldıkça
 * okunan hiçbir ileti tasdik üretmez: iletiler yalnızca inceleme için kaydedilir; doğrulanmış bounce/suppression/
 * otomatik durdurma doğmaz (kanıt düzeyi düşük kalır).
 */
export const LIVE_INBOX_READING_ENABLED = false;
