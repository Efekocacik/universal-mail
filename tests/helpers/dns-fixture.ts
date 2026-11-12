import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mailboxes } from "@/lib/db/schema";
import { recordDnsReport } from "@/lib/mail/dns-store";

/**
 * Canlı kampanya gönderiminin DNS kapısını (`dns_not_verified`) karşılar: kutunun kendi alan adı için `now` anında
 * SPF/DKIM/DMARC üçü de `pass` olan GERÇEK denetim kaydı (ağ yok; sonuç sahte).
 */
export async function recordPassingDns(db: Db, mailboxId: number, now: number): Promise<void> {
  const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  if (!mailbox) throw new Error("posta kutusu yok");
  const domain = mailbox.address?.slice(mailbox.address.lastIndexOf("@") + 1) ?? null;
  const ok = await recordDnsReport(
    db,
    mailbox,
    {
      mode: "checked",
      domain,
      spf: { status: "pass", codes: ["spf_ok"] },
      dkim: { status: "pass", codes: ["dkim_ok"] },
      dmarc: { status: "pass", codes: ["dmarc_ok"] },
    },
    now,
  );
  if (!ok) throw new Error("DNS denetim kaydı yazılamadı");
}
