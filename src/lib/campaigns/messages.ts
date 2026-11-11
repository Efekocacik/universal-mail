import { and, desc, eq, lt } from "drizzle-orm";
import { maskEmail } from "@/lib/compliance/suppression";
import type { DbExecutor } from "@/lib/db/client";
import { campaigns, messages, type OutboundStatus } from "@/lib/db/schema";
import { CampaignError } from "./errors";

/**
 * Kampanyanın gönderim günlüğü (FR-CMP-10), SALT OKUNUR. İleti gövdesi, ham ileti ve tam alıcı adresi döndürülmez:
 * alıcı maskelenir, konu Google kaynaklı değişkenleri maskelenmiş `subject_logged`'dır.
 */

export interface CampaignMessageItem {
  id: number;
  campaignLeadId: number | null;
  stepIndex: number | null;
  status: OutboundStatus;
  recipientMasked: string | null;
  peerDomain: string;
  subject: string | null;
  errorCode: string | null;
  createdAt: number;
  sentAt: number | null;
}

export async function listCampaignMessages(
  db: DbExecutor,
  campaignId: number,
  opts: { beforeId?: number; limit?: number } = {},
): Promise<{ items: CampaignMessageItem[] }> {
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  const rows = await db
    .select({
      id: messages.id,
      campaignLeadId: messages.campaignLeadId,
      stepIndex: messages.stepIndex,
      status: messages.status,
      toAddress: messages.toAddress,
      peerDomain: messages.peerDomain,
      subject: messages.subjectLogged,
      errorCode: messages.errorCode,
      createdAt: messages.createdAt,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, campaignId),
        eq(messages.direction, "out"),
        opts.beforeId ? lt(messages.id, opts.beforeId) : undefined,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return {
    items: rows.map(({ toAddress, status, ...r }) => {
      const at = toAddress?.lastIndexOf("@") ?? -1;
      return {
        ...r,
        status: status as OutboundStatus,
        recipientMasked:
          toAddress && at > 0 ? maskEmail(toAddress.slice(0, at), toAddress.slice(at + 1)) : null,
      };
    }),
  };
}
