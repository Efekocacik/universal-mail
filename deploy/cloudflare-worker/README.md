# Abonelikten çıkış sunucusu: Cloudflare Worker ile kurulum (önerilen)

Bu belge, Universal Mail'in **tek tıklamalı abonelikten çıkış aktarıcısını** (RFC 8058) ücretsiz bir Cloudflare
hesabında, **sunucu kiralamadan ve yönetmeden** kurmayı anlatır. Kurulum tarayıcıdan yapılır; komut satırı
gerekmez. Sonunda elinizde `https://um-relay.<hesap>.workers.dev` gibi bir adres olur ve bu adres uygulamadaki
**"Çıkış sunucusu adresi"** alanına yazılır.

Kendi Linux sunucunuzu (VPS) kullanmak isterseniz eşdeğer yol: [`deploy/relay/README.md`](../relay/README.md).
İkisi aynı protokolü konuşur; uygulama farkı anlamaz.

## Ne yapar, ne yapmaz?

- Alıcı e-postadaki "abonelikten çık" bağlantısına tıklar ya da Gmail tek tıklamalı çıkışı gönderir. Worker isteği
  `https://um-relay.<hesap>.workers.dev/u/<belirteç>` adresinde karşılar, belirteci **genel** anahtarla doğrular ve
  talebi Cloudflare **D1** veritabanına yazar. Alıcıya "tamam" yanıtı ancak kayıt bittikten sonra döner.
- Uygulama talepleri imzalı isteklerle **çeker** (`/spool/*`), kendi anahtarlarıyla yeniden doğrular ve ancak bundan
  sonra siler. Uygulama kapalıyken talepler D1'de bekler, kaybolmaz.
- Worker'da **hiçbir gizli anahtar yoktur**: yalnızca genel anahtarlar (`relay-keys.json`) yüklenir. Worker e-posta
  **göndermez**, uygulamanın veritabanına erişmez, hiçbir canlı gönderim kapısını açmaz.
- D1'de tutulan tek şey bekleyen çıkış belirteçleri ve zaman damgalarıdır; e-posta adresi veya kişisel veri yoktur.

## Gerekenler

| Gereken | Ayrıntı |
|---|---|
| Cloudflare hesabı | Ücretsiz plan yeterli (dash.cloudflare.com → kayıt). Hesaba **iki adımlı doğrulama** açın: hesaba girebilen biri anahtarları değiştirip bekleyen talepleri silebilir. |
| `worker.js` dosyası | Geliştirici depo kökünde `npm run build:worker` çalıştırır; çıktı `dist/cloudflare-worker/worker.js` (yaklaşık 40 KB, tek dosya). Dosyayı uygulamayla birlikte size verir. |
| `schema.sql` | Bu klasördeki [`schema.sql`](schema.sql) dosyası. |
| Uygulama | **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranı. |

Alan adı, DNS kaydı, sertifika veya sunucu **gerekmez**; HTTPS'i Cloudflare sağlar.

---

## Adım 1 — Veritabanını oluşturun (D1)

1. Cloudflare panelinde sol menüden **Storage & Databases → D1 SQL Database** sayfasını açın.
2. **Create** → ad olarak `um-relay` yazın → **Create**.
3. Açılan veritabanı sayfasında **Console** sekmesine geçin.
4. `schema.sql` dosyasını bir metin düzenleyiciyle açın, **tamamını** kopyalayıp konsola yapıştırın ve **Execute**'a
   basın. (Konsol birden çok komutu kabul etmezse dosyadaki komutları **sırayla** tek tek çalıştırın; her komut
   `CREATE` veya `INSERT` ile başlar ve `;` ile biten satırda biter. `CREATE TRIGGER … BEGIN … END;` satırı TEK
   komuttur, içindeki `;` yerinden bölünmez.)
5. Denetim: konsolda `SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger');` çalıştırın.
   `spool_events`, `spool_meta`, `spool_corrupt`, `replay_jti` tabloları ve `spool_events_count_insert`,
   `spool_events_count_delete` tetikleyicileri görünmelidir.

Şemayı ikinci kez çalıştırmak zararsızdır; var olan kayıtlara dokunmaz.

## Adım 2 — Worker'ı oluşturun

1. Sol menüden **Compute (Workers) → Workers & Pages** → **Create** → **Worker** → "Hello World" ile başlayın.
2. Ad olarak `um-relay` yazın → **Deploy**. (İlk Worker'ınızsa Cloudflare sizden bir hesap alt alanı seçmenizi
   ister; adresiniz `um-relay.<seçtiğiniz-ad>.workers.dev` olur.)
