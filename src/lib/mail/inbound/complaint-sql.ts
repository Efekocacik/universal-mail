import { and, eq, like, or, sql, type SQL } from "drizzle-orm";
import {
  campaignLeads,
  messages,
  type MessageClassification,
  type SequenceStopReason,
} from "@/lib/db/schema";
import { ARF_COMPLAINT_CODE } from "./complaint";

/** `complaint.ts`'teki okuma kurallarının SQL karşılıkları (yalnızca sunucu). */

/** SQL: gelen satır bir ARF şikâyeti mi (sütun VEYA eski işaret). */
export function isComplaintMessageSql(): SQL {
  return or(
    eq(messages.classification, "complaint" satisfies MessageClassification),
    and(
      eq(messages.classification, "other"),
      or(
        eq(messages.errorCode, ARF_COMPLAINT_CODE),
        like(messages.errorCode, `${ARF_COMPLAINT_CODE}:%`),
      ),
    ),
  )!;
}

/** `effectiveStopReason`'ın SQL karşılığı (sayaçlar için; `campaign_leads` satırı üzerinde). */
export function effectiveStopReasonSql(): SQL<SequenceStopReason | null> {
  return sql<SequenceStopReason | null>`CASE WHEN ${campaignLeads.stopReason} IS NOT NULL THEN ${campaignLeads.stopReason} WHEN ${campaignLeads.status} = 'unsubscribed' THEN CASE WHEN ${campaignLeads.exclusionReasons} LIKE ${`%"${ARF_COMPLAINT_CODE}"%`} THEN 'complaint' ELSE 'unsubscribe' END ELSE NULL END`;
}
