import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { getTrustedReporters, setTrustedReporters } from "@/lib/mail/inbound/arf";
import { requireConsent } from "../../campaigns/schema";
import { arfReportersSchema } from "../unsubscribe/shared";

export const dynamic = "force-dynamic";

/**
 * Şikâyet (ARF) raporu bildirmesine güvenilen sağlayıcı alan adları (Aşama 15.8). Liste TAMAMEN değiştirilir; boş liste
 * hiçbir ARF raporunun otomatik etki üretmemesi demektir (raporlar inceleme kuyruğuna düşer). En çok 50 alan adı;
 * kök alan adları (public suffix) reddedilir.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return json({ domains: await getTrustedReporters(db) });
});

export const PUT = domainRoute(async (req: Request) => {
  const db = await database();
  const { domains } = await body(req, arfReportersSchema);
  await requireConsent(db);
  return json({ domains: await setTrustedReporters(db, domains) });
});
