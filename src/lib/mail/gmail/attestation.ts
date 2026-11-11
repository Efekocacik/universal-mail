import { GMAIL_HEADER_TRUST_VERIFIED } from "@/lib/compliance/policies";
import { parseEmail } from "@/lib/email/address";
import type { Attestation } from "../inbound/evidence";

/**
 * Gmail ham iletisinden kimlik doğrulama tasdiki çıkarımı (Aşama 15.5).
 *
 * ÖNEMLİ — GÜVEN KİLİDİ: `GMAIL_HEADER_TRUST_VERIFIED` kapalıyken (varsayılan) bu işlev HER ZAMAN `null` döner:
 * hiçbir Gmail başlığı tasdik üretmez. Sebep: iletinin başlıkları gönderenin kontrolündedir; Gmail'in eklediklerini
 * gönderenin ekledikleriyle yalnızca başlık SIRASI/BİÇİMİ ile ayırt etmek, gerçek bir Gmail hesabında doğrulanmadan
 * kanıt DEĞİLDİR (bkz. docs/09-FAZ3-CANLI-DOGRULAMA.md). Kilit açıkken bile aşağıdaki yapısal kurallar uygulanır ve
 * herhangi biri şüpheliyse `null` döner (otomatik etki YOK; ileti yalnızca inceleme için kaydedilir):
 *  - tam BİR `Authentication-Results` başlığı `mx.google.com` yetkili kimliğini taşımalı (ikincisi, nerede olursa
 *    olsun, belirsizliktir); en üstteki `Authentication-Results` o olmalı;
 *  - `mx.google.com` yetkili kimliğini taşıyan başlıktan hemen önceki `Received` başlığı `by mx.google.com`
 *    içermeli ve iletide bu ifadeyi taşıyan TEK `Received` olmalı (sahte çift yok);
 *  - en üstteki `Delivered-To` bu kutunun adresi olmalı;
 *  - tam BİR `Return-Path` olmalı (boş zarf gönderen için); birden çoksa boş zarf sayılmaz;
 *  - bunlar gönderenin kontrolündeki özgün başlıklardan (From, To, Subject...) ÖNCE gelmeli;
 *  - `pass` yalnızca `dmarc=pass` VE `header.from` alan adı iletinin `From` alan adıyla aynıysa verilir.
 *
 * KANITLANAMAYAN VARSAYIM: "Gmail, aldığı her SMTP iletisine kendi Authentication-Results başlığını ekler". Eklemediği
 * bir durumda gönderenin, Gmail başlıklarının hemen altına koyduğu sahte başlık bu kurallarla ayırt EDİLEMEZ. Bu yüzden
 * kilit gerçek hesapla doğrulanana kadar kapalıdır (docs/09-FAZ3-CANLI-DOGRULAMA.md).
 */

const TRUSTED_AUTHSERV = "mx.google.com";
const MAX_HEADER_BLOCK = 64 * 1024;

/** Gönderenin kontrolündeki özgün başlıklar: Gmail'in eklediği başlıklar bunların ÜSTÜNDEdir. */
const ORIGINAL_HEADERS = new Set([
  "from",
  "to",
  "subject",
  "date",
  "message-id",
  "dkim-signature",
  "mime-version",
  "content-type",
  "in-reply-to",
  "references",
  "reply-to",
]);

interface Header {
  name: string;
  value: string;
}

function parseHeaders(raw: string): Header[] | null {
  const m = /\r?\n\r?\n/.exec(raw);
  const block = m ? raw.slice(0, m.index) : raw;
  if (block.length === 0 || block.length > MAX_HEADER_BLOCK) return null;
  const out: Header[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = out.at(-1);
      if (!last) return null;
      last.value += ` ${line.trim()}`;
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) return null;
    out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
}

