import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { domainRegistrations, type DomainRegistrationStatus } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";

export interface DomainAge {
  domain: string;
  /** `disabled`: Ayarlar'da alan adı yaşı denetimi kapalı (sorgu yapılmaz, sinyal sayılmaz; "bekliyor" denmez). */
  status: DomainRegistrationStatus | "disabled";
  registeredAt: number | null;
  checkedAt: number | null;
}

/**
 * Lead ayrıntısı için alan adı yaşı. Alan adı henüz kuyrukta değilse `pending` döner. Denetim kapalıysa `disabled`
 * (önceden alınmış tarih de gösterilmez: skor da onu saymaz; kullanıcı "denetim gelecek" sanmaz).
 */
export async function domainAgeFor(db: Db, domain: string | null): Promise<DomainAge | null> {
  if (!domain) return null;
  if (!(await getSetting(db, "novelty.rdap")).enabled)
    return { domain, status: "disabled", registeredAt: null, checkedAt: null };
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
