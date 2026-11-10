import crypto from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { autoPauseIfNeeded } from "@/lib/campaigns/auto-stop";
import { enforceMailboxHealth } from "../mailbox-health";
import { hashEmail, suppressEmailInTx } from "@/lib/compliance/suppression";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import {
  campaignLeads,
  leads,
  mailboxes,
  messages,
  type CampaignLeadStatus,
  type InboundStatus,
  type MessageClassification,
} from "@/lib/db/schema";
import { classifyInbound, type InboundKind } from "./classify";
import {
  evaluateEvidence,
  evidenceOk,
  type Attestation,
  type Evidence,
  type OutboundMatch,
} from "./evidence";
import { parseInbound, type ParsedInbound } from "./parse";

/**
 * Gelen ileti işleme (Aşama 13). Sağlayıcıdan bağımsızdır; yalnızca DEMO posta kutuları için çalışır (canlı kapsam
 * reddedilir). Güvenlik kuralları:
 *  - Etki (suppression, dizi durdurma, kampanya duraklatma) yalnızca kanıt katmanları geçtiğinde ve TEK işlemde
 *    uygulanır; aksi halde ileti kayda alınır ve "inceleme gerekli" (status `received`) olur.
 *  - Doğrulanmamış satırlara kampanya/dizi bağlantısı YAZILMAZ: uygunluk denetimi bağlı yanıtları gönderim engeli
 *    sayar, bu yüzden bağlantı yazmak başlı başına bir "durdurma" olurdu.
 *  - Olumsuz/belirsiz ifade (`negative`) hiçbir koşulda otomatik suppression üretmez.
 *  - Gövde ve gönderen adresi SAKLANMAZ (yalnızca özetler); aynı ham ileti ikinci kez işlenmez.
 */

export const LINKABLE_FROM: readonly CampaignLeadStatus[] = [
  "pending",
  "scheduled",
  "waiting_next",
  "completed",
];

export interface InboundEnvelope {
  mailboxId: number;
  raw: string;
  receivedAt: number;
  /** Sağlayıcı bağdaştırıcısının İLETİNİN DIŞINDAN verdiği tasdik; yoksa null (otomatik etki yok). */
  attestation: Attestation | null;
}

export interface ProcessOptions {
  now?: number;
  /** Sel koruması: false ise ileti yalnızca kayda alınır, otomatik etki üretmez. */
  allowEffects?: boolean;
}

export interface InboundEffects {
  suppressed: boolean;
  sequenceStopped: boolean;
  bounce: "hard" | "soft" | null;
  campaignPaused: boolean;
}

export type ProcessResult =
  | { outcome: "rejected"; code: "mailbox_not_found" | "live_scope" | "mailbox_inactive" }
  | { outcome: "duplicate" }
  | {
      outcome: "processed";
      inboundId: number;
      kind: InboundKind | "unparseable";
      status: InboundStatus;
      reviewReason: string | null;
      effects: InboundEffects;
    };

const NO_EFFECTS: InboundEffects = {
  suppressed: false,
  sequenceStopped: false,
  bounce: null,
  campaignPaused: false,
};

const CLASSIFICATION: Record<InboundKind, MessageClassification> = {
  bounce_hard: "bounce",
  bounce_soft: "bounce",
  bounce_policy: "bounce",
  bounce_other: "bounce",
  auto_reply: "auto_reply",
  unsubscribe: "unsubscribe",
  negative: "negative",
  reply: "reply",
  other: "other",
};

