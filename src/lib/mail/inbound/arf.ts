import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { isPublicSuffix, normalizeDomain } from "@/lib/compliance/suppression";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * ARF (RFC 5965) şikâyet raporu sağlayıcıları (Aşama 15.8): bir raporun OTOMATİK etki üretebilmesi için gönderenin
 * alan adı burada önceden ilan edilmiş olmalıdır (ve rapor yine de kimlik doğrulama tasdiki, eşleşme ve alıcı bağı
 * kontrollerinden geçer). Liste varsayılan BOŞTUR; hangi sağlayıcıların geri bildirim döngüsü sunduğu ve rapor
 * alan adları şirketin gerçek posta düzenine bağlıdır (bu sürümde bilinmez, VARSAYILMAZ). Adres alan adı kök
 * (public suffix) olamaz.
 */

export class ArfConfigError extends Error {
  constructor(
    readonly code: "invalid_domain" | "too_many",
    message: string,
  ) {
    super(message);
    this.name = "ArfConfigError";
  }
}

export async function getTrustedReporters(db: Pick<Db, "select">): Promise<string[]> {
  return getSetting(db as Db, "mail.arfReporters");
}

/** Güvenilir rapor sağlayıcılarının TAM listesini ayarlar (boş liste = hiçbir ARF doğrulanmaz). */
export async function setTrustedReporters(
  db: Db,
  domains: string[],
  now = Date.now(),
): Promise<string[]> {
  if (domains.length > 50) throw new ArfConfigError("too_many", "En çok 50 alan adı.");
  const out: string[] = [];
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d || isPublicSuffix(d)) {
      throw new ArfConfigError("invalid_domain", "Geçersiz rapor sağlayıcı alan adı.");
    }
    if (!out.includes(d)) out.push(d);
  }
  await setSetting(db, "mail.arfReporters", out);
  await audit(db, "arf.reporters_set", "setting", "mail.arfReporters", { count: out.length }, now);
  return out;
}
