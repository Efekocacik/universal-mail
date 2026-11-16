import { and, eq, isNull } from "drizzle-orm";
import { getSetupState } from "@/lib/app/state";
import { hasBackupPassphrase, lastSuccessfulBackup } from "@/lib/backup/shared";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { mailboxes, messages, scans } from "@/lib/db/schema";
import { getSettings, setSetting } from "@/lib/settings";

/**
 * Faz 6 (sözleşme K.4): gösterge panelindeki "Kurulumu tamamlayın" listesi. Yalnızca OKUYAN sorgular; yanıtta kişisel
 * veri (adres, ad, anahtar) yoktur, yalnızca her adımın yapılıp yapılmadığı ve nereden yapılacağı.
 *
 * Adımlar (sıra sabittir):
 *   1. setup        kurulum sihirbazı tamamlandı (`setup.completed` ve eksik adım yok)
 *   2. dataSource   demo sağlayıcı (tamam, demo) veya Google Places anahtarı kayıtlı
 *   3. firstScan    tamamlanmış (`completed`) en az bir tarama; yalnızca demo taramalar varsa demo
 *   4. mailbox      gönderim izni (gmail.send) verilmiş, bağlı bir GERÇEK Gmail kutusu (demo kutu sayılmaz)
 *   5. testEmail    gönderilmiş (`sent`) bir kendine test e-postası; yalnızca demo kutudan gönderildiyse demo
 *   6. unsubscribe  abonelikten çıkış uç noktası uçtan uca doğrulandı (`verified` dolu)
 *   7. backup       yedek parolası ayarlı ve en az bir başarılı yedek var
 *
 * "Gizle" (`dismiss`) ve "yeniden göster" (`restore`) yalnızca `onboarding.checklist` ayarını yazar; ikisi de
 * idempotenttir ve yalnızca durum değiştiğinde denetim kaydı yazar.
 */

export const ONBOARDING_ITEM_IDS = [
  "setup",
  "dataSource",
  "firstScan",
  "mailbox",
  "testEmail",
  "unsubscribe",
  "backup",
] as const;
export type OnboardingItemId = (typeof ONBOARDING_ITEM_IDS)[number];

/** Her adımın açtığı ekran (uygulama içi göreli yol). */
export const ONBOARDING_HREFS: Record<OnboardingItemId, string> = {
  setup: "/setup",
  dataSource: "/settings#google",
  firstScan: "/scans",
  mailbox: "/settings#mailbox",
  testEmail: "/settings#mailbox",
  unsubscribe: "/settings#unsubscribe",
  backup: "/settings#backup",
};

export interface OnboardingItem {
  id: OnboardingItemId;
  done: boolean;
  href: string;
  /** Adım yalnızca demo moduyla tamamlandı (gerçek kullanım için ayrıca yapılmalı). */
  demo?: boolean;
}

export interface OnboardingChecklist {
  items: OnboardingItem[];
  /** Kart gizlendiyse anı; değilse null. */
  dismissedAt: number | null;
  allDone: boolean;
  done: number;
  total: number;
}

type Status = { done: boolean; demo?: boolean };

/** Tamamlanmış taramaların sağlayıcıları (en çok birkaç farklı değer). */
async function scanStatus(db: Db): Promise<Status> {
  const rows = await db
    .selectDistinct({ provider: scans.provider })
    .from(scans)
    .where(eq(scans.status, "completed"));
  if (rows.length === 0) return { done: false };
  return rows.some((r) => r.provider !== "mock") ? { done: true } : { done: true, demo: true };
}

async function mailboxStatus(db: Db, grants: Record<string, { send: boolean }>): Promise<Status> {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.status, "connected")));
  return { done: rows.some((r) => grants[String(r.id)]?.send === true) };
}

/**
 * Gönderilmiş kendine test e-postaları. `campaign_id IS NULL AND status='sent'` koşulu `messages_campaign_idx`
 * indeksini kullanır (büyük ileti tablosunda tam tarama yapılmaz); gelen iletiler `sent` olamadığından bu küme yalnızca
 * kampanya dışı giden iletilerdir, `purpose='test'` ile kesinleşir.
 */
async function testEmailStatus(db: Db): Promise<Status> {
  const rows = await db
    .selectDistinct({ provider: mailboxes.provider })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(isNull(messages.campaignId), eq(messages.status, "sent"), eq(messages.purpose, "test")),
    );
  if (rows.length === 0) return { done: false };
  return rows.some((r) => r.provider !== "demo") ? { done: true } : { done: true, demo: true };
}

export async function getOnboardingChecklist(db: Db): Promise<OnboardingChecklist> {
  const s = await getSettings(db, [
    "onboarding.checklist",
    "mail.gmailGrants",
    "mail.unsubscribeEndpoint",
  ] as const);
  const [setup, firstScan, mailbox, testEmail, passphrase, lastBackup] = await Promise.all([
    getSetupState(db),
    scanStatus(db),
    mailboxStatus(db, s["mail.gmailGrants"]),
    testEmailStatus(db),
    hasBackupPassphrase(),
    lastSuccessfulBackup(db),
  ]);
  const status: Record<OnboardingItemId, Status> = {
    setup: { done: setup.completed },
    dataSource:
      setup.provider === "mock" ? { done: true, demo: true } : { done: setup.placesKeySet },
    firstScan,
    mailbox,
    testEmail,
    unsubscribe: { done: s["mail.unsubscribeEndpoint"].verified !== null },
    backup: { done: passphrase && lastBackup !== null },
  };
  const items = ONBOARDING_ITEM_IDS.map((id): OnboardingItem => {
    const st = status[id];
    return {
      id,
      done: st.done,
      href: ONBOARDING_HREFS[id],
      ...(st.done && st.demo ? { demo: true } : {}),
    };
  });
  const done = items.filter((i) => i.done).length;
  return {
    items,
    dismissedAt: s["onboarding.checklist"].dismissedAt,
    allDone: done === items.length,
    done,
    total: items.length,
  };
}

/** Kartı gizler. Zaten gizliyse ilk gizlenme anı korunur ve denetim kaydı yazılmaz. */
export async function dismissOnboarding(
  db: Db,
  now: number = Date.now(),
): Promise<{ dismissedAt: number; changed: boolean }> {
  return db.transaction(async (tx) => {
    const cur = (await getSettings(tx, ["onboarding.checklist"] as const))["onboarding.checklist"];
    if (cur.dismissedAt !== null) return { dismissedAt: cur.dismissedAt, changed: false };
    await setSetting(tx, "onboarding.checklist", { dismissedAt: now });
    await audit(tx, "onboarding.dismiss", "settings", "onboarding.checklist", undefined, now);
    return { dismissedAt: now, changed: true };
  });
}

/** Kartı yeniden gösterir. Zaten görünürse hiçbir şey yazılmaz. */
export async function restoreOnboarding(
  db: Db,
  now: number = Date.now(),
): Promise<{ dismissedAt: null; changed: boolean }> {
  return db.transaction(async (tx) => {
    const cur = (await getSettings(tx, ["onboarding.checklist"] as const))["onboarding.checklist"];
    if (cur.dismissedAt === null) return { dismissedAt: null, changed: false };
    await setSetting(tx, "onboarding.checklist", { dismissedAt: null });
    await audit(
      tx,
      "onboarding.restore",
      "settings",
      "onboarding.checklist",
      { hiddenAt: cur.dismissedAt },
      now,
    );
    return { dismissedAt: null, changed: true };
  });
}
