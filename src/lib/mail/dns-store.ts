import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { getSetting, setSetting } from "@/lib/settings";
import { domainOfAddress, isConsumerGmailDomain } from "./consumer-gmail";
import type { CheckItem, DnsReport } from "./dns-check";

/**
 * DNS (SPF/DKIM/DMARC) denetim sonuçlarının saklanması ve hazırlık değerlendirmesi (Aşama 15.7).
 *
 *  - Yalnızca GERÇEK denetim (`mode === "checked"`) ve yalnızca posta kutusunun KENDİ adresinin alan adı için kayda
 *    geçer; demo yanıtı veya başka bir alan adı kanıt olamaz. Ham TXT kaydı saklanmaz: durumlar ve neden kodları.
 *  - Sonuç bilgilendiricidir (teslim edilebilirlik garantisi değildir); hazırlık ekranında "tamam" yalnızca üç denetim
 *    de TAZE ve `pass` ise gösterilir. Bu modül ağ isteği yapmaz; denetimi yalnızca kullanıcı eylemi (API) tetikler.
 */

/** Sonucun tazelik süresi: bayat sonuç hazırlık için "doğrulanmadı" sayılır. */
export const DNS_FRESH_MS = 30 * 86_400_000;

export type DnsReadiness = "ok" | "blocked" | "unknown";

const domainOf = (address: string | null): string | null => domainOfAddress(address);

/** Kutunun gönderen alan adının e-posta kimlik doğrulaması sağlayıcı (Google) tarafından mı yönetiliyor? */
export function isDnsProviderManaged(mailbox: { address: string | null }): boolean {
  return isConsumerGmailDomain(domainOf(mailbox.address));
}

/**
 * Bir denetim sonucunu saklar. Saklanırsa true. Saklanmaz: demo/denetlenmemiş rapor, alan adı kutunun adresinin
 * alan adı değilse.
 */
export async function recordDnsReport(
  db: Db,
  mailbox: { id: number; address: string | null },
  report: DnsReport,
  now = Date.now(),
): Promise<boolean> {
  const own = domainOf(mailbox.address);
  if (report.mode !== "checked" || !report.domain || !own || report.domain.toLowerCase() !== own) {
    return false;
  }
  const codes = [report.spf, report.dkim, report.dmarc].flatMap((i) => i?.codes ?? []);
  const reports = await getSetting(db, "mail.dnsReports");
  await setSetting(db, "mail.dnsReports", {
    ...reports,
    [String(mailbox.id)]: {
      domain: own,
      checkedAt: now,
      spf: report.spf?.status ?? null,
      dkim: report.dkim?.status ?? null,
      dmarc: report.dmarc?.status ?? null,
      codes: codes.slice(0, 30),
    },
  });
  await audit(
    db,
    "dns.recorded",
    "mailbox",
    mailbox.id,
    {
      spf: report.spf?.status ?? null,
      dkim: report.dkim?.status ?? null,
      dmarc: report.dmarc?.status ?? null,
    },
    now,
  );
  return true;
}

/** Posta kutusu silinince kaydı da silinir. */
export async function clearDnsReport(db: DbExecutor, mailboxId: number): Promise<void> {
  const reports = await getSetting(db, "mail.dnsReports");
  if (!(String(mailboxId) in reports)) return;
  const { [String(mailboxId)]: _removed, ...rest } = reports;
  void _removed;
  await setSetting(db, "mail.dnsReports", rest);
}

const status = (i: CheckItem["status"] | null): i is CheckItem["status"] => i !== null;

/**
 * Bağlı gerçek posta kutuları için DNS durumu.
 *  - Bağlı gerçek kutu yok → unknown (ölçülemez).
 *  - Sağlayıcı yönetimli (kişisel Gmail) kutu kayıt aranmadan `pass` sayılır.
 *  - Herhangi bir kutuda `fail` → blocked (taze sonuçta).
 *  - Hepsinde taze + üç denetim `pass` → ok.
 *  - Aksi halde (kayıt yok, bayat, uyarı, DKIM seçicisi verilmemiş, alan adı değişmiş) → unknown.
 */
export async function evaluateDnsReadiness(
  db: DbExecutor,
  boxes: { id: number; address: string | null }[],
  now = Date.now(),
): Promise<DnsReadiness> {
  if (boxes.length === 0) return "unknown";
  const reports = await getSetting(db, "mail.dnsReports");
  let allPass = true;
  for (const b of boxes) {
    if (isDnsProviderManaged(b)) continue; // Google yönetir: kullanıcı kaydı yok ve gerekmez
    const r = reports[String(b.id)];
    const fresh =
      !!r &&
      now - r.checkedAt <= DNS_FRESH_MS &&
      r.checkedAt <= now + 5 * 60_000 &&
      r.domain === domainOf(b.address);
    if (!fresh) {
      allPass = false;
      continue;
    }
    const s = [r.spf, r.dkim, r.dmarc];
    if (s.some((x) => x === "fail")) return "blocked";
    if (!s.every((x) => status(x) && x === "pass")) allPass = false;
  }
  return allPass ? "ok" : "unknown";
}
