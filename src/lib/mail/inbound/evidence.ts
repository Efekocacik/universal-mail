import { hashEmail } from "@/lib/compliance/suppression";
import { DAY_MS } from "@/lib/compliance/frequency";
import { ADDRESS_GONE_STATUSES, isSystemSender, type InboundKind } from "./classify";
import type { ParsedInbound } from "./parse";

/**
 * Gelen iletinin otomatik etki üretmeye yetecek KANITI (Aşama 13).
 *
 * Message-ID eşleşmesi tek başına kanıt DEĞİLDİR (alıcı ve iletiyi görmüş herkes kimliği bilir). Beş katman:
 *  L1 yapısal eşleşme  : bizim gönderdiğimiz, aynı posta kutusundan, kabul edilmiş KAMPANYA iletisi, son 30 gün.
 *  L2 alıcı bağı       : DSN'deki alıcı veya yanıtı yazan adres, iletinin gerçek alıcısıyla birebir aynı.
 *  L3 kanal tasdiki    : iletinin DIŞINDAN gelen (sağlayıcı bağdaştırıcısının verdiği) kimlik doğrulama sonucu.
 *                        İletinin kendi başlıkları (Authentication-Results dahil) saldırgan kontrolündedir ve KULLANILMAZ.
 *  L4 etki sınırları   : kod sınıfı, hacim sınırı, kendi posta kutumuzdan gelmeme.
 *  L5 izlenebilirlik   : her otomatik etki kanıt özetiyle denetim kaydına yazılır.
 *
 * DÜRÜSTLÜK NOTU: Bu sürümde hiçbir gerçek sağlayıcı yoktur. `demo_simulated` tasdik, testlerde ve demo gelen
 * kutusunda ÜRETİLEN BİR SİMÜLASYONDUR; gerçek SPF/DKIM/DMARC doğrulaması değildir. Gerçek sağlayıcı bağdaştırıcıları
 * (Aşama 14+) kendi tasdiklerini üretmelidir.
 */

export const MATCH_WINDOW_MS = 30 * DAY_MS;

export interface Attestation {
  /** Tasdikin kaynağı. `demo_simulated`: simülasyon (gerçek doğrulama değildir). */
  source: "demo_simulated" | "provider";
  /** Gönderen alan adı için kimlik doğrulama (SPF/DKIM/DMARC uyumlu) sonucu; iletinin dışından gelir. */
  senderAuth: "pass" | "fail" | "none";
  /** Zarf gönderen boş mu (`Return-Path: <>`)? DSN'lerde beklenir. */
  nullReturnPath: boolean;
}

/** Eşleşen giden ileti (L1). */
export interface OutboundMatch {
  id: number;
  mailboxId: number;
  purpose: "campaign" | "test" | "inbound";
  status: string;
  sentAt: number | null;
  peerHash: string;
  campaignId: number | null;
  campaignLeadId: number | null;
  leadId: number | null;
}

export interface EvidenceInput {
  /** ARF için: şikâyeti bildirmesine güvenilen rapor sağlayıcı alan adları (küçük harf). Boşsa hiçbir ARF doğrulanmaz. */
  trustedReporters?: ReadonlySet<string>;
  /** ARF için: eşleşen kampanya alıcısının adresi kayıtlı ve iletinin alıcı özetiyle tutarlı mı? */
  recipientResolvable?: boolean;
  parsed: ParsedInbound;
  kind: InboundKind;
  attestation: Attestation | null;
  match: OutboundMatch | null;
  mailboxId: number;
  mailboxAddress: string | null;
  now: number;
  /** Bu turda otomatik etki üretme hakkı kaldı mı (sel koruması)? */
  allowEffects: boolean;
}

export interface Evidence {
  l1: boolean;
  l2: boolean;
  l3: boolean;
  l4: boolean;
  /** Test gönderimine ait kimlik: hiçbir etki üretmez. */
  isTest: boolean;
  /** Neden tam doğrulanmadı (ilk başarısız katman); doğrulandıysa null. */
  reviewReason: string | null;
}

