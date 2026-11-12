import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { domainRegistrations, type DomainRegistrationStatus } from "@/lib/db/schema";

export interface DomainAge {
  domain: string;
  status: DomainRegistrationStatus;
  registeredAt: number | null;
  checkedAt: number | null;
}

/** Lead ayrıntısı için alan adı yaşı. Alan adı henüz kuyrukta değilse `pending` döner. */
export async function domainAgeFor(db: Db, domain: string | null): Promise<DomainAge | null> {
  if (!domain) return null;
  const row = (
    await db
      .select()
      .from(domainRegistrations)
      .where(eq(domainRegistrations.domain, domain))
      .limit(1)
  )[0];
  return {
    domain,
    status: row?.status ?? "pending",
    registeredAt: row?.registeredAt ?? null,
    checkedAt: row?.checkedAt ?? null,
  };
}
