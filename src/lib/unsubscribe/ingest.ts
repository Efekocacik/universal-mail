import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { checkSuppression, suppressEmailInTx } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, messages } from "@/lib/db/schema";
import { stopSequences } from "@/lib/mail/inbound/stop";
import { getSetting, setSetting } from "@/lib/settings";
import { loadPublicKeys, loadRevokedPublicKeys, recipientTag, tagsEqual } from "./keys";
import { MAX_TOKEN_LENGTH, MAX_TTL_MS, verifyToken } from "./token";

/**
 * Abonelikten çıkış olaylarını uygulamaya işleme (Aşama 15.6) — uygulama tarafı, aktarıcıya GÜVENMEZ.
 *
 * Aktarıcı (relay) yalnızca imzayı denetleyip olayı kuyruğa koyar. Uygulama olayı yeniden doğrular:
 *  1. Olay biçimi (katı şema) ve olay zamanı (ileri sapma ve aşırı eski değil).
 *  2. Belirteç: Ed25519 imzası uygulamanın genel anahtarlarıyla, süre TIKLAMA ANINA göre (aktarıcının aldığı an).
 *  3. Kapsam ve bağ: kampanya alıcısı var ve (varsa) ileti o alıcının giden kampanya iletisi; aksi reddedilir.
 *     Alıcı etiketi (ana anahtardan türetilen gizli anahtarlı HMAC) kaydın GÜNCEL alıcısıyla eşleşmezse olay
 *     REDDEDİLMEZ (bkz. `ingestUnsubscribeEvent` içindeki not): çıkış, imzalı belirtecin gösterdiği kampanya alıcısına
 *     uygulanır ve uyuşmazlık ayrıca denetime yazılır.
 *  4. Tekrar oynatma: `jti` başına tek satır (`messages` gelen ileti kaydı, benzersiz dizin) → tam bir kez işlenir;
 *     tekrar gelen olay "duplicate" döner, ikinci suppression/denetim kaydı OLUŞMAZ.
 *  5. Etki: mevcut suppression sistemiyle (`unsubscribe`, kaynak `link`; mevcut kaydı yalnızca güçlendirir), aynı
 *     alıcının bekleyen dizileri durur, denetim kaydı yazılır (adres ve belirteç yazılmaz).
 *
 * DÜRÜSTLÜK / GÜVENLİK NOTU: Çıkış, kısıtlayıcı (güvenli) yöndedir. Ele geçirilmiş bir aktarıcı geçerli imzalı olayları
 * geriye tarihleyebilir veya yeniden iletebilir; bu, yalnızca o belirteçlerin zaten çıkarmak istediği alıcıyı çıkarır.
 * Aktarıcının olayları geciktirmesi/atması (erişilebilirlik) bu katmanla ÇÖZÜLMEZ (bkz. docs/09).
 */

export const MAX_EVENT_AGE_MS = MAX_TTL_MS + 86_400_000;

const eventSchema = z
  .object({
    v: z.literal(1),
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    receivedAt: z.number().int().positive(),
    via: z.literal("one_click"),
  })
  .strict();

export type RejectReason =
  | "invalid_event"
  | "invalid_token"
  | "unknown_key"
  | "expired"
  | "not_yet_valid"
  | "lead_not_found"
  | "no_mailbox"
  | "message_mismatch";

export type IngestOutcome =
  /** Uç nokta sınama belirteci (kapsam "p"): yalnızca uç nokta doğrulamasını etkiler; hiçbir alıcı/engel etkilenmez. */
  | { outcome: "probe"; verified: boolean }
  | { outcome: "unsubscribed"; stopped: number; suppression: "added" | "strengthened" | "existing" }
  /** Alıcı silinmiş (adres yok) veya zaten engelli ve durdurulacak dizi yok. */
  | { outcome: "already" }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: RejectReason };

/**
 * Sınama belirteci: yalnızca bekleyen sınamayla (aynı jti, aynı anahtar, süresi dolmamış) eşleşirse uç noktayı
 * "doğrulanmış" yazar ve bekleyeni tüketir (ikinci teslimat etkisizdir). Hiçbir alıcıya/engele dokunmaz.
 */
