/**
 * Faz 6 (paket G, NFR-01, yol haritası madde 10): uygulamanın bu bilgisayar dışına bağlanabileceği HER adres.
 *
 * Kural: geliştiriciye veya bir telemetri/analiz hizmetine giden HİÇBİR bağlantı yoktur. Dış bağlantılar yalnızca
 * kullanıcının kendi açtığı hizmetlere (kendi anahtarı/hesabıyla), kullanıcının tıkladığı bağlantılara (varsayılan
 * tarayıcıda açılır) ve işin doğası gereği çalışma anında belirlenen adreslere (işletmelerin web siteleri, DNS, kendi
 * çıkış aktarıcısı) yapılır. Demo kipinde ve temiz açılışta hiçbir dış bağlantı yapılmaz (`e2e/privacy.spec.ts`).
 *
 * `tests/egress-allowlist.test.ts` kaynak koddaki (src, electron) her adres/ana bilgisayar sabitinin burada olduğunu,
 * CSP'deki her dış kaynağın burada olduğunu ve `docs/GUVENLIK.md` tablosunun bu listeyle aynı olduğunu denetler.
 * Yeni bir dış hizmet eklendiğinde buraya, arayüz metnine (security fragmanı) ve belgeye eklenmelidir.
 */

export type EgressCategory =
  /** Kullanıcının kendi anahtarı/hesabıyla açtığı hizmet; kapalıyken hiç çağrılmaz. */
  | "user-enabled-api"
  /** Yalnızca kullanıcı tıklayınca varsayılan tarayıcıda açılan bağlantı (uygulama kendisi bağlanmaz). */
  | "user-link"
  /** Örnek/yer tutucu ad, XML ad alanı veya kod içi açıklama: hiçbir zaman bağlanılmaz. */
  | "placeholder"
  /** Adresi çalışma anında belirlenen bağlantı (işletme siteleri, DNS, RDAP sunucuları, kendi aktarıcınız). */
  | "dynamic";

/** Uygulamanın bağlandığı hizmet (arayüzde ve belgede bu gruplarla anlatılır). */
export const EGRESS_SERVICES = [
  "places",
  "maps",
  "gmail",
  "hunter",
  "snov",
  "anthropic",
  "companiesHouse",
  "insee",
  "rdap",
  "websites",
  "dns",
  "relay",
] as const;
export type EgressService = (typeof EGRESS_SERVICES)[number];

export interface EgressEntry {
  /** Ana bilgisayar; `*.` önekli joker yalnızca bir alt alan düzeyini değil, tüm alt alanları kapsar. */
  host: string;
  category: EgressCategory;
  /** Bağlantının ait olduğu hizmet (yer tutucular ve tıklanan bağlantılar için null). */
  service: EgressService | null;
  /** Kısa açıklama (belge ve test hata iletileri için; arayüz metni i18n'dedir). */
  note: string;
}