const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(
    String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? ""),
  );

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function findMatch(
  tx: Tx,
  ids: string[],
  mailboxId: number,
  fallbackPeerHash: string | null,
): Promise<OutboundMatch | null> {
  const cols = {
    id: messages.id,
    mailboxId: messages.mailboxId,
    purpose: messages.purpose,
    status: messages.status,
    sentAt: messages.sentAt,
    peerHash: messages.peerHash,
    campaignId: messages.campaignId,
    campaignLeadId: messages.campaignLeadId,
    leadId: messages.leadId,
  };
  if (ids.length > 0) {
    const rows = await tx
      .select(cols)
      .from(messages)
      .where(and(eq(messages.direction, "out"), inArray(messages.rfcMessageId, ids)))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (rows[0]) return rows[0] as OutboundMatch;
  }
  if (fallbackPeerHash) {
    const rows = await tx
      .select(cols)
      .from(messages)
      .where(
        and(
          eq(messages.direction, "out"),
          eq(messages.purpose, "campaign"),
          eq(messages.status, "sent"),
          eq(messages.mailboxId, mailboxId),
          eq(messages.peerHash, fallbackPeerHash),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (rows[0]) return rows[0] as OutboundMatch;
  }
  return null;
}

interface Plan {
  status: InboundStatus;
  reviewReason: string | null;
  /** Uygulanacak etki; null ise yalnızca kayıt. */
  apply: "hard_bounce" | "soft_bounce" | "reply" | "unsubscribe" | null;
  /** Satıra kampanya/dizi bağlantısı yazılsın mı? */
  link: boolean;
}

function planFor(kind: InboundKind, ev: Evidence, match: OutboundMatch | null): Plan {
  if (ev.isTest)
    return { status: "ignored", reviewReason: "test_message", apply: null, link: false };
  const verified = evidenceOk(ev);
  const soft3 = ev.l1 && ev.l2 && ev.l3;
  const unverified = (): Plan => ({
    status: match && ev.l1 ? "received" : "unmatched",
    reviewReason: ev.reviewReason,
    apply: null,
    link: false,
  });
  switch (kind) {
    case "auto_reply":
      return { status: "ignored", reviewReason: null, apply: null, link: false };
    case "bounce_hard":
      return verified
        ? { status: "matched", reviewReason: null, apply: "hard_bounce", link: true }
        : unverified();
    case "bounce_soft":
      return soft3
        ? { status: "matched", reviewReason: null, apply: "soft_bounce", link: true }
        : unverified();
    case "bounce_policy":
    case "bounce_other":
      return soft3
        ? { status: "matched", reviewReason: null, apply: null, link: true }
        : {
            status: match && ev.l1 ? "matched" : "unmatched",
            reviewReason: ev.reviewReason,
            apply: null,
            link: false,
          };
    case "reply":
      return verified
        ? { status: "matched", reviewReason: null, apply: "reply", link: true }
        : unverified();
    case "unsubscribe":
      return verified
        ? { status: "matched", reviewReason: null, apply: "unsubscribe", link: true }
        : unverified();
    case "negative":
      return {
        status: match && ev.l1 ? "received" : "unmatched",
        reviewReason: "negative_needs_review",
        apply: null,
        link: false,
      };
    default:
      return {
        status: match && ev.l1 ? "received" : "unmatched",
        reviewReason: ev.reviewReason ?? "unclassified",
        apply: null,
        link: false,
      };
  }
}

export async function processInbound(
  db: Db,
  env: InboundEnvelope,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const now = opts.now ?? Date.now();
  const allowEffects = opts.allowEffects ?? true;
  const rawHash = crypto.createHash("sha256").update(env.raw, "utf8").digest("hex");
  const syntheticId = `<in-${rawHash.slice(0, 32)}@inbound.invalid>`;

  try {
    return await db.transaction(async (tx): Promise<ProcessResult> => {
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, env.mailboxId))
        .limit(1);
      if (!mailbox) return { outcome: "rejected", code: "mailbox_not_found" };
      if (policyScopeForMailbox(mailbox.provider) !== "demo")
        return { outcome: "rejected", code: "live_scope" };
      if (mailbox.status !== "connected") return { outcome: "rejected", code: "mailbox_inactive" };

      const dup = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.rfcMessageId, syntheticId), eq(messages.direction, "in")))
        .limit(1);
      if (dup.length > 0) return { outcome: "duplicate" };

      const parsed = parseInbound(env.raw);
      if (!parsed.ok) {
        const [row] = await tx
          .insert(messages)
          .values({
            direction: "in",
            purpose: "inbound",
            mailboxId: mailbox.id,
            rfcMessageId: syntheticId,
            peerHash: hashEmail("unknown-sender"),
            peerDomain: "unknown.invalid",
            bodySha256: rawHash,
            status: "ignored",
            errorCode: `parse_${parsed.reason}`,
            createdAt: now,
            receivedAt: env.receivedAt,
          })
          .returning({ id: messages.id });
        return {
          outcome: "processed",
          inboundId: row!.id,
          kind: "unparseable",
          status: "ignored",
          reviewReason: `parse_${parsed.reason}`,
          effects: NO_EFFECTS,
        };
      }

      const kind = classifyInbound(parsed);
      const refIds = kind.startsWith("bounce")
        ? parsed.dsn?.originalMessageId
          ? [parsed.dsn.originalMessageId]
          : []
        : [...parsed.inReplyTo, ...parsed.references.slice().reverse()].slice(0, 10);
      const fromHash = parsed.from ? hashEmail(parsed.from.email) : null;
      const match = await findMatch(
        tx,
        refIds,
        mailbox.id,
        kind === "unsubscribe" ? fromHash : null,
      );

      const ev = evaluateEvidence({
        parsed,
        kind,
        attestation: env.attestation,
        match,
        mailboxId: mailbox.id,
        mailboxAddress: mailbox.address,
        now,
        allowEffects,
      });
      const plan = planFor(kind, ev, match);

      const [row] = await tx
        .insert(messages)
        .values({
          direction: "in",
          purpose: "inbound",
          campaignId: plan.link ? match!.campaignId : null,
          campaignLeadId: plan.link ? match!.campaignLeadId : null,
          leadId: plan.link ? match!.leadId : null,
          mailboxId: mailbox.id,
          rfcMessageId: syntheticId,
          inReplyTo: kind.startsWith("bounce")
            ? (parsed.dsn?.originalMessageId ?? null)
            : (parsed.inReplyTo[0] ?? null),
          references: kind.startsWith("bounce")
            ? null
            : parsed.references.length > 0
              ? parsed.references
              : null,
          peerHash: fromHash ?? hashEmail("unknown-sender"),
          peerDomain: parsed.from?.domain ?? "unknown.invalid",
          bodySha256: rawHash,
          status: plan.status,
          classification: CLASSIFICATION[kind],
          errorCode: plan.reviewReason,
          createdAt: now,
          receivedAt: env.receivedAt,
        })
        .returning({ id: messages.id });
      const inboundId = row!.id;

      const effects = plan.apply
        ? await applyEffect(tx, plan.apply, {
            parsed,
            match: match!,
            inboundId,
            now,
            ev,
            attestation: env.attestation!,
          })
        : NO_EFFECTS;

      if (plan.status === "received") {
        await audit(
          tx,
          "inbound.review_needed",
          "message",
          inboundId,
          { kind, reason: plan.reviewReason, layers: layers(ev) },
          now,
        );
      }
      return {
        outcome: "processed",
        inboundId,
        kind,
        status: plan.status,
        reviewReason: plan.reviewReason,
        effects,
      };
    });
  } catch (e) {
    if (isUnique(e)) return { outcome: "duplicate" };
    throw e;
  }
}