3. **Edit code**'a basın. Düzenleyicideki kodun **tamamını silin**, `worker.js` dosyasının içeriğini yapıştırın ve
   **Deploy**'a basın.
4. Worker'ın adresini not edin: `https://um-relay.<hesap>.workers.dev`.

## Adım 3 — Veritabanını Worker'a bağlayın

1. Worker sayfasında **Settings → Bindings → Add binding → D1 database**.
2. **Variable name**: `DB` (tam olarak böyle, büyük harfle). **D1 database**: `um-relay`. Kaydedin / **Deploy**.

## Adım 4 — İstek günlüklerini kapatın (zorunlu)

**Settings → Observability** altında **Workers Logs**'u (ve varsa **Logpush**/**Traces**'i) **kapatın** ve kaydedin.
Panelden oluşturulan yeni Worker'larda bu ayar açık gelebilir. Açıkken Cloudflare her isteğin tam adresini, yani
çıkış belirtecini de saklar; "belirteç günlüğe yazılmaz" güvencesi yalnızca bu ayar kapalıyken geçerlidir.
Worker'ın kendi yazdığı satırlarda belirteç veya adres yoktur.

## Adım 5 — Uygulamada adres ve anahtar dosyası

**Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranında sırayla:

1. **İmza anahtarı** → Anahtar oluştur. **Kanal anahtarı** → Anahtar oluştur.
2. **Çıkış sunucusu adresi** → `https://um-relay.<hesap>.workers.dev` (sonunda `/` veya yol olmadan) → Adresi kaydet.
3. **Anahtar dosyasını indir** → `relay-keys.json` iner. Dosya yalnızca genel anahtarları ve bu adresi içerir.

## Adım 6 — Anahtarları Worker'a gizli değişken olarak ekleyin

1. Worker sayfasında **Settings → Variables and Secrets → Add**.
2. **Type**: `Secret`. **Variable name**: `RELAY_KEYS`.
3. **Value**: `relay-keys.json` dosyasını metin düzenleyiciyle açın ve içeriğin **tamamını** olduğu gibi yapıştırın.
4. **Deploy**'a basın.

Anahtar yenilediğinizde, iptal ettiğinizde veya adresi değiştirdiğinizde dosyayı yeniden indirin ve `RELAY_KEYS`
değerini aynı yerden **Edit** ile güncelleyip yeniden dağıtın.

Cloudflare bir gizli değişkeni en çok **5 KB** kabul eder. Normal bir dosya bunun çok altındadır; ancak iptal
edilmeden biriken çok sayıda eski anahtar dosyayı büyütebilir ve panel değeri reddeder. Bu durumda uygulamada artık
kullanılmayan eski anahtarları iptal edip dosyayı yeniden indirin.

## Adım 7 — Denetleyin

1. Tarayıcıda `https://um-relay.<hesap>.workers.dev/healthz` adresini açın. `{"ok":true}` görmelisiniz.
   `{"ok":false}` görürseniz:
   - `RELAY_KEYS` eklenmemiş, eksik kopyalanmış ya da dosyadaki adres Worker adresiyle aynı değil (Adım 5–6),
   - `DB` bağlaması yok veya adı farklı (Adım 3),
   - şema çalıştırılmamış (Adım 1).
2. Uygulamada **Uçtan uca doğrula** → **Doğrula**. "Uç nokta doğrulandı." görmelisiniz. Bu deneme gerçek bir tek
   tıklamalı çıkış isteği gönderir ve talebi uygulamaya geri çeker; **hiçbir alıcıya dokunmaz**.
3. **Kuyruğu denetle** → "Kuyruk sağlıklı." ve **Talepleri düzenli çek**'i açın.
4. Worker → **Settings → Observability**: **Workers Logs** kapalı olmalı (Adım 4).

---

## Ücretsiz katman sınırları (özet)

Cloudflare'in güncel sınırlarını kendi sayfasından denetleyin; bu belge yazılırken ücretsiz plan yaklaşık olarak:

- **Workers**: günde 100.000 istek, istek başına 10 ms işlemci süresi.
- **D1**: günde 5 milyon okunan satır, 100.000 yazılan satır, toplam 5 GB depolama.

Uygulama açıkken dakikada bir tur atar; her tur en az iki istektir (talepleri çek + kuyruk durumu), yani günde
**~3.000 istek** ve birkaç bin okunan satır. Her çıkış (kayıt + uygulamanın onayı) dizinlerle birlikte yaklaşık
8–10 satır yazar ve birkaç satır okur; bekleyen talep sayısı ayrı bir sayaç satırında tutulduğu için kuyruk (uygulama
kapalıyken) birikse bile çıkış başına okuma **artmaz**. Bu, günde ~10.000 çıkışa kadar ücretsiz katman içinde kalır;
küçük ve orta kampanyalar için fazlasıyla yeterlidir. Sınır aşılırsa Worker hata verir ve uygulama talepleri çekemez; uygulama bunu "Kuyruğu denetle" ve uyarı
bandıyla gösterir, canlı gönderim kendiliğinden ertelenir.

