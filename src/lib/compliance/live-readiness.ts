import { and, eq, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { countryPolicies, mailboxes } from "@/lib/db/schema";
import { getSetting, settingSchemas } from "@/lib/settings";
import { LEGAL_APPROVALS, type LegalApprovalKey } from "./legal-status";
import { LIVE_SENDING_ENABLED, policyScopeForMailbox } from "./policies";

/**
 * "Canlı gönderime hazırlık" (Aşama 14). SALT OKUNUR: gerçek gönderimin neden hâlâ kapalı olduğunu gösterir ve
 * kapıyı ASLA açmaz. Hiçbir madde varsayımla "tamam" olmaz: durum yalnızca gerçek kayda/koda bakılarak hesaplanır;
 * ölçülemeyen madde `unknown` (doğrulanmadı) olarak kalır. Hukuki onaylar `LEGAL_APPROVALS` sabitlerindendir ve
 * kullanıcı beyanıyla değişmez.
 */

export type ReadinessStatus = "ok" | "blocked" | "unknown";

export type ReadinessKey =
  | "live_flag"
  | "consent"
  | "company_profile"
  | "real_mailbox"
  | "inbox_access"
  | "dns_auth"
  | "https_unsubscribe"
  | "live_country_policies"
  | "legal_lia"
  | "legal_uyum"
  | "legal_live_countries"
  | "legal_erasure_records"
  | "legal_suppression_hash"
  | "legal_tr_identifiers"
  | "pilot";

export interface ReadinessItem {
  key: ReadinessKey;
  status: ReadinessStatus;
  /** Bu maddeyi kapatabilecek taraf: yazılım, şirket, hukuk veya dış servis. */
  owner: "software" | "company" | "legal" | "external";
}

export interface LiveReadiness {
  items: ReadinessItem[];
  /** Hepsi `ok` mu? Yine de gerçek gönderim bu ekrandan AÇILMAZ. */
  allOk: boolean;
  liveSendingEnabled: boolean;
  blockedCount: number;
  unknownCount: number;
}

const legal = (key: ReadinessKey, flag: LegalApprovalKey): ReadinessItem => ({
  key,
  status: LEGAL_APPROVALS[flag] ? "ok" : "blocked",
  owner: "legal",
});

export async function getLiveReadiness(db: DbExecutor): Promise<LiveReadiness> {
  const consent = await getSetting(db, "consent");
  const profile = settingSchemas["company.profile"]
    .unwrap()
    .safeParse(await getSetting(db, "company.profile"));

  const boxes = await db.select().from(mailboxes);
  const realConnected = boxes.filter(
    (m) => policyScopeForMailbox(m.provider) === "live" && m.status === "connected",
  );

  // Gelen kutusu okuma izni (bounce/yanıt koruması için): bağlı bir gerçek kutuda gmail.readonly verilmiş olmalı.
  const grants = await getSetting(db, "mail.gmailGrants");
  const inboxOk = realConnected.some((m) => grants[String(m.id)]?.read === true);

  const [nonBlockedLive] = await db
    .select({ n: sql<number>`count(*)` })
    .from(countryPolicies)
    .where(and(eq(countryPolicies.scope, "live"), ne(countryPolicies.mode, "blocked")));

  const items: ReadinessItem[] = [
    { key: "live_flag", status: LIVE_SENDING_ENABLED ? "ok" : "blocked", owner: "software" },
    { key: "consent", status: consent ? "ok" : "blocked", owner: "company" },
    { key: "company_profile", status: profile.success ? "ok" : "blocked", owner: "company" },
    { key: "real_mailbox", status: realConnected.length > 0 ? "ok" : "blocked", owner: "external" },
    // Alan adı denetimi yalnızca gerçek posta kutusu varken ve kullanıcı istediğinde yapılır; sonucu saklanmaz.
    { key: "inbox_access", status: inboxOk ? "ok" : "blocked", owner: "external" },
    { key: "dns_auth", status: "unknown", owner: "external" },
    {
      key: "https_unsubscribe",
      status: LEGAL_APPROVALS.httpsUnsubscribeEndpoint ? "ok" : "blocked",
      owner: "external",
    },
    {
      key: "live_country_policies",
      status: Number(nonBlockedLive?.n ?? 0) > 0 ? "ok" : "blocked",
      owner: "legal",
    },
    legal("legal_lia", "lia"),
    legal("legal_uyum", "uyum"),
    legal("legal_live_countries", "liveCountryPolicies"),
    legal("legal_erasure_records", "erasureOfTransmissionRecords"),
    legal("legal_suppression_hash", "suppressionHashRetention"),
    legal("legal_tr_identifiers", "trSenderIdentifierRules"),
    // Pilot (günde ≤ 20, ilk hafta) başlamadı; ölçülemez.
    { key: "pilot", status: "unknown", owner: "company" },
  ];
  return {
    items,
    allOk: items.every((i) => i.status === "ok"),
    liveSendingEnabled: LIVE_SENDING_ENABLED,
    blockedCount: items.filter((i) => i.status === "blocked").length,
    unknownCount: items.filter((i) => i.status === "unknown").length,
  };
}