export function evaluateEvidence(i: EvidenceInput): Evidence {
  const { parsed: p, match, attestation } = i;
  const isTest = !!match && match.purpose === "test";

  const l1 =
    !!match &&
    match.purpose === "campaign" &&
    match.status === "sent" &&
    match.mailboxId === i.mailboxId &&
    match.sentAt !== null &&
    i.now - match.sentAt <= MATCH_WINDOW_MS &&
    match.sentAt <= i.now + 5 * 60_000;

  let l2 = false;
  if (match && l1) {
    if (i.kind === "complaint") {
      // RFC 5965: `Original-Rcpt-To` ve özgün iletinin `To` başlığı birçok sağlayıcıda gizlidir. Verilmişse HEPSİ
      // iletinin gerçek alıcısıyla birebir aynı olmalı; hiç verilmemişse alıcı, eşleşen (tek alıcılı) iletinin
      // kendisinden bellidir. Her iki durumda alıcı adresi kayıtlı olmalıdır.
      const cands = [...(p.arf?.originalRcptTo ?? []), ...(p.arf?.originalTo ?? [])];
      l2 = i.recipientResolvable !== false && cands.every((a) => hashEmail(a) === match.peerHash);
    } else if (i.kind.startsWith("bounce")) {
      const rcpts = p.dsn?.recipients ?? [];
      l2 = rcpts.length === 1 && hashEmail(rcpts[0]!.address) === match.peerHash;
    } else if (p.from) {
      l2 = hashEmail(p.from.email) === match.peerHash;
    }
  }

  let l3 = false;
  const reporterTrusted =
    !!p.from && (i.trustedReporters?.has(p.from.domain.toLowerCase()) ?? false);
  if (attestation && attestation.senderAuth === "pass") {
    if (i.kind === "complaint") {
      // Rapor, KENDİ kimliği doğrulanmış ve önceden güvenilir ilan edilmiş bir geri bildirim sağlayıcısından gelmeli.
      l3 = !!p.arf?.structural && p.suspicious.length === 0 && reporterTrusted;
    } else if (i.kind.startsWith("bounce")) {
      l3 =
        attestation.nullReturnPath &&
        !!p.dsn?.structural &&
        isSystemSender(p) &&
        p.suspicious.length === 0;
    } else {
      l3 = p.suspicious.length === 0;
    }
  }

  const ownMailbox =
    !!i.mailboxAddress && !!p.from && p.from.email === i.mailboxAddress.toLowerCase();
  let l4 = i.allowEffects && !ownMailbox && p.suspicious.length === 0;
  if (l4 && i.kind === "complaint") {
    l4 = p.arf?.feedbackType === "abuse" && p.arf.version === "1";
  }
  if (l4 && i.kind === "bounce_hard") {
    const st = p.dsn?.recipients[0]?.status ?? "";
    l4 = ADDRESS_GONE_STATUSES.has(st);
  }

  let reviewReason: string | null = null;
  if (isTest) reviewReason = "test_message";
  else if (!l1) reviewReason = match ? "match_invalid" : "no_match";
  else if (!l2)
    reviewReason =
      i.kind === "complaint" && i.recipientResolvable === false
        ? "recipient_unavailable"
        : "recipient_mismatch";
  else if (!attestation) reviewReason = "no_attestation";
  else if (!l3)
    reviewReason =
      i.kind === "complaint" && attestation.senderAuth === "pass" && !reporterTrusted
        ? "reporter_untrusted"
        : "attestation_failed";
  else if (!l4) reviewReason = i.allowEffects ? "limits" : "flood_guard";

  return { l1, l2, l3, l4, isTest, reviewReason };
}

export const evidenceOk = (e: Evidence) => e.l1 && e.l2 && e.l3 && e.l4 && !e.isTest;
