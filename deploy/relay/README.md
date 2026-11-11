# Abonelikten çıkış aktarıcısı: küçük bir Linux sunucusuna kurulum

Bu belge, Universal Mail'in **tek tıklamalı abonelikten çıkış aktarıcısını** (RFC 8058) küçük bir Linux sunucusuna
(VPS) adım adım kurmayı anlatır.

## Aktarıcı ne yapar, ne yapmaz?

- Alıcı e-postadaki "abonelikten çık" bağlantısına tıklar ya da Gmail tek tıklamalı çıkışı gönderir. Aktarıcı bu
  isteği `https://<alt-alan-adınız>/u/<belirteç>` adresinde karşılar.
- Belirteci **genel** anahtarla doğrular ve olayı diske **dayanıklı** biçimde yazar. Alıcıya 200 yanıtı ancak yazım
  bittikten sonra döner.
- Masaüstü uygulaması olayları imzalı isteklerle **çeker** (`/spool/*`), kendi anahtarlarıyla yeniden doğrular ve
  ancak bundan sonra onaylar (siler).
- Aktarıcıda **hiçbir gizli anahtar yoktur.** Sunucuya yalnızca genel anahtarlar gider. Aktarıcı e-posta
  **göndermez**, uygulamanın veritabanına erişmez ve hiçbir canlı gönderim kapısını açmaz.
- Masaüstü uygulaması aktarıcıyı kendi barındıramaz: yalnızca 127.0.0.1'i dinler ve yabancı Host'u reddeder. Bu
  yüzden ayrı, herkese açık bir sunucu gerekir.

## Ön koşullar

| Gereken | Ayrıntı |
|---|---|
| Alt alan adı | Örneğin `cikis.firma.com`. DNS'te sunucunun IP'sine giden **A** (ve varsa **AAAA**) kaydı olmalı. DNS **Cloudflare**'daysa (ör. `cikis.gurcankagitpromosyon.com`) kayıt **"DNS only" (gri bulut)** olmalı; Cloudflare proxy'si (turuncu bulut) kullanılmaz, istekler ve sertifika doğrulaması doğrudan Caddy'ye ulaşmalıdır. Gönderen hesabın kişisel Gmail olması veya alan adında MX bulunmaması aktarıcıyı etkilemez. |
| Sunucu | Debian 12 veya Ubuntu 24.04; 1 vCPU ve 512 MB RAM yeterli. **Kalıcı** ext4/xfs disk gerekir (geçici/tmpfs olmamalı). |
| Erişim | SSH; 80 ve 443 portları internete açık olmalı. |
| Saat | NTP açık olmalı. Kanal en çok ±5 dakika saat farkına izin verir. |
| Uygulama tarafı | Uygulamada **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranında imza anahtarı, kanal anahtarı ve "Çıkış sunucusu adresi" tanımlı olmalı. Anahtar dosyası (`relay-keys.json`) aynı ekrandaki "Anahtar dosyasını indir" düğmesiyle indirilir. |

> **Port yazmayın.** Uygulama, çıkış adresinde açık port (`:8443` gibi) kabul etmez. Aktarıcı mutlaka standart
> **443** portunda yayın yapmalıdır. `/u/*` ve `/spool/*` aynı kökende (aynı alt alan adında) olmalıdır.

Aşağıdaki komutlarda `cikis.firma.com` yerine kendi alt alan adınızı, `kullanici@sunucu` yerine kendi SSH
bağlantınızı yazın.

---

## 1. Paketi derleyin (geliştirici bilgisayarında)

Depo kökünde şunu çalıştırın:

```bash
npm run build:relay
```

Çıktı tek bir dosyadır: `dist/relay/relay.cjs` (yaklaşık 40 KB). Dış bağımlılığı yoktur, yalnızca Node.js 22 veya
üstü gerekir. Paketi sunucuya kopyalayın:

```bash
scp dist/relay/relay.cjs deploy/relay/um-relay.service deploy/relay/Caddyfile kullanici@sunucu:/tmp/
```