export function extractGmailAttestation(
  raw: string,
  mailboxAddress: string | null,
  opts: { trustVerified?: boolean } = {},
): Attestation | null {
  // Güven kilidi kapalıysa hiçbir başlık tasdik üretmez. Geçersiz kılma yalnızca testte kabul edilir.
  const trusted =
    process.env.NODE_ENV === "test" && opts.trustVerified !== undefined
      ? opts.trustVerified
      : GMAIL_HEADER_TRUST_VERIFIED;
  if (!trusted) return null;
  if (!mailboxAddress) return null;
  const headers = parseHeaders(raw);
  if (!headers) return null;

  const firstOriginal = headers.findIndex((h) => ORIGINAL_HEADERS.has(h.name));
  const limit = firstOriginal === -1 ? headers.length : firstOriginal;
  const idx = (name: string) => headers.findIndex((h) => h.name === name);

  // Teslim kanıtı: en üstteki Delivered-To bu kutunun adresi ve özgün başlıklardan önce.
  const delivered = idx("delivered-to");
  if (delivered === -1 || delivered >= limit) return null;
  if (headers[delivered]!.value.toLowerCase() !== mailboxAddress.toLowerCase()) return null;

  const arIdx = idx("authentication-results");
  if (arIdx === -1 || arIdx >= limit || arIdx < delivered) return null;
  const ar = headers[arIdx]!.value;
  const authservOf = (v: string) => /^([^;\s]+)\s*;/.exec(v)?.[1]?.toLowerCase();
  if (authservOf(ar) !== TRUSTED_AUTHSERV) return null;
  // Belirsizlik: aynı yetkili kimliği taşıyan ikinci başlık (nerede olursa olsun) varsa Gmail'inkini ayıramayız.
  const claims = headers.filter(
    (h) => h.name === "authentication-results" && authservOf(h.value) === TRUSTED_AUTHSERV,
  );
  if (claims.length !== 1) return null;
  // Gmail'in kendi `Received` başlığı hemen öncesinde olmalı ve tek olmalı (sahte çift yok).
  const gmailReceived = headers.filter(
    (h) => h.name === "received" && /(?:^|\s)by\s+mx\.google\.com(?=[\s;]|$)/i.test(h.value),
  );
  if (gmailReceived.length !== 1) return null;
  let prev = arIdx - 1;
  while (prev >= 0 && headers[prev]!.name !== "received") prev--;
  if (prev < 0 || prev <= delivered || headers[prev] !== gmailReceived[0]) return null;

  // Gönderen alan adı: iletinin From başlığı (kimlik doğrulama bu alan adına bağlanmalı).
  const fromHeader = headers.find((h) => h.name === "from")?.value ?? "";
  const fromAddr = /<([^<>]+)>/.exec(fromHeader)?.[1] ?? fromHeader;
  const from = parseEmail(fromAddr.trim());
  const fromDomain = from?.domain?.toLowerCase() ?? null;

  // RFC 8601: yorumlar (parantez içi, gönderen kontrollü metin içerebilir) atılır; her yöntem KENDİ segmentinde
  // (`;` ile ayrılmış, `yöntem=sonuç` ile başlayan) okunur. Tam BİR dmarc segmenti olmalı.
  let stripped = ar;
  for (let i = 0; i < 8 && /\([^()]*\)/.test(stripped); i++)
    stripped = stripped.replace(/\([^()]*\)/g, " ");
  const segments = stripped
    .split(";")
    .slice(1)
    .map((x) => x.trim());
  const dmarcSegs = segments.filter((x) => /^dmarc\s*=/i.test(x));
  if (dmarcSegs.length > 1) return null;
  const dmarcSeg = dmarcSegs[0] ?? "";
  const dmarc = /^dmarc\s*=\s*([a-z]+)(?=[\s;(]|$)/i.exec(dmarcSeg)?.[1];
  const headerFrom = /(?:^|\s)header\.from=([^\s;()]+)/i.exec(dmarcSeg)?.[1]?.toLowerCase() ?? null;
  let senderAuth: Attestation["senderAuth"] = "none";
  if (dmarc?.toLowerCase() === "pass" && fromDomain && headerFrom === fromDomain)
    senderAuth = "pass";
  else if (dmarc?.toLowerCase() === "fail") senderAuth = "fail";

  // Zarf gönderen: en üstteki Return-Path, yine özgün başlıklardan önce ve Delivered-To'nun altında.
  const rpIdx = idx("return-path");
  const rpCount = headers.filter((h) => h.name === "return-path").length;
  const nullReturnPath =
    rpCount === 1 &&
    rpIdx !== -1 &&
    rpIdx < limit &&
    rpIdx > delivered &&
    headers[rpIdx]!.value === "<>";

  return { source: "provider", senderAuth, nullReturnPath };
}
