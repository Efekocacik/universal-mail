import { COUNTRY_CODES } from "@/lib/geo/countries";
import { registrableDomain } from "@/lib/novelty/rdap";

/**
 * İçe aktarma normalleştirmeleri (saf; sınanır): ad/şehir karşılaştırma anahtarı, ülke adı → ISO2, web sitesi.
 * Kopya denetimi bu anahtarlarla yapılır; kaydedilen değerler kullanıcının yazdığı (kırpılmış) metindir.
 */

/** Unicode aksanları ve Türkçe harfleri sadeleştirir: "Çay Evi" → "cay evi". */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Şirket türü ekleri (karşılaştırmada gürültü): "Ltd", "GmbH", "A.Ş.", "SARL"… Yalnızca adın SONUNDAKİ ekler atılır;
 * "Limited Edition Cafe" gibi adın ortasındaki sözcükler korunur.
 */
const LEGAL_SUFFIXES = new Set([
  "ltd",
  "limited",
  "llc",
  "inc",
  "plc",
  "llp",
  "gmbh",
  "ag",
  "kg",
  "ug",
  "sarl",
  "sas",
  "sa",
  "srl",
  "spa",
  "bv",
  "nv",
  "as",
  "sti",
  "co",
]);

/** Ad karşılaştırma anahtarı: küçük harf, aksansız, noktalama yerine boşluk, sondaki şirket türü ekleri atılmış. */
export function normaliseName(name: string): string {
  const words = fold(name)
    // Noktalı kısaltmalar tek sözcük olur: "a.s." → "as", "s.r.l." → "srl".
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, "$1")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // "GmbH & Co. KG" gibi zincirler: ek veya bağlaç ("and") sondaysa atılır.
  while (words.length > 1 && (LEGAL_SUFFIXES.has(words.at(-1)!) || words.at(-1) === "and"))
    words.pop();
  return words.join(" ");
}

/** Şehir karşılaştırma anahtarı (boşsa ""). */
export function normaliseCity(city: string | null | undefined): string {
  return city
    ? fold(city)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    : "";
}

/** Yaygın kısaltmalar ve eski adlar (Intl adlarına ek). */
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB",
  "u k": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "great britain": "GB",
  britain: "GB",
  ingiltere: "GB",
  "birlesik krallik": "GB",
  holland: "NL",
  hollanda: "NL",
  turkey: "TR",
  turkiye: "TR",
  deutschland: "DE",
  allemagne: "DE",
  almanya: "DE",
  espana: "ES",
  ispanya: "ES",
  italia: "IT",
  italya: "IT",
  fransa: "FR",
  "the netherlands": "NL",
  nederland: "NL",
  osterreich: "AT",
  schweiz: "CH",
  suisse: "CH",
  belgique: "BE",
  belgie: "BE",
  danmark: "DK",
  sverige: "SE",
  norge: "NO",
  polska: "PL",
  eire: "IE",
};

let countryIndex: Map<string, string> | null = null;
function buildCountryIndex(): Map<string, string> {
  const map = new Map<string, string>();
  for (const locale of ["en", "tr", "fr", "de"]) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      continue;
    }
    for (const code of COUNTRY_CODES) {
      const n = names.of(code);
      if (n) map.set(normaliseCity(n), code);
    }
  }
  for (const [k, v] of Object.entries(COUNTRY_ALIASES)) map.set(k, v);
  return map;
}

/**
 * Ülke değeri → hedef pazar ISO2 kodu: "GB", "gb", "United Kingdom", "Birleşik Krallık", "Royaume-Uni", "UK".
 * Bilinmeyen veya hedef pazar listesinde olmayan değer `null` (satır `bad_country` olur).
 */
export function resolveCountry(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper))
    return (COUNTRY_CODES as readonly string[]).includes(upper)
      ? upper
      : upper === "UK"
        ? "GB"
        : null;
  countryIndex ??= buildCountryIndex();
  return countryIndex.get(normaliseCity(v)) ?? null;
}

/**
 * Web sitesi normalleştirme: `https://host/yol` (sorgu ve parça atılır). Yalnızca http(s) veya şemasız ad kabul
 * edilir; kullanıcı adı/parola, standart dışı bağlantı noktası, IP adresi, `localhost` ve kayıtlı alan adı olmayan
 * sunucular reddedilir (`null`). Bu adres sonradan e-posta taramasında (güvenli fetch) kullanılabilir; burada
 * hiçbir istek atılmaz.
 */
export function normaliseWebsite(value: string | null | undefined): string | null {
  let v = (value ?? "").trim();
  if (!v) return null;
  if (/^\/\//.test(v)) v = `https:${v}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !registrableDomain(host)) return null;
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const out = `https://${host}${path}`;
  return out.length >= 4 && out.length <= 300 ? out : null;
}

/** Normalleştirilmiş web sitesinin kayıtlı alan adı (kopya anahtarı; `www.` ve alt alan adları aynı sayılır). */
export function websiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return registrableDomain(new URL(website).hostname);
  } catch {
    return null;
  }
}

/** Görünen metni temizler: kontrol karakterleri atılır, boşluklar tekleşir, uzunluk kesilir. Boşsa `null`. */
export function cleanText(value: string | null | undefined, max: number): string | null {
  const v = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return v ? v.slice(0, max) : null;
}
