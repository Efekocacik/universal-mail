import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  leadEmails,
  leads,
  mailboxes,
  messages,
  suppressions,
  type CampaignLeadStatus,
} from "@/lib/db/schema";
import { parseEmail } from "@/lib/email/address";
import { refreshLeadSummary } from "@/lib/email/store";
import { DAY_MS } from "./frequency";
import { ERASURE_OF_TRANSMISSION_RECORDS_APPROVED, LEGAL_APPROVALS } from "./legal-status";
import { policyScopeForMailbox } from "./policies";
import { hashEmail, suppressEmailInTx } from "./suppression";

/**
 * Silme talebi (FR-CMPL-03, SRS 8.4; Aşama 14).
 *
 * İKİ KATMAN:
 *  - GÜVENLE YAPILANLAR (hukuki değerlendirme gerektirmeyen): adresi tutan `lead_emails` satırları; hiçbir zaman
 *    iletilmemiş (kuyrukta/başarısız) veya DEMO posta kutusundan "gönderilmiş" (gerçekte kimseye ulaşmamış)
 *    iletilerin ve dizilerin adres, konu ve hata metni; gelen iletilerin özeti. Bu kayıtlarda `peer_hash`/
 *    `recipient_hash`, kişiye başka bir yerden bağlanamayan RASTGELE bir yer tutucuyla değiştirilir.
 *  - HUKUKİ DEĞERLENDİRME BEKLEYENLER: GERÇEK bir posta kutusundan fiilen iletilmiş iletilerin kayıtları ve bu
 *    iletilere bağlı diziler. Bunların silinmesi/anonimleştirilmesi yasal saklama yükümlülükleriyle çakışabilir.
 *    `LEGAL_APPROVALS.erasureOfTransmissionRecords` bir yazılım sürümünde `true` yapılana kadar DOKUNULMAZ ve
 *    "bekliyor" olarak gösterilir. Kullanıcının "yükümlülüğüm yok" beyanı bu onayın yerine GEÇMEZ. Bu sürümde değer
 *    sahip kararıyla `true`'dur (11 Kasım 2026, dış hukuki inceleme yok): kayıtlar ilk çalıştırmada temizlenir.
 *
 * SUPPRESSION ÖZETİ: Silme sonrası kişiye yeniden ileti gönderilmesini önlemek için `erasure` nedenli engel kaydı
 * (e-posta ÖZETİ ve alan adı; maskeli adres tutulmaz) bırakılır. Özetin her durumda anonim olmadığı bilinir; bu
 * saklamanın dayanağı `LEGAL_APPROVALS.suppressionHashRetention` `true` olana kadar "bekliyor" sayılır (bu sürümde sahip
 * kararıyla `true`).
 *
 * YER TUTUCU GÜVENLİĞİ: Yer tutucu = sha256("um-erased-v1:" + 128 bit rastgele). Geçerli bir e-posta özeti DEĞİLDİR
 * (girdisi e-posta biçiminde olamaz), bu yüzden başka bir alıcıyla EŞLEŞMEZ. Aynı kişinin tüm kayıtları aynı yer
 * tutucuyu alır: alıcı sayımları (oran hesapları) tutarlı kalır. Yer tutucu hiçbir yerde saklanmaz.
 * `peer_domain` korunur (alan adı başına günlük sınır dizini ve kısıtları buna bağlıdır).
 *
 * YEDEKLER: Şema geçişi öncesi alınan `pre-migrate-*.db` kopyaları bu servis tarafından DEĞİŞTİRİLMEZ; en çok 5
 * kopya döngüde silinene kadar eski veri taşıyabilir. Arayüz bunu açıkça söyler (Faz 6'da şifreli yedek yönetimi).
 */

export const PLACEHOLDER_PREFIX = "um-erased-v1:";
export const ERASURE_TARGET_MS = 72 * 3_600_000;
const CHUNK = 400;

export type ErasureErrorKind =
  "invalid_input" | "invalid_email" | "unconfirmed" | "in_flight" | "not_approved";