const layers = (ev: Evidence) => `${ev.l1 ? 1 : 0}${ev.l2 ? 1 : 0}${ev.l3 ? 1 : 0}${ev.l4 ? 1 : 0}`;

async function setSequenceStatus(
  tx: Tx,
  campaignLeadId: number | null,
  status: CampaignLeadStatus,
  now: number,
): Promise<boolean> {
  if (campaignLeadId === null) return false;
  const rows = await tx
    .update(campaignLeads)
    .set({ status, nextSendAt: null, updatedAt: now })
    .where(
      and(eq(campaignLeads.id, campaignLeadId), inArray(campaignLeads.status, [...LINKABLE_FROM])),
    )
    .returning({ id: campaignLeads.id });
  return rows.length === 1;
}

async function applyEffect(
  tx: Tx,
  kind: NonNullable<Plan["apply"]>,
  c: {
    parsed: ParsedInbound;
    match: OutboundMatch;
    inboundId: number;
    now: number;
    ev: Evidence;
    attestation: Attestation;
  },
): Promise<InboundEffects> {
  const { match, now } = c;
  const detail = {
    inboundId: c.inboundId,
    outboundId: match.id,
    campaignId: match.campaignId,
    layers: layers(c.ev),
    attestation: c.attestation.source,
  };
  const effects: InboundEffects = { ...NO_EFFECTS };

  if (kind === "soft_bounce") {
    await tx
      .update(messages)
      .set({ deliveryStatus: "bounced_soft" })
      .where(and(eq(messages.id, match.id), isNotNull(messages.sentAt)));
    effects.bounce = "soft";
    await audit(tx, "inbound.bounce_soft", "message", c.inboundId, detail, now);
    return effects;
  }

  if (kind === "hard_bounce") {
    const address = c.parsed.dsn!.recipients[0]!.address;
    await tx
      .update(messages)
      .set({ deliveryStatus: "bounced_hard" })
      .where(eq(messages.id, match.id));
    effects.bounce = "hard";
    await suppressEmailInTx(
      tx,
      { email: address, reason: "bounce_hard", source: "bounce", messageId: c.inboundId },
      now,
    );
    effects.suppressed = true;
    effects.sequenceStopped = await setSequenceStatus(tx, match.campaignLeadId, "bounced", now);
    await audit(tx, "inbound.bounce_hard", "message", c.inboundId, detail, now);
    if (match.campaignId !== null)
      effects.campaignPaused = await autoPauseIfNeeded(tx, match.campaignId, now);
    // Posta kutusu düzeyi (SRS 5.6.1): eşik aşıldıysa kutu durdurulur, çalışan kampanyalar duraklar.
    if (await enforceMailboxHealth(tx, match.mailboxId, now)) effects.campaignPaused = true;
    return effects;
  }

  if (kind === "reply") {
    effects.sequenceStopped = await setSequenceStatus(tx, match.campaignLeadId, "replied", now);
    if (match.leadId !== null) await markLeadReplied(tx, match.leadId, now);
    await audit(tx, "inbound.reply", "message", c.inboundId, detail, now);
    return effects;
  }

  // unsubscribe: gönderen adresi alıcıyla birebir aynıdır (L2); adres yalnızca bellekte kullanılır.
  const email = c.parsed.from!.email;
  await suppressEmailInTx(
    tx,
    { email, reason: "unsubscribe", source: "inbox", messageId: c.inboundId },
    now,
  );
  effects.suppressed = true;
  effects.sequenceStopped = await setSequenceStatus(tx, match.campaignLeadId, "unsubscribed", now);
  await audit(tx, "inbound.unsubscribe", "message", c.inboundId, detail, now);
  return effects;
}