## 2. Node.js 22'yi kurun (sunucuda)

Debian/Ubuntu depolarındaki Node sürümü eskidir. NodeSource deposundan kurun:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh        # betiği çalıştırmadan önce gözden geçirin
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node -v                              # v22.x veya üstü olmalı
which node                           # /usr/bin/node (systemd birimi bu yolu kullanır)
```

## 3. Sistem kullanıcısını ve dizinleri oluşturun

```bash
# Oturum açamayan sistem kullanıcısı
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin umrelay

# Program: root sahibi, herkes okuyabilir, kimse yazamaz
sudo install -d -o root -g root -m 0755 /opt/um-relay
sudo install -o root -g root -m 0644 /tmp/relay.cjs /opt/um-relay/relay.cjs

# Anahtar dosyası dizini: root yazar, umrelay yalnızca okur
sudo install -d -o root -g umrelay -m 0750 /etc/um-relay
```

Veri dizini `/var/lib/um-relay` dizinini systemd oluşturur (`StateDirectory`). Sahibi `umrelay`, izni 0700 olur.
Kuyruk `spool/` alt dizininde, tekrar kaydı `replay.log` dosyasında tutulur.

## 4. systemd hizmetini kurun

```bash
sudo install -o root -g root -m 0644 /tmp/um-relay.service /etc/systemd/system/um-relay.service
sudo nano /etc/systemd/system/um-relay.service
#   Environment=RELAY_PUBLIC_ORIGIN=https://cikis.firma.com   ← kendi alt alan adınız
sudo systemctl daemon-reload
sudo systemctl enable --now um-relay
sudo systemctl status um-relay --no-pager
```

Beklenen günlük satırları:

```
um-relay listening on 127.0.0.1:8787 origin=https://cikis.firma.com
um-relay: no valid key file yet; /u and /spool answer 503 until keys are deployed
```

Yalnızca **tek** örnek çalıştırın: dosya kuyruğu tek yazar varsayar.

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `RELAY_PUBLIC_ORIGIN` | (zorunlu) | `https://cikis.firma.com`. Uygulamadaki çıkış adresiyle aynı olmalı. İstek adresleri bundan kurulur; `Host` başlığına güvenilmez. |
| `RELAY_HOST` | `127.0.0.1` | Dinleme adresi. Caddy aynı makinedeyse değiştirmeyin. |
| `RELAY_PORT` | `8787` | Dinleme portu. İnternete **açılmaz**; yalnızca Caddy erişir. |
| `RELAY_DATA_DIR` | `/var/lib/um-relay` | Kuyruk (`spool/`) ve tekrar kaydı. Kalıcı disk olmalı. |
| `RELAY_KEYS_FILE` | `/etc/um-relay/keys.json` | Uygulamadan indirilen anahtar dosyası. |
| `RELAY_MAX_PENDING` | `100000` | Onaylanmamış en çok olay. Dolunca yeni istekler 503 alır; olaylar sessizce atılmaz. |
| `RELAY_SINK_TIMEOUT_MS` | `10000` | Diske yazım için en uzun bekleme. Aşılırsa 503 döner. |
| `RELAY_RATE_LIMIT_GET` | `60` | İstemci başına, pencere başına GET/HEAD sınırı. |
| `RELAY_RATE_LIMIT_POST` | `300` | İstemci başına POST sınırı. Gmail paylaşılan adreslerden POST gönderdiği için daha geniştir. |
| `RELAY_RATE_WINDOW_MS` | `60000` | Hız sınırı penceresi. |
| `RELAY_TRUST_PROXY_HEADER` | `x-real-ip` | İstemci adresini taşıyan vekil başlığı. **Yalnızca** bağlantı geri döngüden (127.0.0.1/::1) ya da `RELAY_TRUSTED_PROXIES` içinden geliyorsa dikkate alınır. Boş değer başlığı kapatır. |
| `RELAY_TRUSTED_PROXIES` | (boş) | Ek güvenilir vekil adresleri veya ağları, virgülle ayrılır (örneğin `172.17.0.1` veya `10.0.0.0/8`). Docker kurulumunda gerekir. |

