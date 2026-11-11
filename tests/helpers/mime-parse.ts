/**
 * Yalnızca testler için küçük bir MIME çözücü. Üretim kodlayıcısından BAĞIMSIZ yazılmıştır: RFC 5322 katlamayı açar,
 * RFC 2047 "B" sözcüklerini, RFC 2045 quoted-printable'ı ve RFC 2046 çok parçalı yapıyı çözer. Böylece kodlayıcının
 * çıktısının standartlara göre geri çözülebildiği doğrulanır.
 */

export interface ParsedPart {
  headers: Map<string, string[]>;
  body: string;
}

export interface ParsedMessage {
  headers: Map<string, string[]>;
  rawHeaderLines: string[];
  parts: ParsedPart[];
  preamble: string;
}

function parseHeaderBlock(block: string): { headers: Map<string, string[]>; lines: string[] } {
  const unfolded = block.replace(/\r\n(?=[ \t])/g, "");
  const headers = new Map<string, string[]>();
  for (const line of unfolded.split("\r\n")) {
    if (!line) continue;
    const i = line.indexOf(":");
    const name = line.slice(0, i).toLowerCase();
    const value = line.slice(i + 1).replace(/^[ \t]/, "");
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return { headers, lines: block.split("\r\n") };
}

/** RFC 2047: =?charset?B?...?= sözcüklerini çözer; ardışık iki kodlanmış sözcük arasındaki boşluk yok sayılır. */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(\?=)[ \t]+(?==\?)/g, "$1");
  return joined.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset: string, enc: string, data: string) => {
      if (charset.toLowerCase() !== "utf-8") throw new Error(`charset ${charset}`);
      if (enc.toUpperCase() !== "B") throw new Error("Q desteklenmiyor");
      return Buffer.from(data, "base64").toString("utf8");
    },
  );
}

/** RFC 2045 6.7 quoted-printable çözümü. */
export function decodeQuotedPrintable(body: string): string {
  const noSoft = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft[i]!;
    if (c === "=") {
      const h = noSoft.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(h)) throw new Error(`geçersiz QP: =${h}`);
      bytes.push(parseInt(h, 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parseMessage(raw: string): ParsedMessage {
  const sep = raw.indexOf("\r\n\r\n");
  const head = parseHeaderBlock(raw.slice(0, sep));
  const body = raw.slice(sep + 4);
  const ctype = head.headers.get("content-type")?.[0] ?? "";
  const m = /boundary="([^"]+)"/.exec(ctype);
  if (!m) return { headers: head.headers, rawHeaderLines: head.lines, parts: [], preamble: body };
  const boundary = m[1]!;
  const delimiter = `\r\n--${boundary}`;
  const firstStart = body.startsWith(`--${boundary}`) ? 0 : body.indexOf(delimiter);
  const preamble = firstStart === 0 ? "" : body.slice(0, firstStart);
  const segments = `\r\n${body}`.split(delimiter).slice(1);
  const parts: ParsedPart[] = [];
  for (const seg of segments) {
    if (seg.startsWith("--")) break; // kapanış ayracı
    const content = seg.replace(/^\r\n/, "");
    const psep = content.indexOf("\r\n\r\n");
    const ph = parseHeaderBlock(content.slice(0, psep));
    const raw = content.slice(psep + 4);
    const enc = ph.headers.get("content-transfer-encoding")?.[0]?.toLowerCase();
    parts.push({
      headers: ph.headers,
      body: enc === "quoted-printable" ? decodeQuotedPrintable(raw) : raw,
    });
  }
  return { headers: head.headers, rawHeaderLines: head.lines, parts, preamble };
}