async function markLeadReplied(tx: Tx, leadId: number, now: number): Promise<void> {
  const rows = await tx
    .update(leads)
    .set({ status: "replied", updatedAt: now })
    .where(and(eq(leads.id, leadId), inArray(leads.status, ["new", "enriched", "queued", "sent"])))
    .returning({ id: leads.id });
  if (rows.length === 1)
    await audit(tx, "lead.status", "lead", leadId, { status: "replied", via: "inbound" }, now);
}

/* ------------------------------------------------------------------------------------------------
 * İnsan incelemesi (K4)
 * ---------------------------------------------------------------------------------------------- */

export type ReviewDecision = "apply" | "ignore";

export type ReviewErrorKind = "not_found" | "not_reviewable" | "cannot_apply";

export class ReviewError extends Error {
  constructor(
    readonly kind: ReviewErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * İnceleme kuyruğundaki iletiyi KULLANICI KARARIYLA çözer. `apply`: ileti türünün standart etkisi (çıkış →
 * suppression, olumsuz → suppression `negative_reply`, yanıt → dizi durdurma). Yalnızca bizim gönderdiğimiz bir
 * kampanya iletisine bağlanabilen ve alıcı adresi hâlâ kayıtlı olan iletiler uygulanabilir; bounce yalnızca yok
 * sayılabilir (elle suppression Uyum ekranındadır).
 */
export async function resolveReview(
  db: Db,
  inboundId: number,
  decision: ReviewDecision,
  now = Date.now(),
): Promise<{ status: InboundStatus; suppressed: boolean }> {
  return db.transaction(async (tx) => {
    const [m] = await tx.select().from(messages).where(eq(messages.id, inboundId)).limit(1);
    if (!m || m.direction !== "in") throw new ReviewError("not_found", "İleti bulunamadı.");
    if (m.status !== "received")
      throw new ReviewError("not_reviewable", "Bu ileti incelemede değil.");

    if (decision === "ignore") {
      await tx.update(messages).set({ status: "ignored" }).where(eq(messages.id, inboundId));
      await audit(
        tx,
        "inbound.review_ignored",
        "message",
        inboundId,
        { classification: m.classification },
        now,
      );
      return { status: "ignored" as const, suppressed: false };
    }

    const cls = m.classification;
    if (cls !== "unsubscribe" && cls !== "negative" && cls !== "reply") {
      throw new ReviewError("cannot_apply", "Bu ileti türü için yalnızca 'yok say' seçilebilir.");
    }
    const ids = [
      ...(m.inReplyTo ? [m.inReplyTo] : []),
      ...(m.references ?? []).slice().reverse(),
    ].slice(0, 10);
    const match = ids.length ? await findMatch(tx, ids, m.mailboxId, null) : null;
    if (
      !match ||
      match.purpose !== "campaign" ||
      match.status !== "sent" ||
      match.mailboxId !== m.mailboxId ||
      match.campaignLeadId === null
    ) {
      throw new ReviewError(
        "cannot_apply",
        "İleti bizim gönderdiğimiz bir kampanya iletisiyle eşleşmiyor.",
      );
    }
    const [cl] = await tx
      .select()
      .from(campaignLeads)
      .where(eq(campaignLeads.id, match.campaignLeadId))
      .limit(1);
    if (!cl || !cl.recipientEmail || hashEmail(cl.recipientEmail) !== m.peerHash) {
      throw new ReviewError(
        "cannot_apply",
        "Gönderen, kampanya alıcısıyla aynı değil veya alıcı adresi silinmiş.",
      );
    }

    let suppressed = false;
    if (cls === "reply") {
      await setSequenceStatus(tx, cl.id, "replied", now);
      if (match.leadId !== null) await markLeadReplied(tx, match.leadId, now);
    } else {
      await suppressEmailInTx(
        tx,
        {
          email: cl.recipientEmail,
          reason: cls === "unsubscribe" ? "unsubscribe" : "negative_reply",
          source: "inbox",
          messageId: inboundId,
        },
        now,
      );
      suppressed = true;
      await setSequenceStatus(tx, cl.id, "unsubscribed", now);
    }
    await tx
      .update(messages)
      .set({
        status: "matched",
        campaignId: match.campaignId,
        campaignLeadId: match.campaignLeadId,
        leadId: match.leadId,
      })
      .where(eq(messages.id, inboundId));
    await audit(
      tx,
      "inbound.review_applied",
      "message",
      inboundId,
      { classification: cls, outboundId: match.id },
      now,
    );
    return { status: "matched" as const, suppressed };
  });
}
