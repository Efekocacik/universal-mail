import { and, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { messages } from "@/lib/db/schema";

/**
 * İnceleme kuyruğu (K4): otomatik etki üretmeyen, insan kararı bekleyen gelen iletiler. Gönderen adresi saklanmadığı
 * için yalnızca alan adı gösterilir; gövde saklanmaz.
 */

export interface ReviewItem {
  id: number;
  classification: string | null;
  /** Neden otomatik işlem yapılmadı (makine kodu). */
  reason: string | null;
  senderDomain: string;
  receivedAt: number;
  /** `apply` seçilebilir mi? (yalnızca bizim iletimize bağlanabilen çıkış/olumsuz/yanıt iletileri) */
  applicable: boolean;
}

export async function listReviewQueue(db: DbExecutor, limit = 100): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.direction, "in"), eq(messages.status, "received")))
    .orderBy(desc(messages.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((m) => ({
    id: m.id,
    classification: m.classification,
    reason: m.errorCode,
    senderDomain: m.peerDomain,
    receivedAt: m.receivedAt ?? m.createdAt,
    applicable:
      (m.classification === "unsubscribe" ||
        m.classification === "negative" ||
        m.classification === "reply") &&
      !!m.inReplyTo,
  }));
}