export const EGRESS_ALLOWLIST: readonly EgressEntry[] = [
  // --- Kullanıcının açtığı hizmetler ---
  {
    host: "places.googleapis.com",
    category: "user-enabled-api",
    service: "places",
    note: "Places API (New)",
  },
  {
    host: "maps.googleapis.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Maps JavaScript API",
  },
  {
    host: "*.googleapis.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Harita döşemeleri ve Maps JS kaynakları (CSP)",
  },
  {
    host: "maps.gstatic.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Maps JS betikleri",
  },
  {
    host: "*.gstatic.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Harita görselleri ve yazı tipleri (CSP)",
  },
  {
    host: "*.google.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Harita görselleri (CSP)",
  },
  {
    host: "*.ggpht.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Harita görselleri (CSP)",
  },
  {
    host: "*.googleusercontent.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Harita görselleri (CSP)",
  },
  {
    host: "fonts.googleapis.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Maps JS yazı tipi stili (CSP)",
  },
  {
    host: "fonts.gstatic.com",
    category: "user-enabled-api",
    service: "maps",
    note: "Maps JS yazı tipi (CSP)",
  },
  {
    host: "gmail.googleapis.com",
    category: "user-enabled-api",
    service: "gmail",
    note: "Gmail API (gönderim, gelen kutusu)",
  },
  {
    host: "oauth2.googleapis.com",
    category: "user-enabled-api",
    service: "gmail",
    note: "OAuth belirteç alma ve iptal",
  },
  {
    host: "accounts.google.com",
    category: "user-enabled-api",
    service: "gmail",
    note: "OAuth onay sayfası (tarayıcıda)",
  },
  {
    host: "www.googleapis.com",
    category: "user-enabled-api",
    service: "gmail",
    note: "OAuth imza anahtarları ve izin kapsamı adları",
  },
  {
    host: "api.hunter.io",
    category: "user-enabled-api",
    service: "hunter",
    note: "Hunter e-posta bulma",
  },
  {
    host: "api.snov.io",
    category: "user-enabled-api",
    service: "snov",
    note: "Snov e-posta bulma",
  },
  {
    host: "api.anthropic.com",
    category: "user-enabled-api",
    service: "anthropic",
    note: "Claude (tanıtım metni)",
  },
  {
    host: "api.company-information.service.gov.uk",
    category: "user-enabled-api",
    service: "companiesHouse",
    note: "Companies House (Birleşik Krallık sicili)",
  },
  {
    host: "api.insee.fr",
    category: "user-enabled-api",
    service: "insee",
    note: "INSEE Sirene (Fransa sicili)",
  },
  {
    host: "data.iana.org",
    category: "user-enabled-api",
    service: "rdap",
    note: "RDAP önyükleme dosyası (TLD → RDAP sunucusu)",
  },
  // --- Çalışma anında belirlenen adresler ---
  {
    host: "(RDAP sunucusu)",
    category: "dynamic",
    service: "rdap",
    note: "Alan adının kayıt kuruluşu RDAP sunucusu (IANA listesinden)",
  },
  {
    host: "(işletme web sitesi)",
    category: "dynamic",
    service: "websites",
    note: "Lead'in kendi web sitesi (güvenli okuyucu: yerel/özel ağ adresleri engelli)",
  },
  {
    host: "(DNS çözümleyici)",
    category: "dynamic",
    service: "dns",
    note: "İşletim sisteminin DNS sunucusu (MX, SPF/DKIM/DMARC)",
  },
  {
    host: "(çıkış aktarıcısı)",
    category: "dynamic",
    service: "relay",
    note: "Sizin girdiğiniz çıkış aktarıcısı adresi",
  },
  // --- Yalnızca kullanıcı tıklarsa tarayıcıda açılan bağlantılar ---
  {
    host: "www.google.com",
    category: "user-link",
    service: null,
    note: "Google Haritalar'da göster",
  },
  {
    host: "cloud.google.com",
    category: "user-link",
    service: null,
    note: "Google Maps Platform şartları",
  },
  {
    host: "developers.google.com",
    category: "user-link",
    service: null,
    note: "Google Places politika belgeleri",
  },
  {
    host: "www.rfc-editor.org",
    category: "user-link",
    service: null,
    note: "RDAP istemci tanıtımı (User-Agent içinde, bağlanılmaz)",
  },
  {
    host: "www.facebook.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  {
    host: "www.instagram.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  {
    host: "www.linkedin.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  {
    host: "x.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  {
    host: "www.tiktok.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  {
    host: "www.youtube.com",
    category: "user-link",
    service: null,
    note: "İşletmenin sosyal medya bağlantısı",
  },
  // --- Yer tutucular (hiçbir zaman bağlanılmaz) ---
  { host: "www.w3.org", category: "placeholder", service: null, note: "SVG XML ad alanı" },
  { host: "firma.com", category: "placeholder", service: null, note: "Örnek alan adı" },
  {
    host: "cikis.firma.com",
    category: "placeholder",
    service: null,
    note: "Örnek çıkış aktarıcısı adresi",
  },
  {
    host: "cikis.firmaniz.com",
    category: "placeholder",
    service: null,
    note: "Örnek çıkış aktarıcısı adresi (Ayarlar ipucu)",
  },
  {
    host: "unsubscribe.yourcompany.com",
    category: "placeholder",
    service: null,
    note: "Örnek çıkış aktarıcısı adresi (İngilizce ipucu)",
  },
  {
    host: "um-relay.hesabiniz.workers.dev",
    category: "placeholder",
    service: null,
    note: "Örnek Cloudflare Worker adresi (Türkçe ipucu)",
  },
  {
    host: "um-relay.youraccount.workers.dev",
    category: "placeholder",
    service: null,
    note: "Örnek Cloudflare Worker adresi (İngilizce ipucu)",
  },
  {
    host: "*.example",
    category: "placeholder",
    service: null,
    note: "Demo verisi ve örnekler (.example ayrılmış, RFC 2606)",
  },
  {
    host: "*.example.com",
    category: "placeholder",
    service: null,
    note: "Örnek adres (example.com ayrılmış, RFC 2606)",
  },
  {
    host: "*.invalid",
    category: "placeholder",
    service: null,
    note: "Geçersiz adres (.invalid ayrılmış, RFC 2606)",
  },
  {
    host: "ana.makine",
    category: "placeholder",
    service: null,
    note: "Açıklamada örnek ana bilgisayar",
  },
  { host: "host", category: "placeholder", service: null, note: "Açıklamada örnek ana bilgisayar" },
  {
    host: "başka",
    category: "placeholder",
    service: null,
    note: "Açıklamada örnek ana bilgisayar (aktarıcı)",
  },
  {
    host: "127.0.0.1",
    category: "placeholder",
    service: null,
    note: "Bu bilgisayar (yerel sunucu)",
  },
  {
    host: "localhost",
    category: "placeholder",
    service: null,
    note: "Bu bilgisayar (yerel sunucu)",
  },
];

