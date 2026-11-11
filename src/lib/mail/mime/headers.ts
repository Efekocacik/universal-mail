import { parseEmail } from "@/lib/email/address";

/**
 * E-posta başlıkları (RFC 5322) ve ASCII dışı metnin kodlanması (RFC 2047).
 *
 * Güvenlik: başlık değerlerinde CR, LF veya başka kontrol karakteri KABUL EDİLMEZ (temizlenmez, reddedilir); böylece
 * başlık enjeksiyonu sessizce "düzeltilmiş" bir iletiye dönüşmez. Başlık adları çağıranın sabit listesinden gelir.
 */

export const CRLF = "\r\n";
/**
 * Katlama hedefi (CRLF hariç). RFC 5322 78 önerir; RFC 2047 2, kodlanmış sözcük içeren satırları 76 karakterle
 * sınırladığından tüm başlıklar için 76 kullanılır.
 */
export const SOFT_LINE = 76;
/** RFC 5322 2.1.1: kesin üst sınır (CRLF hariç). */
export const HARD_LINE = 998;

export type MimeErrorKind =
  | "header_injection"
  | "invalid_address"
  | "invalid_message_id"
  | "line_too_long"
  | "too_large"
  | "invalid_input";

export class MimeError extends Error {
  constructor(
    readonly kind: MimeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** C0 kontrol karakterleri (TAB dahil), DEL ve Unicode satır/paragraf ayırıcıları. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
);

export function assertHeaderText(value: string, what: string): void {
  if (CONTROL.test(value)) {
    throw new MimeError("header_injection", `${what} kontrol karakteri veya satır sonu içeremez.`);
  }
}

/** Yazdırılabilir ASCII (0x20–0x7E). */
function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

const ENCODED_PREFIX = "=?UTF-8?B?";
const ENCODED_SUFFIX = "?=";
/**
 * Sözcük başına en çok 39 bayt → 52 base64 karakteri → 64 karakterlik kodlanmış sözcük. Böylece "Subject: " ile
 * birlikte ilk satır da RFC 2047'nin 76 karakter sınırında kalır (sözcük sınırı 75).
 */
const MAX_WORD_BYTES = 39;

/**
 * Metni UTF-8 "B" kodlanmış sözcüklere böler (RFC 2047). Bölme yalnızca kod noktası sınırında yapılır; bir karakterin
 * baytları iki sözcüğe dağılmaz. Sözcükler tek boşlukla ayrılır (kodçözücüler aradaki boşluğu yok sayar, 6.2).
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;
  for (const ch of text) {
    const b = Buffer.from(ch, "utf8");
    if (size + b.length > MAX_WORD_BYTES && chunk.length > 0) {
      words.push(Buffer.concat(chunk).toString("base64"));
      chunk = [];
      size = 0;
    }
    chunk.push(b);
    size += b.length;
  }
  if (chunk.length > 0) words.push(Buffer.concat(chunk).toString("base64"));
  return words.map((w) => `${ENCODED_PREFIX}${w}${ENCODED_SUFFIX}`).join(" ");
}

/**
 * Yapısız başlık metni (ör. Subject). Yazdırılabilir ASCII ve kodlanmış sözcüğe benzemeyen metin olduğu gibi kalır;
 * aksi halde tamamı RFC 2047 ile kodlanır.
 */
export function encodeUnstructured(value: string): string {
  assertHeaderText(value, "Başlık");
  if (isPrintableAscii(value) && !value.includes("=?")) return value;
  return encodeWords(value);
}

/** RFC 5322 3.2.3 atext + boşluk: tırnaksız yazılabilen görünen ad. */
const ATEXT_PHRASE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/;

/** Görünen ad (phrase): ASCII ise gerekiyorsa tırnaklanır; değilse RFC 2047 ile kodlanır (tırnak içinde değil). */
export function encodeDisplayName(name: string): string {
  assertHeaderText(name, "Görünen ad");
  const trimmed = name.trim().replace(/ {2,}/g, " ");
  if (!trimmed) return "";
  if (isPrintableAscii(trimmed) && !trimmed.includes("=?")) {
    if (ATEXT_PHRASE.test(trimmed)) return trimmed;
    return `"${trimmed.replace(/(["\\])/g, "\\$1")}"`;
  }
  return encodeWords(trimmed);
}

/**
 * Adres: normalleştirilmiş (küçük harf, punycode alan adı) ve yalnızca ASCII olmalıdır. Unicode yerel kısım
 * (SMTPUTF8) desteklenmez.
 */
export function formatAddress(address: string, displayName?: string | null): string {
  assertHeaderText(address, "Adres");
  const parsed = parseEmail(address);
  if (!parsed || parsed.email !== address || !isPrintableAscii(address)) {
    throw new MimeError("invalid_address", "Geçersiz veya normalleştirilmemiş e-posta adresi.");
  }
  const name = displayName ? encodeDisplayName(displayName) : "";
  return name ? `${name} <${address}>` : address;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 3.3 tarih (UTC): "Thu, 30 Oct 2026 10:00:00 +0000". */
export function formatDate(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new MimeError("invalid_input", "Geçersiz tarih.");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * `Ad: değer` satırını boşluklardan katlar (RFC 5322 2.2.3). Satırlar mümkünse 78, kesinlikle 998 karakteri aşmaz.
 * Değer zaten kodlanmış ve yalnızca yazdırılabilir ASCII olmalıdır.
 */
export function foldHeader(name: string, value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
    throw new MimeError("invalid_input", "Geçersiz başlık adı.");
  }
  assertHeaderText(value, name);
  if (!isPrintableAscii(value)) throw new MimeError("invalid_input", `${name} ASCII olmalıdır.`);
  const tokens = value.split(" ");
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of tokens) {
    const candidate = `${line} ${token}`;
    if (candidate.length > SOFT_LINE && line.trim().length > name.length + 1) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  if (lines.some((l) => l.length > HARD_LINE)) {
    throw new MimeError("line_too_long", `${name} başlığında 998 karakterden uzun bir sözcük var.`);
  }
  return lines.join(CRLF);
}