## İsteğe bağlı: kendi alt alan adınız

`workers.dev` adresi yeterlidir. Kendi alt alan adınızı (ör. `cikis.firmaniz.com`) kullanmak isterseniz alan adı
Cloudflare'de olmalıdır: Worker → **Settings → Domains & Routes → Add → Custom domain**. Ardından:

1. Uygulamada adresi yeni adresle değiştirip anahtar dosyasını yeniden indirin ve `RELAY_KEYS`'i güncelleyin.
2. Daha önce gönderilmiş e-postalardaki bağlantılar eski adrese gider (belirteçler 180 gün geçerlidir). Bu yüzden
   `workers.dev` adresini **kapatmayın** ve Worker'a **Settings → Variables and Secrets → Add → Type: Text** ile
   `RELAY_PUBLIC_ORIGIN` = yeni adres (ör. `https://cikis.firmaniz.com`) ekleyin. Böylece iki adres de çalışır.
3. Alan adında "Bot Fight Mode" veya tarayıcı doğrulaması (challenge) açıksa Gmail'in tek tıklamalı çıkış isteği
   engellenebilir; çıkış adresi için kapalı tutun.

## Ayarlar (isteğe bağlı değişkenler)

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `RELAY_KEYS` (Secret, **zorunlu**) | — | `relay-keys.json` içeriği |
| `DB` (D1 bağlaması, **zorunlu**) | — | `schema.sql` uygulanmış D1 veritabanı |
| `RELAY_PUBLIC_ORIGIN` | isteğin kendi adresi | Anahtar dosyasındaki adres; adres değişikliğinde (yukarıda) |
| `RELAY_MAX_PENDING` | `10000` | Bekleyen talep üst sınırı; dolunca yeni çıkış 503 alır (talep atılmaz, istemci yeniden dener) |
| `RELAY_RATE_LIMIT_GET` / `RELAY_RATE_LIMIT_POST` | `60` / `300` | Dakikada istemci (IP) başına istek sınırı |

## Komut satırıyla kurulum (geliştirici için, isteğe bağlı)

Panel adımlarının eşdeğeri. `wrangler` projeye bağımlılık olarak eklenmez; `npx` ile geçici çalışır.

```sh
npm run build:worker                                   # dist/cloudflare-worker/worker.js
npx wrangler login
npx wrangler d1 create um-relay                        # çıkan database_id'yi wrangler.toml'a yazın
npx wrangler d1 execute um-relay --remote --file deploy/cloudflare-worker/schema.sql \
  --config deploy/cloudflare-worker/wrangler.toml
npx wrangler deploy --config deploy/cloudflare-worker/wrangler.toml
npx wrangler secret put RELAY_KEYS --config deploy/cloudflare-worker/wrangler.toml < relay-keys.json
```

`wrangler.toml` bir şablondur; içine gizli değer veya kişisel bilgi yazmayın (`database_id` gizli değildir).
`keep_vars = true` sayesinde panelden eklenen düz metin değişkenleri (ör. `RELAY_PUBLIC_ORIGIN`) `wrangler deploy`
ile silinmez; isterseniz bunları `[vars]` altına da yazabilirsiniz.

## Güvenlik notları

- Worker yalnızca genel anahtarları bilir; ele geçirilse bile uygulama adına talep çekemez veya alıcı çıkaramaz.
  Uygulama her talebi kendi anahtarlarıyla yeniden doğrular.
- `RELAY_KEYS`'in **bütünlüğü** önemlidir: kanal anahtarlarını değiştirebilen biri bekleyen talepleri çekip
  silebilir. Cloudflare hesabını iki adımlı doğrulamayla koruyun ve hesabı paylaşmayın.
- Hız sınırı istemci adresini yalnızca Cloudflare'in koyduğu `CF-Connecting-IP` başlığından alır. Sınır her Worker
  örneğinde ayrı tutulur; çok dağıtık bir saldırıya karşı tam koruma değildir. Geçersiz belirteçler veritabanına hiç
  yazılmaz ve onay sayfası (GET) veritabanına dokunmaz.
- Kripto yalnızca WebCrypto'dur (Ed25519, SHA-256); `nodejs_compat` bayrağı gerekmez.