/** Ana bilgisayar bir girişle eşleşiyor mu (`*.firma.com` → `kafe-1.firma.com` ve `a.b.firma.com`). */
export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** Ana bilgisayarı kapsayan ilk giriş (önce tam eşleşme). Jokerli girişler dahil: CSP kaynakları ve çalışma anı içindir. */
export function findEgressEntry(host: string): EgressEntry | undefined {
  return (
    EGRESS_ALLOWLIST.find((e) => !e.host.startsWith("*.") && hostMatches(e.host, host)) ??
    EGRESS_ALLOWLIST.find((e) => hostMatches(e.host, host))
  );
}

/**
 * Hiçbir zaman internette çözülmeyen, kimseye ait olmayan ayrılmış adlar (RFC 2606 / RFC 6761): `.example`, `.invalid`,
 * `.test`, `.localhost` ve `example.com/net/org`.
 */
const RESERVED_SUFFIXES = [
  ".example",
  ".invalid",
  ".test",
  ".localhost",
  ".example.com",
  ".example.net",
  ".example.org",
] as const;

/** Ad (ya da `*.` jokerinin soneki) ayrılmış bir ad alanında mı? */
export function isReservedName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  return RESERVED_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

/**
 * Kaynak koddaki bir adres/ana bilgisayar SABİTİNİ kapsayan giriş. Yalnızca TAM eşleşme kabul edilir; joker yalnızca
 * ayrılmış ad alanlarında (`*.example`, `*.invalid`, `*.example.com`) geçerlidir. Google jokerleri (`*.googleapis.com`
 * vb.) yalnızca CSP içindir: kodda sabit yazılmış `logging.googleapis.com` ya da bir geliştiricinin
 * `x.workers.dev` aktarıcısı böylece "harita" ya da "örnek" diye geçemez, izin listesine açıkça eklenmesi gerekir.
 */
export function findSourceLiteralEntry(host: string): EgressEntry | undefined {
  return EGRESS_ALLOWLIST.find(
    (e) =>
      e.category !== "dynamic" &&
      (e.host.startsWith("*.") ? isReservedName(e.host) : true) &&
      hostMatches(e.host, host),
  );
}

/** Bu bilgisayarın kendisi mi (geri döngü)? Gizlilik denetimi yalnızca bunlara izin verir. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** Arayüz için hizmet grupları: her hizmetin ana bilgisayarları (yer tutucular ve bağlantılar hariç). */
export function egressServices(): { service: EgressService; hosts: string[]; dynamic: boolean }[] {
  return EGRESS_SERVICES.map((service) => {
    const entries = EGRESS_ALLOWLIST.filter((e) => e.service === service);
    return {
      service,
      hosts: entries.filter((e) => e.category !== "dynamic").map((e) => e.host),
      dynamic: entries.some((e) => e.category === "dynamic"),
    };
  });
}
