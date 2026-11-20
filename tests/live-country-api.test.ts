import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/compliance/live-country/route";
import { updateRecipientRestriction } from "@/lib/compliance/recipient-restriction";
import { trackTransactions, type Db } from "@/lib/db/client";
import { auditLog, countryPolicies, mailboxes, messages, settings } from "@/lib/db/schema";
import { t, type TrKey } from "@/lib/i18n";
import {
  resetNativeConfirmForTests,
  setNativeConfirmChannelForTests,
  type IpcChannel,
} from "@/lib/native-confirm";
import { setSetting } from "@/lib/settings";
import { createNativeConfirmHandler } from "../electron/native-confirm";
import { openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

/**
 * /api/compliance/live-country: strict şema, onay (consent) şartı ve SUNUCU ↔ ANA SÜREÇ zinciri uçtan uca. Ana süreç,
 * gerçek `createNativeConfirmHandler` ve sahte pencereyle taklit edilir; sunucu tarafı gerçek `process` kanalını kullanır
 * (enjekte edilen sahte kanal; gerçek `process.send` ASLA değiştirilmez: vitest çalışanı onu kendi IPC kanalı olarak kullanır).
 * Yerel onay kanalı OLMADAN aktivasyon yapılamaz.
 */

const rd = vi.hoisted(() => ({ failing: new Set<string>() }));
vi.mock("@/lib/compliance/live-readiness", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/compliance/live-readiness")>();
  const keys = [
    "live_flag",
    "consent",
    "company_profile",
    "real_mailbox",
    "dns_auth",
    "https_unsubscribe",
    "event_delivery",
    "legal_live_countries",
  ];
  return {
    ...orig,
    getLiveReadiness: async () => ({
      items: keys.map((key) => ({
        key,
        status: rd.failing.has(key) ? "blocked" : "ok",
        owner: "software",
      })),
      allOk: true,
      liveSendingEnabled: true,
      blockedCount: 0,
      unknownCount: 0,
    }),
  };
});

const DAY = 86_400_000;
const HANDLE = "__umDbHandle";
const ORIGIN = "http://127.0.0.1:3000";
let client: Client;
let db: Db;
let dir: string;
let savedDataDir: string | undefined;

const body = () => ({
  action: "activate",
  countries: ["GB"],
  mode: "generic_only",
  representativeName: "Ayşe Yetkili",
  representativeTitle: "Genel Müdür",
  operatorName: "Test Operatör",
  documentRef: "HUK-2026-014",
  documentDate: new Date().toISOString().slice(0, 10),
  documentSha256: null,
  scopeAttested: true,
});
const post = (b: unknown) =>
  route.POST(
    new Request(`${ORIGIN}/api/compliance/live-country`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
      body: JSON.stringify(b),
    }),
    undefined as never,
  );
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const gb = async () =>
  (
    await db
      .select()
      .from(countryPolicies)
      .where(and(eq(countryPolicies.scope, "live"), eq(countryPolicies.countryCode, "GB")))
  )[0]!;

/** Ana süreci taklit eder: istekleri gerçek işleyiciye verir, pencere sonucunu `dialog` belirler. */
function installFakeMain(dialog: () => { response: number; checkboxChecked: boolean } | "hang") {
  const sent: unknown[] = [];
  const handler = createNativeConfirmHandler({
    tl: (k, p) => t(k as TrKey, p, "tr"),
    getParent: () => ({}),
    showMessageBox: (_p, _spec, signal) =>
      new Promise((resolve) => {
        const r = dialog();
        if (r !== "hang") resolve(r);
        signal.addEventListener("abort", () => resolve({ response: 0, checkboxChecked: false }));
      }),
  });
  // Sunucu ↔ ana süreç kanalının sahtesi: sunucu `send` eder, ana süreç işleyicisi yanıtı `message` olarak döndürür.
  const channel = Object.assign(new EventEmitter(), {
    connected: true,
    send: (m: unknown) => {
      sent.push(m);
      handler.handle(m, (r) => setImmediate(() => channel.emit("message", r)));
      return true;
    },
  });
  setNativeConfirmChannelForTests(channel as unknown as IpcChannel);
  return sent;
}
/** Yerel onay kanalı YOK (tarayıcı, betik, yetkisiz yerel HTTP). */
function removeChannel() {
  setNativeConfirmChannelForTests(null);
}

beforeEach(async () => {
  savedDataDir = process.env.UM_DATA_DIR;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-act-api-"));
  process.env.UM_DATA_DIR = dir;
  rd.failing.clear();
  resetNativeConfirmForTests();
  ({ client, db } = await openMemoryDb());
  trackTransactions(client);
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test Operatör" });
  const id = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  await db
    .update(mailboxes)
    .set({ connectedAt: Date.now() - 2 * DAY })
    .where(eq(mailboxes.id, id));
  await setSetting(db, "mail.gmailGrants", { [String(id)]: { send: true, read: false, at: T0 } });
  await db.insert(messages).values({
    direction: "out",
    purpose: "test",
    mailboxId: id,
    fromAddress: "satis@firma-ornek.com",
    toAddress: "satis@firma-ornek.com",
    peerHash: "h",
    peerDomain: "d",
    status: "sent",
    createdAt: Date.now() - DAY,
    sentAt: Date.now() - DAY,
  });
  await updateRecipientRestriction(
    db,
    { enabled: true, addresses: ["info@izinli-test.example"], ackLoosening: true },
    { now: Date.now() },
  );
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows dosya kilidi: geçici klasör */
  }
  if (savedDataDir === undefined) delete process.env.UM_DATA_DIR;
  else process.env.UM_DATA_DIR = savedDataDir;
  resetNativeConfirmForTests();
});

