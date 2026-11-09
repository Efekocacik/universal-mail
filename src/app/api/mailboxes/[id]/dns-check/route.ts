import { eq } from "drizzle-orm";
import { body, database, HttpError, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { audit } from "@/lib/db/audit";
import { mailboxes } from "@/lib/db/schema";
import { checkDomainAuth, isValidSelector, type DnsReport } from "@/lib/mail/dns-check";
import { requireConsent } from "../../../campaigns/schema";
import { dnsCheckSchema } from "../../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * SPF/DKIM/DMARC denetimi. DEMO posta kutusu için hiçbir DNS sorgusu (ağ isteği) YAPILMAZ: kullanıcı "Kontrol et"e
 * bassa da yanıt "demo" olarak döner. Alan adı istemciden alınmaz. Gerçek alan adı denetimi, ileride gerçek bir
 * sağlayıcı yapılandırıldığında ve kullanıcı isteğiyle ele alınacaktır; o zaman da alan adı posta kutusunun
 * kendi adresinden türetilir.
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, dnsCheckSchema);
  await requireConsent(db);
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
  if (!mb) throw new HttpError(404, "Posta kutusu bulunamadı.");
  if (input.selector && !isValidSelector(input.selector.trim())) {
    throw new HttpError(400, "Geçersiz DKIM seçici adı.", { code: "INVALID_SELECTOR" });
  }

  if (policyScopeForMailbox(mb.provider) === "demo") {
    const report: DnsReport = { mode: "demo", domain: null, spf: null, dkim: null, dmarc: null };
    await audit(db, "dns.checked", "mailbox", id, { mode: "demo" });
    return json(report);
  }

  const domain = mb.address?.slice(mb.address.lastIndexOf("@") + 1);
  if (!domain)
    throw new HttpError(409, "Kontrol edilecek bir alan adı yok.", { code: "NO_DOMAIN" });
  try {
    const report = await checkDomainAuth(domain, { selector: input.selector });
    await audit(db, "dns.checked", "mailbox", id, { mode: report.mode });
    return json(report);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "invalid_domain" || m === "invalid_selector") {
      throw new HttpError(
        400,
        m === "invalid_domain" ? "Geçersiz alan adı." : "Geçersiz DKIM seçici adı.",
        { code: m.toUpperCase() },
      );
    }
    throw e;
  }
});