async function recordProbe(
  db: Db,
  claims: { j: string; k: string },
  at: number,
  now: number,
): Promise<IngestOutcome> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  const p = cfg.pending;
  if (
    !p ||
    p.jti !== claims.j ||
    p.kid !== claims.k ||
    p.baseUrl !== cfg.baseUrl ||
    now - p.issuedAt > PROBE_MAX_AGE_MS
  ) {
    return { outcome: "probe", verified: false };
  }
  await setSetting(db, "mail.unsubscribeEndpoint", {
    ...cfg,
    pending: null,
    verified: { baseUrl: p.baseUrl, kid: p.kid, jti: p.jti, verifiedAt: at },
  });
  await audit(db, "unsubscribe.endpoint_verified", "unsubscribe_endpoint", p.kid, undefined, now);
  return { outcome: "probe", verified: true };
}

export const PROBE_MAX_AGE_MS = 15 * 60_000;

const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(
    String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? ""),
  );

export async function ingestUnsubscribeEvent(
  db: Db,
  rawEvent: unknown,
  opts: { now?: number } = {},
): Promise<IngestOutcome> {
  const now = opts.now ?? Date.now();
  const parsedEvent = eventSchema.safeParse(rawEvent);
  if (!parsedEvent.success) return { outcome: "rejected", reason: "invalid_event" };
  const event = parsedEvent.data;
  // Aktarıcının saati yalnızca bilgilendiricidir: ileri görünüyorsa İŞLEME ANINA kırpılır (saat sapması yüzünden
  // geçerli bir çıkış isteği reddedilip kuyruktan SİLİNMESİN). Çok eski olay zaten süresi dolmuş belirteç olarak reddedilir.
  const at = Math.min(event.receivedAt, now);

  const keys = await loadPublicKeys(db);
  let verdict = verifyToken(event.token, keys, at);
  let viaRevokedKey = false;
  if (!verdict.ok && verdict.reason === "unknown_key") {
    // İptal edilmiş anahtar: aktarıcı tıklamayı İPTALDEN ÖNCE aldıysa (receivedAt < revokedAt) çıkış yine uygulanır.
    // Etki yalnızca kısıtlayıcıdır (alıcı çıkarılır); sızmış anahtarla sahte olay üretilse bile gönderim açılamaz.
    // İptal anında veya sonrasında alınan olaylar ve SINAMA belirteçleri reddedilmeye devam eder.
    const revoked = (await loadRevokedPublicKeys(db)).filter((k) => k.revokedAt > at);
    if (revoked.length > 0) {
      const retry = verifyToken(
        event.token,
        revoked.map((k) => ({ kid: k.kid, x: k.x })),
        at,
      );
      if (retry.ok && retry.claims.s !== "p") {
        verdict = retry;
        viaRevokedKey = true;
      }
    }
  }
  if (!verdict.ok) {
    const reason: RejectReason =
      verdict.reason === "expired"
        ? "expired"
        : verdict.reason === "not_yet_valid"
          ? "not_yet_valid"
          : verdict.reason === "unknown_key"
            ? "unknown_key"
            : "invalid_token";
    return { outcome: "rejected", reason };
  }
  const claims = verdict.claims;
  if (claims.s === "p") return recordProbe(db, claims, at, now);

  try {
    return await db.transaction(async (tx): Promise<IngestOutcome> => {
      const [row] = await tx
        .select({ cl: campaignLeads, mailboxId: campaigns.mailboxId })
        .from(campaignLeads)
        .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
        .where(eq(campaignLeads.id, claims.c))
        .limit(1);
      if (!row) return { outcome: "rejected", reason: "lead_not_found" };
      const { cl } = row;

      let mailboxId = row.mailboxId;
      let messagePeerHash: string | null = null;
      if (claims.m !== null) {
        const [m] = await tx
          .select({
            direction: messages.direction,
            purpose: messages.purpose,
            campaignLeadId: messages.campaignLeadId,
            mailboxId: messages.mailboxId,
            peerHash: messages.peerHash,
          })
          .from(messages)
          .where(eq(messages.id, claims.m))
          .limit(1);
        if (!m || m.direction !== "out" || m.purpose !== "campaign" || m.campaignLeadId !== cl.id) {
          await audit(
            tx,
            "unsubscribe.rejected",
            "campaign_lead",
            cl.id,
            { reason: "message_mismatch", kid: claims.k },
            now,
          );
          return { outcome: "rejected", reason: "message_mismatch" };
        }
        mailboxId = m.mailboxId ?? mailboxId;
        messagePeerHash = m.peerHash;
      }

      // Alıcı silinmişse (adres ve özet boşaltılmış) yapılacak bir şey yok; engel silme kaydında zaten var.
      if (!cl.recipientEmail || !cl.recipientHash) return { outcome: "already" };

      // Alıcı etiketi uyuşmazlığı (C5): imza ve anahtar kimliği GEÇERLİ olduğuna göre belirteci yalnızca bizim
      // gönderimlerimiz taşıyabilir. Etiket anahtarı ana anahtardan türetildiği için en olası neden ana anahtarın
      // değişmesidir (anahtarlık sıfırlandı/uygulama yeniden kuruldu); kampanya alıcısının adresi kayıt anında sabitlenir
      // ve yalnızca silmede boşaltılır (yukarıda). Eskiden olay reddedilip kuyruktan onaylanıyordu ve çıkış isteği KALICI
      // olarak kayboluyordu. Artık çıkış, imzalı belirtecin gösterdiği kampanya alıcısının GÜNCEL alıcısına uygulanır
      // (kısıtlayıcı/güvenli yön) ve uyuşmazlık ayrı bir denetim kaydıyla izlenir (adres veya belirteç yazılmaz).
      const tagMismatch = !tagsEqual(claims.r, recipientTag(cl.recipientHash));

      // Gelen ileti kaydı bir posta kutusuna bağlanır; kutusuz kampanya hiç gönderim yapmamıştır.
      if (mailboxId === null) return { outcome: "rejected", reason: "no_mailbox" };

      // Tekrar oynatma / tekilleştirme: jti başına tek gelen ileti kaydı (benzersiz dizin).
      const syntheticId = `<unsub-${claims.j}@unsubscribe.invalid>`;
      const [prev] = await tx
        .select({ id: messages.id, receivedAt: messages.receivedAt })
        .from(messages)
        .where(and(eq(messages.rfcMessageId, syntheticId), eq(messages.direction, "in")))
        .limit(1);
      let reclick = false;
      let existingId: number | null = null;
      if (prev) {
        // Aynı (veya daha eski) tıklama zamanı = tekrar oynatma/yinelenen teslimat: etki YOK.
        if (prev.receivedAt === null || at <= prev.receivedAt) return { outcome: "duplicate" };
        // Daha SONRAKİ bir tıklama: alıcı eski bir iletideki bağlantıya yeniden bastı. Arada engeli kaldırılmışsa
        // (belgelenmiş alıcı talebiyle) bu yeni bir çıkış iradesidir ve YOK SAYILMAZ; hâlâ engelliyse etki gerekmez.
        await tx.update(messages).set({ receivedAt: at }).where(eq(messages.id, prev.id));
        if ((await checkSuppression(tx, cl.recipientEmail)).suppressed)
          return { outcome: "already" };
        reclick = true;
        existingId = prev.id;
      }

      // İlk teslimat: önce kayıt yazılır; çakışırsa (yarış) işlem geri alınır ve hiçbir etki uygulanmaz.
      const [inbound] =
        existingId !== null
          ? [{ id: existingId }]
          : await tx
              .insert(messages)
              .values({
                direction: "in",
                purpose: "inbound",
                campaignId: cl.campaignId,
                campaignLeadId: cl.id,
                leadId: cl.leadId,
                mailboxId,
                rfcMessageId: syntheticId,
                peerHash: cl.recipientHash,
                peerDomain: cl.recipientDomain ?? "unknown.invalid",
                bodySha256: crypto.createHash("sha256").update(claims.j).digest("hex"),
                status: "matched",
                classification: "unsubscribe",
                createdAt: now,
                receivedAt: at,
              })
              .returning({ id: messages.id });
      const inboundId = inbound!.id;

      if (tagMismatch) {
        await audit(
          tx,
          "unsubscribe.recipient_tag_mismatch",
          "campaign_lead",
          cl.id,
          {
            kid: claims.k,
            applied: true,
            // İleti bağı varsa: giden iletinin alıcı özeti kaydın güncel alıcısıyla aynı mı (ek kanıt; adres değil).
            messagePeerMatch:
              messagePeerHash === null ? null : messagePeerHash === cl.recipientHash,
          },
          now,
        );
      }

      const res = await suppressEmailInTx(
        tx,
        { email: cl.recipientEmail, reason: "unsubscribe", source: "link", messageId: inboundId },
        now,
      );
      // 15.10-2: süren diziler durur (`stop_reason='unsubscribe'`); bitmiş diziler durumunu korur (TB-10).
      const stop = await stopSequences(tx, { recipientHash: cl.recipientHash }, "unsubscribe", now);
      const stopped = stop.stopped;
      await audit(
        tx,
        "unsubscribe.one_click",
        "message",
        inboundId,
        {
          suppression: res.outcome,
          stopped: stopped.length,
          ...(stop.annotated.length > 0 ? { annotated: stop.annotated.length } : {}),
          via: event.via,
          kid: claims.k,
          ...(reclick ? { reclick: true } : {}),
          ...(tagMismatch ? { recipientTagMismatch: true } : {}),
          ...(viaRevokedKey ? { viaRevokedKey: true } : {}),
        },
        now,
      );
      if (viaRevokedKey) {
        await audit(
          tx,
          "unsubscribe.revoked_key_accepted",
          "unsubscribe_key",
          claims.k,
          undefined,
          now,
        );
      }
      if (res.outcome === "existing" && stopped.length === 0 && stop.annotated.length === 0)
        return { outcome: "already" };
      return { outcome: "unsubscribed", stopped: stopped.length, suppression: res.outcome };
    });
  } catch (e) {
    if (isUnique(e)) return { outcome: "duplicate" };
    throw e;
  }
}