describe("/api/compliance/live-country", () => {
  it("GET: yerel onay kanalı yoksa nativeConfirmAvailable false; ön koşullar ve ülkeler döner", async () => {
    removeChannel();
    const r = await route.GET(
      new Request(`${ORIGIN}/api/compliance/live-country`),
      undefined as never,
    );
    expect(r.status).toBe(200);
    const j = await json(r);
    expect(j.nativeConfirmAvailable).toBe(false);
    expect(j.prerequisites.ok).toBe(true);
    expect(j.countries.find((c: { countryCode: string }) => c.countryCode === "GB")).toMatchObject({
      mode: "blocked",
      locked: true,
    });
  });

  it("katı şema: bilinmeyen alan, eksik eylem ve geçersiz tür 400; hiçbir şey değişmez", async () => {
    removeChannel();
    for (const b of [
      { ...body(), extra: 1 },
      { ...body(), action: "unlock" },
      { ...body(), countries: [] },
      { ...body(), mode: "blocked" },
      { action: "revoke", countries: ["GB"] },
    ])
      expect((await post(b)).status, JSON.stringify(b).slice(0, 40)).toBe(400);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("kurulum onayı (consent) yoksa reddedilir", async () => {
    await db.delete(settings).where(eq(settings.key, "consent"));
    removeChannel();
    expect((await post(body())).status).toBeGreaterThanOrEqual(400);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("YEREL ONAY KANALI YOKKEN (tarayıcı, betik, yetkisiz yerel HTTP) aktivasyon 503 ile reddedilir; ülke kilitli kalır", async () => {
    removeChannel();
    const r = await post(body());
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe("CONFIRM_UNAVAILABLE");
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true, approvedBy: null });
    expect(
      (await db.select().from(auditLog)).filter((a) => a.action === "country_policy.live_approved"),
    ).toHaveLength(0);
  });

  it("plan hiçbir şey yazmaz ve yerel onay istemez", async () => {
    const sent = installFakeMain(() => ({ response: 1, checkboxChecked: true }));
    const r = await post({ ...body(), action: "plan" });
    expect(r.status).toBe(200);
    const j = await json(r);
    expect(j.ready).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("UÇTAN UCA: ana süreç penceresi İPTAL ederse 409 CONFIRM_DECLINED, ülke kilitli", async () => {
    installFakeMain(() => ({ response: 0, checkboxChecked: true }));
    const r = await post(body());
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe("CONFIRM_DECLINED");
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("UÇTAN UCA: 'okudum' kutusu işaretlenmeden verilen onay geçersizdir", async () => {
    installFakeMain(() => ({ response: 1, checkboxChecked: false }));
    expect((await post(body())).status).toBe(409);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("UÇTAN UCA: pencere onaylanırsa ülke açılır; ardından geri alınır (ack ile)", async () => {
    const sent = installFakeMain(() => ({ response: 1, checkboxChecked: true }));
    const r = await post(body());
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ activated: ["GB"] });
    expect(sent).toHaveLength(1);
    expect(await gb()).toMatchObject({ mode: "generic_only", locked: false });

    expect((await post({ action: "revoke", countries: ["GB"], ack: false })).status).toBe(400);
    expect((await gb()).locked).toBe(false);
    const rev = await post({ action: "revoke", countries: ["GB"], ack: true });
    expect(rev.status).toBe(200);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true, approvedBy: null });
  });

  it("zaman aşımı: ana süreç yanıtlamazsa (pencere asılı) iptal edilir ve hiçbir şey yazılmaz", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      installFakeMain(() => "hang");
      const p = post(body());
      await vi.advanceTimersByTimeAsync(130_000);
      const r = await p;
      expect(r.status).toBe(409);
      expect(["CONFIRM_TIMEOUT", "CONFIRM_DECLINED"]).toContain((await json(r)).code);
      expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("test modu kapalıyken (ilk aktivasyon) 409 ACTIVATION_TEST_MODE; yerel pencere hiç açılmaz", async () => {
    await updateRecipientRestriction(
      db,
      { enabled: false, addresses: ["info@izinli-test.example"], ackLoosening: true },
      { now: Date.now() },
    );
    const sent = installFakeMain(() => ({ response: 1, checkboxChecked: true }));
    const r = await post(body());
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe("ACTIVATION_TEST_MODE");
    expect(sent).toHaveLength(0);
    expect(await gb()).toMatchObject({ mode: "blocked", locked: true });
  });

  it("hukuki kayıt eksikse 400 ACTIVATION_LEGAL; pencere açılmaz", async () => {
    const sent = installFakeMain(() => ({ response: 1, checkboxChecked: true }));
    const r = await post({ ...body(), documentRef: "" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("ACTIVATION_LEGAL");
    expect(sent).toHaveLength(0);
  });
});
