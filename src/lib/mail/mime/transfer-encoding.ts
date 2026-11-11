import { CRLF } from "./headers";

/**
 * İçerik aktarım kodlamaları (RFC 2045 6.7 quoted-printable, 6.8 base64).
 *
 * Quoted-printable kuralları:
 *  - Yazdırılabilir ASCII (33–126) olduğu gibi kalır; "=" her zaman "=3D" olur.
 *  - Boşluk ve sekme satır içinde kalır, satır SONUNDA kodlanır (=20, =09).
 *  - Diğer tüm baytlar (UTF-8 dahil) "=XX" (büyük harf onaltılık) olur.
 *  - Satırlar en çok 76 karakterdir; uzun satırlar yumuşak satır sonuyla ("=" + CRLF) bölünür, "=XX" bölünmez.
 *  - Satır sonları CRLF'ye normalleştirilir (metindeki satır sonları "gerçek" satır sonudur).
 */

const QP_MAX = 76;

/** Tüm satır sonlarını (CRLF, CR, LF) LF'ye indirir. */
function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function hex(b: number): string {
  return `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
}

function encodeQpLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  const atoms: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const last = i === bytes.length - 1;
    if (b === 0x20 || b === 0x09) atoms.push(last ? hex(b) : String.fromCharCode(b));
    else if (b >= 33 && b <= 126 && b !== 0x3d) atoms.push(String.fromCharCode(b));
    else atoms.push(hex(b));
  }
  // Yumuşak satır sonu: her parça "=" ile birlikte en çok 76 karakter.
  const out: string[] = [];
  let cur = "";
  for (const a of atoms) {
    if (cur.length + a.length > QP_MAX - 1) {
      out.push(`${cur}=`);
      cur = "";
    }
    cur += a;
  }
  out.push(cur);
  return out.join(CRLF);
}

export function encodeQuotedPrintable(text: string): string {
  return splitLines(text).map(encodeQpLine).join(CRLF);
}

/** Base64, 76 karakterlik satırlar. */
export function encodeBase64Lines(data: Buffer | string): string {
  const b64 = (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += QP_MAX) lines.push(b64.slice(i, i + QP_MAX));
  return lines.join(CRLF);
}