## 5. Caddy'yi kurun (TLS ve Let's Encrypt)

Caddy'yi resmi deposundan kurun (güncel adımlar: https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

Yapılandırmayı yerleştirin ve alan adını düzeltin:

```bash
sudo install -o root -g root -m 0644 /tmp/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # "cikis.firma.com" → kendi alt alan adınız
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy, DNS kaydı doğruysa ve 80/443 açıksa sertifikayı kendisi alır ve yeniler.

Caddyfile'a şunları **eklemeyin**:

- Yol yeniden yazma, `www` yönlendirmesi, önbellek. `/spool/*` imzası yolun ve sorgunun tamamını kapsar.
- Erişim günlüğü (`log` yönergesi). İstek yolu abonelikten çıkış belirtecini içerir. Aktarıcının kendi günlüğü
  belirteç veya yol yazmaz; yalnızca yöntem, yol sınıfı (`u`, `spool`, `healthz`, `other`) ve durum kodunu yazar.

Verilen Caddyfile Caddy'nin **hata günlüğünü de kapatır** (`log default { exclude http.log.error }`) ve hatalar için
`handle_errors` tanımlar. Sebep: aktarıcıya ulaşılamadığında (yeniden başlatma, güncelleme, çökme) Caddy'nin varsayılan
hata kaydı isteğin tam yolunu (yani çıkış belirtecini), alıcının IP adresini ve `/spool/*` için `X-UM-Kid/Ts/Sig` imza
başlıklarını `journalctl -u caddy` içine yazardı. Bu iki bloğu kaldırmayın ve Caddy günlük düzeyini `DEBUG`'a
çıkarmayın. Aktarıcıya ulaşılamazsa istemci `503` ve `Retry-After: 60` alır; Gmail yeniden dener.

## 6. Güvenlik duvarı

```bash
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

8787 portunu **açmayın**. Aktarıcı yalnızca 127.0.0.1'i dinler. Sağlayıcınızın panelinde ayrı bir güvenlik duvarı
varsa orada da yalnızca 22, 80 ve 443'e izin verin.

## 7. Saat eşitleme (NTP)

```bash
sudo timedatectl set-ntp true
timedatectl status          # "System clock synchronized: yes" ve "NTP service: active" görünmeli
```

İki şey saate bağlıdır:

- Kanal istekleri en çok ±5 dakika saat farkına izin verir. Fark büyürse uygulamanın olay çekmesi 401 alır.
- Belirteç süreleri aktarıcının saatiyle denetlenir.

## 8. İlk denetimler (anahtar dosyası henüz yokken)

Kendi bilgisayarınızdan çalıştırın:

```bash
H=https://cikis.firma.com

# Sağlık: anahtar yokken 503 olmalı
curl -s -o /dev/null -w '%{http_code}\n' $H/healthz                   # 503

# Anahtar yokken çıkış istekleri sessizce kabul edilmez
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'List-Unsubscribe=One-Click' $H/u/u2.a.b                     # 503

# Bilinmeyen yol
curl -s -o /dev/null -w '%{http_code}\n' $H/                          # 404

# HTTP → HTTPS yönlendirmesi (Caddy)
curl -s -o /dev/null -w '%{http_code}\n' http://cikis.firma.com/healthz # 308
```

## 9. Anahtar dosyasını yerleştirin

1. Uygulamada **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranında sırasıyla: "İmza anahtarı" adımında
   **Anahtar oluştur**, "Kanal anahtarı" adımında **Anahtar oluştur**, "Çıkış sunucusu adresi" alanına
   `https://cikis.firma.com` yazıp **Adresi kaydet**, ardından **Anahtar dosyasını indir** (`relay-keys.json`).
2. Dosyayı **yalnızca SSH ile** kopyalayın. E-posta, sohbet veya bulut paylaşımı kullanmayın:

   ```bash
   scp relay-keys.json kullanici@sunucu:/tmp/relay-keys.json
   ssh kullanici@sunucu 'sudo install -o root -g umrelay -m 0640 /tmp/relay-keys.json /etc/um-relay/keys.json && rm /tmp/relay-keys.json'
   ```

3. Yeniden başlatma gerekmez. Aktarıcı dosyayı en geç 5 saniye içinde kendisi yeniden okur.

Dosya biçimi şöyledir; uygulama üretir, elle düzenlemeyin:

```json
{"v":1,"origin":"https://cikis.firma.com","tokenKeys":[{"kid":"…","x":"…"}],"channelKeys":[{"kid":"…","x":"…"}],"generatedAt":1731300000000}
```

Aktarıcı dosyanın **tamamını** doğrular:

- `origin`, `RELAY_PUBLIC_ORIGIN` ile aynı olmalı.
- Her `kid` 16 onaltılık karakter, her `x` 43 base64url karakter olmalı ve `kid`, `x`'ten türetilen değerle
  eşleşmeli.
- Tekrar eden `kid` olmamalı.

Tek bir hatalı giriş bütün dosyayı geçersiz kılar. Bu durumda **son geçerli anahtar kümesi korunur** ve günlüğe
yalnızca hata kodu yazılır (örneğin `keys rejected code=origin_mismatch`). Hiç geçerli küme yüklenmemişse `/u` ve
`/spool` 503 döner.

> **Neden root sahibi ve 0640?** Dosya gizli değildir (yalnızca genel anahtarlar), ama **bütünlüğü önemlidir**.
> Kanal anahtar listesini değiştirebilen biri kuyruktaki çıkış olaylarını çekip onaylayabilir, yani silebilir.
> Aktarıcı kullanıcısı dosyayı yalnızca okur.

## 10. Son denetimler (anahtar dosyası yerleştikten sonra)

```bash
H=https://cikis.firma.com

curl -s -w '\n%{http_code}\n' $H/healthz                               # {"ok":true} ve 200

# Geçersiz belirteç: 400 (multipart dahil; 415 OLMAMALI)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'List-Unsubscribe=One-Click' $H/u/u2.a.b                     # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -F 'List-Unsubscribe=One-Click' $H/u/u2.a.b                         # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: multipart/form-data; boundary=x' \
  --data 'List-Unsubscribe=One-Click' $H/u/u2.a.b                     # 400

# Desteklenmeyen içerik türü
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' --data '{}' $H/u/u2.a.b         # 415

# Kanal imzasız istek kabul etmez
curl -s -o /dev/null -w '%{http_code}\n' $H/spool/stats              # 401
```

Ardından uygulamada aynı ekranın **"Uçtan uca doğrula"** adımında **Doğrula** düğmesine basın. Beklenen ileti:
**"Uç nokta doğrulandı."** (kod `verified`). Doğrulama sınama belirteci kullanır ve hiçbir alıcıya dokunmaz. Sonra
**"Talep kuyruğu sağlığı"** adımında **Kuyruğu denetle**'ye basın. Beklenen ileti: **"Kuyruk sağlıklı."** (kod `ok`),
derinlik 0. Son olarak **"Talepleri düzenli çek"** anahtarını açın: uygulama açıkken talepler her dakika çekilir ve
kanıt 25 günden eskiyse kendiliğinden yeniden doğrulanır. Aktarıcı tek başına doğrulama başlatmaz.

Uygulamada görülen iletiler ve kodlar:

| İleti (uygulama) | Kod |
|---|---|
| Uç nokta doğrulandı. | `verified` |
| Sunucu isteği kabul etmedi… | `bad_status` |
| Sunucu kanal anahtarını tanımıyor… | `channel_failed` (ayrıntı `http_error_401`) |
| Kanal anahtarının özel anahtarı okunamıyor… | `no_channel_key` (gizli bilgiler sıfırlandı; bkz. §12) |
| Kuyruk sağlıklı. | `ok` |

## 11. Dayanıklılık sınaması (isteğe bağlı, önerilir; docs/09 K2)

"Doğrula" sınama olayını gönderir ve hemen ardından kuyruktan çekip onaylar; bu yüzden olayı kuyrukta tutmak için
uygulamanın çekmesi geçici olarak engellenir. Elle bir sınama POST'u işe yaramaz: geçerli imzalı belirteç olmadan
aktarıcı 400 döner ve hiçbir şey yazmaz.

1. Uygulamada **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranında "Kanal anahtarı" adımında
   **Yeni anahtara geç**'i seçin ve yeni anahtar dosyasını **henüz yüklemeyin**. ("Talepleri düzenli çek" açıksa bu
   sınama süresince kapatın.)
2. **Doğrula**'ya basın. Beklenen ileti: "Sunucu kanal anahtarını tanımıyor: güncel anahtar dosyasını yükleyin."
   Sınama POST'u 200 almış ve olay diske yazılmıştır, ama uygulama onu çekemez.
3. Sunucuda olay dosyasını görün: `sudo ls /var/lib/um-relay/spool/pending/` (bir dosya).
4. Aktarıcıyı zorla öldürün: `sudo systemctl kill -s KILL um-relay`. systemd yaklaşık 2 saniye içinde yeniden
   başlatır; dosyanın hâlâ orada olduğunu yeniden `ls` ile doğrulayın.
5. **Anahtar dosyasını indir** ile yeni dosyayı alıp 9. adımdaki gibi yerleştirin. **Doğrula**'ya basın (bu, bekleyen
   olayları da çeker). Ardından **Kuyruğu denetle**: beklenen "Kuyruk sağlıklı." ve derinlik 0. "Kuyruğu denetle"
   yalnızca sayıları okur, olay çekmez. Sınamadan önce kapattıysanız "Talepleri düzenli çek"i yeniden açın.

Eski sınama olayı uygulamaya ulaştığında zararsızca onaylanır (hiçbir alıcıya dokunmaz).

## 12. Günlükler, bakım, güncelleme

- **Günlük:** `journalctl -u um-relay -f`. İstek başına tek satır yazılır, örneğin
  `2026-11-11T10:00:00.000Z POST u 200 3ms`. Aktarıcının günlüğü belirteci ve yolu hiçbir zaman yazmaz. Caddy'nin
  erişim ve hata günlükleri verilen Caddyfile ile kapalıdır (§5); bunları açmayın.
- **Güncelleme:** yeni `relay.cjs` dosyasını 1. ve 3. adımlardaki gibi `/opt/um-relay/relay.cjs` yoluna kurun,
  sonra `sudo systemctl restart um-relay` çalıştırın. Kuyruk diskte durduğu için olay kaybolmaz.
- **Anahtar döndürme:**
  1. Uygulamada ilgili adımda **Yeni anahtara geç**'i seçin.
  2. Doğrulama "Sunucu isteği kabul etmedi…" (`bad_status`, imza anahtarı) veya "Sunucu kanal anahtarını
     tanımıyor…" (`channel_failed`/`http_error_401`, kanal anahtarı) verir; bu beklenir.
  3. **Anahtar dosyasını indir** ile yeni dosyayı alıp 9. adımdaki gibi yerleştirin.
  4. **Doğrula**'ya basın; beklenen ileti "Uç nokta doğrulandı."

  Eski (emekli) imza anahtarı dosyada kaldıkça önceden gönderilmiş e-postalardaki bağlantılar çalışmayı sürdürür.
  Kanal anahtarı döndürülünce eski kanal anahtarı iptal edilir; yeni dosya yüklenince sunucuda da tanınmaz.
- **Gizli bilgiler sıfırlandıysa** (uygulama açılışta ana anahtarı çözemedi ve "Gizli bilgileri sıfırla…" seçildi):
  imza ve kanal özel anahtarları kaybolur; ekranda ilgili adımda "özel anahtar okunamıyor" uyarısı görünür ve
  talepler çekilemez (talepler sunucuda bekler, kaybolmaz). Sırasıyla: "İmza anahtarı" ve "Kanal anahtarı"
  adımlarında **Yeni anahtara geç**, **Anahtar dosyasını indir** ve 9. adımdaki gibi yerleştirme, **Doğrula**,
  **Kuyruğu denetle**. Önceden gönderilmiş bağlantılar çalışmayı sürdürür (genel anahtarlar uygulamada kayıtlıdır).
- **Yedek:** `/var/lib/um-relay/spool/pending/` onaylanmamış olayları tutar. Sunucuyu taşırken bu dizini koruyun.
  Olaylar uygulama onaylayana kadar silinmez.
- **Disk:** kuyruk derinliği uygulamanın "Talep kuyruğu sağlığı" adımında görünür. 1000'i aşarsa `queue_deep` uyarısı
  çıkar; bu, uygulamanın uzun süredir olay çekmediğini gösterir.

## 13. Docker alternatifi

systemd yerine Docker kullanmak isterseniz `deploy/relay/Dockerfile` dosyasına bakın. Önemli farklar:

- Kapsayıcıyı yalnızca `-p 127.0.0.1:8787:8787` ile yayınlayın. Caddy ana makinede kalır.
- Kapsayıcının gördüğü vekil adresi Docker köprü ağ geçididir (genelde `172.17.0.1`). Bu yüzden
  `RELAY_TRUSTED_PROXIES=172.17.0.1` ayarlayın. Ayarlanmazsa `X-Real-IP` yok sayılır ve tüm istemciler tek hız
  sınırı kovasını paylaşır.
- `/data` ana makinedeki kalıcı diske bağlanmalı (`-v /var/lib/um-relay:/data`). Dizinin sahibi uid 1000 (`node`)
  olmalı: `sudo chown 1000:1000 /var/lib/um-relay`.
- `/config` salt okunur bağlanır. Anahtar dosyası `root:1000`, izin 0640 olmalı.

## 14. Sorun giderme

| Belirti | Olası neden | Çözüm |
|---|---|---|
| `/healthz` 503 | Anahtar dosyası yok, geçersiz ya da kanal/imza anahtarı boş; veya veri dizini yazılamıyor | `journalctl -u um-relay` içinde `keys rejected code=…` satırına bakın. 9. adımı yineleyin. |
| `code=origin_mismatch` | Dosyadaki `origin` ile `RELAY_PUBLIC_ORIGIN` farklı | Uygulamadaki çıkış adresi ile birimdeki adresi eşitleyin. |
| `code=kid_mismatch` / `bad_entry` | Dosya elle düzenlenmiş veya bozulmuş | Dosyayı uygulamadan yeniden indirin. |
| Doğrulama: "Sunucu isteği kabul etmedi…" (`bad_status`) | Aktarıcı kapalı veya güncel imza anahtarı dosyada yok | Hizmet durumunu denetleyin ve anahtar dosyasını yeniden yerleştirin. |
| Doğrulama veya sağlık: "Sunucu kanal anahtarını tanımıyor…" (`channel_failed`, `http_error_401`) | Aktarıcıda güncel kanal anahtarı yok ya da saat farkı 5 dakikadan büyük | Anahtar dosyasını yeniden yerleştirin; `timedatectl` çıktısını denetleyin. |
| "Kanal anahtarının özel anahtarı okunamıyor…" (`no_channel_key`) | Uygulamada gizli bilgiler sıfırlandı | §12 "Gizli bilgiler sıfırlandıysa" adımlarını izleyin. |
| Sertifika alınamıyor | DNS kaydı yanlış veya 80/443 kapalı | `dig +short cikis.firma.com` ve güvenlik duvarını denetleyin; `journalctl -u caddy`. |
| Çok sayıda 429 | Hız sınırı | Vekil başlığının iletildiğini denetleyin (Caddyfile `header_up X-Real-IP`); gerekirse `RELAY_RATE_LIMIT_POST` değerini artırın. |