export class ErasureError extends Error {
  constructor(
    readonly kind: ErasureErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface ErasureCounts {
  leadEmails: number;
  sequences: number;
  messages: number;
  /** Notlarında adres geçen işletme sayısı (yalnızca bilgi; otomatik temizlenmez). */
  notesMentions: number;
  leads: number;
}

export interface ErasurePreview {
  /** Hukuki değerlendirme gerektirmeden temizlenecekler. */
  safe: ErasureCounts;
  /** Gerçek posta kutusundan iletilmiş kayıtlar: hukuki değerlendirme bekler, şimdilik DOKUNULMAZ. */
  pending: { sequences: number; messages: number };
  /** Sürmekte olan gönderim varsa işlem yapılamaz. */
  inFlight: number;
  suppressionExists: boolean;
  transmissionRecordsApproved: boolean;
}

interface Collected {
  hash: string;
  email: string;
  leadEmailRows: { id: number; leadId: number }[];
  sequences: { id: number; status: CampaignLeadStatus; leadId: number }[];
  msgs: { id: number; live: boolean; transmitted: boolean; campaignLeadId: number | null }[];
  leadIds: number[];
}

function normalize(raw: string): { email: string; hash: string } {
  const p = parseEmail(raw.trim().toLowerCase());
  if (!p) throw new ErasureError("invalid_email", "Geçersiz e-posta adresi.");
  return { email: p.email, hash: hashEmail(p.email) };
}

async function collect(db: DbExecutor, rawEmail: string): Promise<Collected> {
  const { email, hash } = normalize(rawEmail);
  const leadEmailRows = await db
    .select({ id: leadEmails.id, leadId: leadEmails.leadId })
    .from(leadEmails)
    .where(eq(leadEmails.email, email));
  const sequences = await db
    .select({ id: campaignLeads.id, status: campaignLeads.status, leadId: campaignLeads.leadId })
    .from(campaignLeads)
    .where(or(eq(campaignLeads.recipientHash, hash), eq(campaignLeads.recipientEmail, email)));
  const msgRows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      status: messages.status,
      provider: mailboxes.provider,
      campaignLeadId: messages.campaignLeadId,
      leadId: messages.leadId,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(eq(messages.peerHash, hash));
  const msgs = msgRows.map((m) => {
    const live = policyScopeForMailbox(m.provider) === "live";
    const transmitted =
      m.direction === "out" && ["sending", "sent", "unknown"].includes(String(m.status));
    return { id: m.id, live, transmitted, campaignLeadId: m.campaignLeadId };
  });
  const leadIds = [
    ...new Set([
      ...leadEmailRows.map((r) => r.leadId),
      ...sequences.map((s) => s.leadId),
      ...msgRows.map((m) => m.leadId).filter((x): x is number => x !== null),
    ]),
  ];
  return { hash, email, leadEmailRows, sequences, msgs, leadIds };
}

/** Gerçek posta kutusundan iletilmiş mi? (hukuki değerlendirme bekleyen kayıt) */
const isPendingMessage = (m: Collected["msgs"][number]) => m.live && m.transmitted;

function split(c: Collected, approved: boolean) {
  const pendingMsgIds = new Set(approved ? [] : c.msgs.filter(isPendingMessage).map((m) => m.id));
  const pendingSeqIds = new Set(
    approved
      ? []
      : c.msgs
          .filter(isPendingMessage)
          .map((m) => m.campaignLeadId)
          .filter((x): x is number => x !== null),
  );
  return {
    safeMsgIds: c.msgs.filter((m) => !pendingMsgIds.has(m.id)).map((m) => m.id),
    pendingMsgIds: [...pendingMsgIds],
    safeSeqIds: c.sequences.filter((s) => !pendingSeqIds.has(s.id)).map((s) => s.id),
    pendingSeqIds: c.sequences.filter((s) => pendingSeqIds.has(s.id)).map((s) => s.id),
  };
}

async function notesMentions(db: DbExecutor, leadIds: number[], email: string): Promise<number> {
  if (leadIds.length === 0) return 0;
  const needle = `%${email.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  let n = 0;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          inArray(leads.id, leadIds.slice(i, i + CHUNK)),
          sql`lower(${leads.notes}) like ${needle} escape '\\'`,
        ),
      );
    n += rows.length;
  }
  return n;
}

export async function previewErasure(
  db: DbExecutor,
  rawEmail: string,
  opts: { transmissionRecordsApproved?: boolean } = {},
): Promise<ErasurePreview> {
  const approved = opts.transmissionRecordsApproved ?? ERASURE_OF_TRANSMISSION_RECORDS_APPROVED;
  const c = await collect(db, rawEmail);
  const s = split(c, approved);
  const [sup] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.scope, "email"),
        eq(suppressions.emailHash, c.hash),
        eq(suppressions.reason, "erasure"),
        isNull(suppressions.liftedAt),
      ),
    )
    .limit(1);
  return {
    safe: {
      leadEmails: c.leadEmailRows.length,
      sequences: s.safeSeqIds.length,
      messages: s.safeMsgIds.length,
      notesMentions: await notesMentions(db, c.leadIds, c.email),
      leads: c.leadIds.length,
    },
    pending: { sequences: s.pendingSeqIds.length, messages: s.pendingMsgIds.length },
    inFlight: c.sequences.filter((x) => x.status === "in_flight").length,
    suppressionExists: !!sup,
    transmissionRecordsApproved: approved,
  };
}

function newPlaceholder(random: (n: number) => Buffer = crypto.randomBytes): string {
  return crypto
    .createHash("sha256")
    .update(PLACEHOLDER_PREFIX + random(16).toString("hex"), "utf8")
    .digest("hex");
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function redactRows(
  tx: Tx,
  ids: { msgIds: number[]; seqIds: number[] },
  placeholder: string,
  now: number,
): Promise<void> {
  for (let i = 0; i < ids.msgIds.length; i += CHUNK) {
    await tx
      .update(messages)
      .set({
        toAddress: null,
        fromAddress: null,
        subjectLogged: null,
        errorMessage: null,
        peerHash: placeholder,
        redactedAt: now,
      })
      .where(inArray(messages.id, ids.msgIds.slice(i, i + CHUNK)));
  }
  for (let i = 0; i < ids.seqIds.length; i += CHUNK) {
    await tx
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: placeholder, redactedAt: now, updatedAt: now })
      .where(inArray(campaignLeads.id, ids.seqIds.slice(i, i + CHUNK)));
  }
}

const ACTIVE: CampaignLeadStatus[] = ["pending", "scheduled", "waiting_next"];

export interface ErasureInput {
  email: string;
  /** Talebin alındığı an (ms); 72 saatlik operasyonel hedef buradan ölçülür. */
  requestedAt: number;
  /** Kullanıcının notu. Hukuki onay YERİNE GEÇMEZ; yalnızca denetim kaydına uzunluğu yazılır. */
  justification: string;
  confirm: boolean;
  /** Etkilenen işletmelerin TÜM notlarını da temizle (varsayılan: hayır). */
  clearNotes?: boolean;
}

export interface ErasureResult {
  cleared: ErasureCounts;
  pending: { sequences: number; messages: number };
  notesCleared: number;
  overdue: boolean;
  suppression: "added" | "strengthened" | "existing";
  /** Suppression özetinin saklanması hukuki değerlendirme bekler. */
  suppressionRetentionPendingLegal: boolean;
}

export async function executeErasure(
  db: Db,
  input: ErasureInput,
  opts: {
    now?: number;
    transmissionRecordsApproved?: boolean;
    random?: (n: number) => Buffer;
  } = {},
): Promise<ErasureResult> {
  const now = opts.now ?? Date.now();
  const approved = opts.transmissionRecordsApproved ?? ERASURE_OF_TRANSMISSION_RECORDS_APPROVED;
  if (input.confirm !== true) throw new ErasureError("unconfirmed", "Açık onay gerekli.");
  const justification = input.justification.trim();
  if (justification.length < 10) {
    throw new ErasureError("invalid_input", "En az 10 karakterlik bir gerekçe yazın.");
  }
  if (
    !Number.isInteger(input.requestedAt) ||
    input.requestedAt > now ||
    input.requestedAt < now - 5 * 365 * DAY_MS
  ) {
    throw new ErasureError("invalid_input", "Talep tarihi geçersiz.");
  }
  const { email } = normalize(input.email);

  return db.transaction(async (tx): Promise<ErasureResult> => {
    const c = await collect(tx, email);
    if (c.sequences.some((s) => s.status === "in_flight")) {
      throw new ErasureError(
        "in_flight",
        "Bu adrese gönderim sürüyor; birkaç dakika sonra yeniden deneyin.",
      );
    }
    const s = split(c, approved);
    const placeholder = newPlaceholder(opts.random);

    // 1. Sürmekte olan diziler durdurulur (pending diziler dahil; adres onlarda kalsa bile iletişim durur).
    const activeIds = c.sequences.filter((x) => ACTIVE.includes(x.status)).map((x) => x.id);
    for (let i = 0; i < activeIds.length; i += CHUNK) {
      await tx
        .update(campaignLeads)
        .set({ status: "cancelled", nextSendAt: null, updatedAt: now })
        .where(inArray(campaignLeads.id, activeIds.slice(i, i + CHUNK)));
    }

    // 2. Adresi tutan lead_emails satırları (iletim kaydı değildir) silinir; özetler yenilenir.
    for (let i = 0; i < c.leadEmailRows.length; i += CHUNK) {
      await tx.delete(leadEmails).where(
        inArray(
          leadEmails.id,
          c.leadEmailRows.slice(i, i + CHUNK).map((r) => r.id),
        ),
      );
    }
    for (const leadId of new Set(c.leadEmailRows.map((r) => r.leadId))) {
      await refreshLeadSummary(tx as unknown as Db, leadId, now);
    }

    // 3. Hukuki değerlendirme gerektirmeyen ileti ve dizi kayıtları.
    await redactRows(tx, { msgIds: s.safeMsgIds, seqIds: s.safeSeqIds }, placeholder, now);

    // 4. Yeniden iletişimi önleyen asgari kayıt (e-posta özeti + alan adı).
    const sup = await suppressEmailInTx(tx, { email, reason: "erasure", source: "manual" }, now);

    // 5. Etkilenen işletmeler iletişime kapatılır; istenirse notları temizlenir.
    let notesCleared = 0;
    if (c.leadIds.length > 0) {
      for (let i = 0; i < c.leadIds.length; i += CHUNK) {
        await tx
          .update(leads)
          .set({ status: "do_not_contact", updatedAt: now })
          .where(inArray(leads.id, c.leadIds.slice(i, i + CHUNK)));
      }
      if (input.clearNotes) {
        for (let i = 0; i < c.leadIds.length; i += CHUNK) {
          const r = await tx
            .update(leads)
            .set({ notes: null })
            .where(
              and(
                inArray(leads.id, c.leadIds.slice(i, i + CHUNK)),
                sql`${leads.notes} IS NOT NULL`,
              ),
            )
            .returning({ id: leads.id });
          notesCleared += r.length;
        }
      }
    }

    const mentions = input.clearNotes ? 0 : await notesMentions(tx, c.leadIds, email);
    const cleared: ErasureCounts = {
      leadEmails: c.leadEmailRows.length,
      sequences: s.safeSeqIds.length,
      messages: s.safeMsgIds.length,
      notesMentions: mentions,
      leads: c.leadIds.length,
    };
    const overdue = now - input.requestedAt > ERASURE_TARGET_MS;
    // Denetim kaydı: yalnızca sayılar ve tarihler. Adres, özet ve yer tutucu YAZILMAZ.
    await audit(
      tx,
      "erasure.executed",
      "erasure",
      undefined,
      {
        requestedAt: input.requestedAt,
        executedAt: now,
        overdue,
        leadEmails: cleared.leadEmails,
        sequences: cleared.sequences,
        messages: cleared.messages,
        pendingSequences: s.pendingSeqIds.length,
        pendingMessages: s.pendingMsgIds.length,
        notesCleared,
        notesMentions: mentions,
        justificationLength: justification.length,
      },
      now,
    );
    return {
      cleared,
      pending: { sequences: s.pendingSeqIds.length, messages: s.pendingMsgIds.length },
      notesCleared,
      overdue,
      suppression: sup.outcome,
      suppressionRetentionPendingLegal: !LEGAL_APPROVALS.suppressionHashRetention,
    };
  });
}

export interface PendingErasures {
  /** Silme sonrası hâlâ adres/özet taşıyan, hukuki değerlendirme bekleyen kayıtlar (yalnızca sayılar). */
  messages: number;
  sequences: number;
  transmissionRecordsApproved: boolean;
}

/** `erasure` nedenli engeli olup kayıtları hâlâ duran kişilerin kayıt sayıları. */
export async function listPendingErasures(
  db: DbExecutor,
  opts: { transmissionRecordsApproved?: boolean } = {},
): Promise<PendingErasures> {
  const hashes = db
    .select({ h: suppressions.emailHash })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "erasure"),
        eq(suppressions.scope, "email"),
        isNull(suppressions.liftedAt),
      ),
    );
  const [m] = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(inArray(messages.peerHash, hashes), isNull(messages.redactedAt)));
  const [q] = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignLeads)
    .where(and(inArray(campaignLeads.recipientHash, hashes), isNull(campaignLeads.redactedAt)));
  return {
    messages: Number(m?.n ?? 0),
    sequences: Number(q?.n ?? 0),
    transmissionRecordsApproved:
      opts.transmissionRecordsApproved ?? ERASURE_OF_TRANSMISSION_RECORDS_APPROVED,
  };
}

/**
 * Hukuki onay kaydedildikten sonra (yeni yazılım sürümüyle) bekleyen kayıtları tamamlar. Onay yoksa REDDEDER.
 * Kayıtlar kişi bazında (e-posta özeti) gruplanır; her kişiye ayrı yer tutucu verilir.
 */
export async function completePendingErasures(
  db: Db,
  opts: {
    now?: number;
    transmissionRecordsApproved?: boolean;
    random?: (n: number) => Buffer;
  } = {},
): Promise<{ messages: number; sequences: number }> {
  const approved = opts.transmissionRecordsApproved ?? ERASURE_OF_TRANSMISSION_RECORDS_APPROVED;
  if (!approved) {
    throw new ErasureError(
      "not_approved",
      "Gerçek gönderim kayıtlarının silinmesi için hukuki değerlendirme tamamlanmadı.",
    );
  }
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const sups = await tx
      .select({ h: suppressions.emailHash })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.reason, "erasure"),
          eq(suppressions.scope, "email"),
          isNull(suppressions.liftedAt),
        ),
      );
    let m = 0;
    let q = 0;
    for (const { h } of sups) {
      if (!h) continue;
      const msgIds = (
        await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.peerHash, h), isNull(messages.redactedAt)))
      ).map((r) => r.id);
      const seqIds = (
        await tx
          .select({ id: campaignLeads.id })
          .from(campaignLeads)
          .where(and(eq(campaignLeads.recipientHash, h), isNull(campaignLeads.redactedAt)))
      ).map((r) => r.id);
      if (msgIds.length + seqIds.length === 0) continue;
      await redactRows(tx, { msgIds, seqIds }, newPlaceholder(opts.random), now);
      m += msgIds.length;
      q += seqIds.length;
    }
    await audit(
      tx,
      "erasure.pending_completed",
      "erasure",
      undefined,
      { messages: m, sequences: q },
      now,
    );
    return { messages: m, sequences: q };
  });
}

export interface ErasureHistoryItem {
  id: number;
  executedAt: number;
  requestedAt: number;
  overdue: boolean;
  cleared: number;
  pending: number;
}

/** Son silme talepleri (denetim kaydından; adres içermez). */
export async function listErasureHistory(
  db: DbExecutor,
  limit = 20,
): Promise<ErasureHistoryItem[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "erasure.executed"))
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
    return {
      id: r.id,
      executedAt: num("executedAt") || r.at,
      requestedAt: num("requestedAt"),
      overdue: d.overdue === true,
      cleared: num("leadEmails") + num("sequences") + num("messages"),
      pending: num("pendingSequences") + num("pendingMessages"),
    };
  });
}
