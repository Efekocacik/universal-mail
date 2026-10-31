import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { maskEmail } from "@/lib/compliance/suppression";
import type { DbExecutor } from "@/lib/db/client";
import { messages } from "@/lib/db/schema";
import { STALE_SENDING_MS } from "../send-service";

/**
 * Sonucu kesinleşmemiş gönderimlerin SALT OKUNUR inceleme listesi (FR-CMP-10). Kayıtları değiştirmez; manuel çözüm
 * veya yeniden gönderime izin veren bir işlem bu sürümde YOKTUR. Bu dizilerin hiçbiri otomatik olarak yeniden
 * gönderilmez: `unknown` iletinin dizisi `in_flight` kalır ve dağıtıcı onu hiç seçmez.
 *
 * Alıcı adresi maskelenir; ham ileti zaten hiçbir yerde saklanmaz.
 */

export interface ReviewItem {
  messageId: number;
  campaignId: number | null;
  campaignLeadId: number | null;
  stepIndex: number | null;
  status: "unknown" | "sending";
  errorCode: string | null;
  recipientMasked: string | null;
  peerDomain: string;
  createdAt: number;
}

function maskAddress(address: string | null): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at <= 0) return null;
  return maskEmail(address.slice(0, at), address.slice(at + 1));
}

export async function listSendsNeedingReview(
  db: DbExecutor,
  opts: { now?: number; limit?: number } = {},
): Promise<ReviewItem[]> {
  const now = opts.now ?? Date.now();
  const rows = await db
    .select({
      messageId: messages.id,
      campaignId: messages.campaignId,
      campaignLeadId: messages.campaignLeadId,
      stepIndex: messages.stepIndex,
      status: messages.status,
      errorCode: messages.errorCode,
      toAddress: messages.toAddress,
      peerDomain: messages.peerDomain,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "out"),
        or(
          eq(messages.status, "unknown"),
          // Uzlaştırılmamış eski `sending` (ör. uzlaştırma henüz çalışmadı).
          and(eq(messages.status, "sending"), lt(messages.createdAt, now - STALE_SENDING_MS)),
        ),
        inArray(messages.purpose, ["campaign", "test"]),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return rows.map(({ toAddress, status, ...r }) => ({
    ...r,
    status: status as ReviewItem["status"],
    recipientMasked: maskAddress(toAddress),
  }));
}