/* ---------------------------------------------------------------------------------------------- */

export interface UnsubscribeEventSource {
  pull(limit: number): Promise<{ id: string; event: unknown }[]>;
  ack(ids: string[]): Promise<void>;
}

export interface DrainSummary {
  pulled: number;
  unsubscribed: number;
  already: number;
  duplicates: number;
  /** Uç nokta sınama olayları (alıcıya/engele dokunmaz). */
  probes: number;
  rejected: number;
  /** Altyapı hatası (ör. veritabanı) olduysa güvenli kod; işlenmeyen olaylar onaylanmadan kalır ve tekrar çekilir. */
  error: string | null;
}

/**
 * Kuyruktaki olayları işler. Bir olay ancak İŞLENDİKTEN (kabul, tekrar veya KALICI ret) sonra onaylanır; altyapı hatası
 * olursa o ve sonrakiler onaylanmaz, bir sonraki turda yeniden çekilir (tekilleştirme sayesinde çift etki yok).
 */
export async function drainUnsubscribeEvents(
  db: Db,
  source: UnsubscribeEventSource,
  opts: { now?: () => number; batch?: number; maxBatches?: number } = {},
): Promise<DrainSummary> {
  const clock = opts.now ?? Date.now;
  const batch = Math.min(Math.max(opts.batch ?? 100, 1), 500);
  const s: DrainSummary = {
    pulled: 0,
    unsubscribed: 0,
    already: 0,
    duplicates: 0,
    probes: 0,
    rejected: 0,
    error: null,
  };
  for (let n = 0; n < (opts.maxBatches ?? 20); n++) {
    const items = await source.pull(batch);
    if (items.length === 0) break;
    s.pulled += items.length;
    const done: string[] = [];
    let failed = false;
    for (const it of items) {
      try {
        const r = await ingestUnsubscribeEvent(db, it.event, { now: clock() });
        if (r.outcome === "rejected") {
          // Kalıcı ret: olay onaylanıp kuyruktan çıkar; sessiz kayıp OLMASIN diye neden (kişisel veri yok) denetime yazılır.
          await audit(
            db,
            "unsubscribe.event_rejected",
            "unsubscribe_event",
            it.id,
            { reason: r.reason },
            clock(),
          );
        }
        if (r.outcome === "unsubscribed") s.unsubscribed++;
        else if (r.outcome === "already") s.already++;
        else if (r.outcome === "duplicate") s.duplicates++;
        else if (r.outcome === "probe") s.probes++;
        else s.rejected++;
        done.push(it.id);
      } catch {
        s.error = "ingest_failed";
        failed = true;
        break;
      }
    }
    if (done.length > 0) await source.ack(done);
    if (failed) break;
  }
  return s;
}
