import { and, desc, eq } from "drizzle-orm";
import crypto from "node:crypto";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { campaignLeads, campaigns, mailboxes, messages } from "@/lib/db/schema";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { buildScenario } from "@/lib/mail/inbound/fake-inbox";
import { processInbound } from "@/lib/mail/inbound/process";
import { isDemoInboxEnabled } from "@/lib/mail/scheduler/inbox-job";
import { createUnsubscribeToken } from "@/lib/mail/unsubscribe-service";
import { requireConsent } from "../../campaigns/schema";
import { devInboxSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * DEMO gelen kutusu simülatörü (geliştirme ve uçtan uca test). Yalnızca `FAZ3_DEMO_INBOX_ENABLED=1` iken çalışır
 * (varsayılan kapalı: 404). Hiçbir ağ çağrısı yapmaz. Ürettiği tasdik `demo_simulated`'dır — GERÇEK bir sağlayıcı
 * doğrulaması DEĞİLDİR. Yalnızca demo kampanyalarının gerçekten gönderilmiş (demo) iletilerine bağlanır.
 */
export const POST = route(async (req: Request) => {
  if (!isDemoInboxEnabled(process.env)) {
    throw new HttpError(404, "Bulunamadı.", { code: "NOT_FOUND" });
  }
  const db = await database();
  const input = await body(req, devInboxSchema);
  await requireConsent(db);

  const [row] = await db
    .select({ cl: campaignLeads, mailbox: mailboxes })
    .from(campaignLeads)
    .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
    .innerJoin(mailboxes, eq(mailboxes.id, campaigns.mailboxId))
    .where(eq(campaignLeads.id, input.campaignLeadId))
    .limit(1);
  if (!row || policyScopeForMailbox(row.mailbox.provider) !== "demo" || !row.mailbox.address) {
    throw new HttpError(404, "Demo kampanya alıcısı bulunamadı.", { code: "NOT_FOUND" });
  }

  if (input.scenario === "unsubscribe_link") {
    const token = createUnsubscribeToken(row.cl.id);
    return json({ token, path: `/u/${token}` });
  }

  const [out] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.campaignLeadId, row.cl.id),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(1);
  if (!out?.rfcMessageId || !row.cl.recipientEmail) {
    throw new HttpError(409, "Bu alıcıya henüz gönderilmiş bir ileti yok.", {
      code: "NO_SENT_MESSAGE",
    });
  }

  const { raw, attestation } = buildScenario({
    scenario: input.scenario,
    mailboxAddress: row.mailbox.address,
    outboundMessageId: out.rfcMessageId,
    recipient: row.cl.recipientEmail,
    nonce: crypto.randomBytes(8).toString("hex"),
  });
  const r = await processInbound(db, {
    mailboxId: row.mailbox.id,
    raw,
    receivedAt: Date.now(),
    attestation,
  });
  return json(r);
});
