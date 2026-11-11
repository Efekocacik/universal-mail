import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gmailClientRoute from "@/app/api/mailboxes/gmail-client/route";
import * as mailboxIdRoute from "@/app/api/mailboxes/[id]/route";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import * as secretsRoute from "@/app/api/secrets/route";
import { createCampaign as createCampaignService } from "@/lib/campaigns/service";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import type { Db } from "@/lib/db/client";
import { auditLog, campaigns, mailboxes, settings } from "@/lib/db/schema";
import {
  createGmailMailbox,
  deleteMailbox,
  getGmailClientStatus,
  MailboxServiceError,
  setGmailClient,
} from "@/lib/mail/mailbox-service";
import {
  deleteSecret,
  getSecret,
  mailboxRefreshTokenName,
  OAUTH_CLIENT_SECRET,
  secretExists,
  SECRET_NAMES,
  setSecret,
} from "@/lib/secrets/store";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { seedSent } from "./helpers/inbound-fixture";

/**
 * Posta kutusu yapılandırması ve gizli bilgi adları (Aşama 15.2). Bellek içi veritabanı; gizli depo geçici klasörde;
 * gerçek `.data` açılmaz ve HİÇBİR dış ağ isteği atılmaz (fetch casusla doğrulanır).
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const SECRET = "GOCSPX-supersecretvalue-1234567890";

let client: Client;
let db: Db;
let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-mbx-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // hiçbir test dış ağa çıkmaz
  fetchSpy.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Json = Record<string, unknown>;
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json; text: string }> {
  const r = await res;
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as Json, text };
}
const kind = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as MailboxServiceError).kind;
const rows = () => db.select().from(mailboxes);

describe("gizli bilgi adları", () => {
  it("kutu başına belirteç adı yalnızca geçerli tamsayı kimlikle üretilir", () => {
    expect(mailboxRefreshTokenName(7)).toBe("gmail.refreshToken.7");
    for (const bad of [0, -1, 1.5, Number.NaN, 1e10]) {
      expect(() => mailboxRefreshTokenName(bad), String(bad)).toThrow();
    }
  });

  it("bilinmeyen veya biçimsiz adlar yazılamaz; bilinen adlar şifreli yazılır/okunur/silinir", async () => {
    await expect(setSecret("gmail.refreshToken.07" as never, "x".repeat(20))).rejects.toThrow();
    await expect(setSecret("gmail.refreshToken.1/../x" as never, "x".repeat(20))).rejects.toThrow();
    await expect(setSecret("baska.ad" as never, "x".repeat(20))).rejects.toThrow();
    await expect(deleteSecret("baska.ad" as never)).rejects.toThrow();

    const name = mailboxRefreshTokenName(3);
    await setSecret(name, "refresh-token-value-123");
    expect(await secretExists(name)).toBe(true);
    expect(await getSecret(name)).toBe("refresh-token-value-123");
    const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(raw).not.toContain("refresh-token-value-123"); // düz metin yok
    await deleteSecret(name);
    expect(await secretExists(name)).toBe(false);
  });

  it("OAuth istemci sırrı genel /api/secrets listesinde yoktur ve o uçla yazılamaz", async () => {
    expect((SECRET_NAMES as readonly string[]).includes(OAUTH_CLIENT_SECRET)).toBe(false);
    const res = await call(
      secretsRoute.POST(
        req("POST", "/api/secrets", { name: OAUTH_CLIENT_SECRET, value: SECRET }),
        undefined,
      ),
    );
    expect(res.status).toBe(400);
    expect(await secretExists(OAUTH_CLIENT_SECRET)).toBe(false);
  });

  it("OAuth sırrı ortam değişkenlerinden okunmaz", async () => {
    process.env.GMAIL_OAUTH_CLIENT_SECRET = SECRET;
    try {
      expect(await getSecret(OAUTH_CLIENT_SECRET)).toBeUndefined();
      expect(await secretExists(OAUTH_CLIENT_SECRET)).toBe(false);
    } finally {
      delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
    }
  });
});

describe("posta kutusu ekleme ve doğrulama", () => {
  it("Gmail kutusu 'yapılandırılmadı' durumunda eklenir; kimlik bilgisi yok; adres normalleştirilir; denetim kaydında adres yok", async () => {
    const { id } = await createGmailMailbox(db, {
      label: "Satış hesabı",
      address: "Satis@Firma-Ornek.com",
    });
    const [m] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(m).toMatchObject({
      provider: "gmail",
      status: "not_configured",
      address: "satis@firma-ornek.com",
      credentialsRef: null,
      connectedAt: null,
      syncCursor: null,
    });
    const audits = JSON.stringify(await db.select().from(auditLog));
    expect(audits).toContain("mailbox.created");
    expect(audits).not.toContain("firma-ornek");
  });

  it("geçersiz adres, ayrılmış alan adı, kopya, kötü ad ve üst sınır reddedilir", async () => {
    const ok = { label: "Hesap", address: "a@firma-ornek.com" };
    expect(await kind(createGmailMailbox(db, { ...ok, address: "adres degil" }))).toBe(
      "invalid_email",
    );
    for (const addr of ["a@firma.invalid", "a@firma.example", "a@x.test", "a@x.localhost"]) {
      expect(await kind(createGmailMailbox(db, { ...ok, address: addr })), addr).toBe(
        "reserved_domain",
      );
    }
    expect(await kind(createGmailMailbox(db, { ...ok, label: "x" }))).toBe("invalid_input");
    expect(await kind(createGmailMailbox(db, { ...ok, label: "a\nb ad" }))).toBe("invalid_input");
    expect(await kind(createGmailMailbox(db, { ...ok, label: "x".repeat(61) }))).toBe(
      "invalid_input",
    );
    await createGmailMailbox(db, ok);
    expect(await kind(createGmailMailbox(db, ok))).toBe("duplicate");
    for (let i = 0; i < 4; i++)
      await createGmailMailbox(db, { label: `Kutu ${i}`, address: `k${i}@firma-ornek.com` });
    expect(
      await kind(createGmailMailbox(db, { label: "Fazla", address: "z@firma-ornek.com" })),
    ).toBe("limit");
  });

  it("eklenen kutu kampanyaya atanamaz ve canlı hazırlığı 'tamam' yapmaz", async () => {
    const { id } = await createGmailMailbox(db, {
      label: "Satış",
      address: "satis@firma-ornek.com",
    });
    await expect(
      createCampaignService(db, { name: "Deneme", mailboxId: id }, { now: 1 }),
    ).rejects.toMatchObject({ code: "live_disabled" });
    const r = await getLiveReadiness(db);
    expect(r.items.find((i) => i.key === "real_mailbox")?.status).toBe("blocked");
    expect(r.allOk).toBe(false);
    expect(r.liveSendingEnabled).toBe(false);
  });
});

describe("durum, ad ve silme", () => {
  const add = () => createGmailMailbox(db, { label: "Satış", address: "satis@firma-ornek.com" });

  it("API: ad ve not_configured ↔ disabled; connected verilemez; demo ve bağlı kutu değiştirilemez", async () => {
    const { id } = await add();
    const patch = (i: number, p: unknown) =>
      call(mailboxIdRoute.PATCH(req("PATCH", `/api/mailboxes/${i}`, p), ctx(i)));
    expect((await patch(id, { status: "disabled" })).status).toBe(200);
    expect((await rows()).find((m) => m.id === id)?.status).toBe("disabled");
    expect((await patch(id, { label: "Yeni ad", status: "not_configured" })).status).toBe(200);
    expect((await patch(id, { status: "connected" })).status).toBe(400); // şema reddeder
    expect((await patch(id, { status: "error" })).status).toBe(400);
    expect((await patch(id, { provider: "demo" })).status).toBe(400);
    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(DEMO_MAILBOX, { label: "Başka ad" })).body.code).toBe("NOT_EDITABLE");
    await db
      .update(mailboxes)
      .set({ status: "connected", credentialsRef: "x" })
      .where(eq(mailboxes.id, id));
    expect((await patch(id, { status: "disabled" })).body.code).toBe("INVALID_STATUS");
    expect((await patch(999, { label: "ad ad" })).status).toBe(404);
  });

  it("silme: demo, bağlı ve geçmişi olan kutu silinemez; olmayan 404; silinince belirteç de gider", async () => {
    const { id } = await add();
    await setSecret(mailboxRefreshTokenName(id), "refresh-token-value-123");
    const del = (i: number) =>
      call(mailboxIdRoute.DELETE(req("DELETE", `/api/mailboxes/${i}`), ctx(i)));
    expect((await del(DEMO_MAILBOX)).body.code).toBe("NOT_EDITABLE");
    expect((await del(999)).status).toBe(404);

    await db
      .update(mailboxes)
      .set({ status: "connected", credentialsRef: "x" })
      .where(eq(mailboxes.id, id));
    expect((await del(id)).body.code).toBe("INVALID_STATUS");
    await db.update(mailboxes).set({ status: "not_configured" }).where(eq(mailboxes.id, id));

    const camp = await createCampaign(db, { status: "paused" });
    await db.update(campaigns).set({ mailboxId: id }).where(eq(campaigns.id, camp));
    expect((await del(id)).body.code).toBe("IN_USE");
    expect(await secretExists(mailboxRefreshTokenName(id))).toBe(true); // reddedilen silme gizli bilgiyi silmez
    await db.update(campaigns).set({ mailboxId: DEMO_MAILBOX }).where(eq(campaigns.id, camp));

    expect((await del(id)).status).toBe(200);
    expect((await rows()).some((m) => m.id === id)).toBe(false);
    expect(await secretExists(mailboxRefreshTokenName(id))).toBe(false);
    await expect(deleteMailbox(db, id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("ileti geçmişi olan kutu silinemez", async () => {
    const { id } = await add();
    const camp = await createCampaign(db, { status: "running" });
    await seedSent(db, camp, { mailboxId: id });
    expect(await kind(deleteMailbox(db, id))).toBe("in_use");
  });
});

describe("API: ekleme ve istemci ayarı", () => {
  const post = (p: unknown) =>
    call(mailboxesRoute.POST(req("POST", "/api/mailboxes", p), undefined));
  const put = (p: unknown) =>
    call(gmailClientRoute.PUT(req("PUT", "/api/mailboxes/gmail-client", p), undefined));

  it("katı şema: sağlayıcı/durum/kimlik bilgisi alanları kabul edilmez; kullanım onayı gerekir", async () => {
    expect((await post({ label: "Satış", address: "satis@firma-ornek.com" })).status).toBe(201);
    for (const extra of [
      { provider: "demo" },
      { provider: "smtp" },
      { status: "connected" },
      { credentialsRef: "x" },
      { password: "x" },
    ]) {
      expect(
        (await post({ label: "Ad", address: "b@firma-ornek.com", ...extra })).status,
        JSON.stringify(extra),
      ).toBe(400);
    }
    expect((await rows()).filter((m) => m.provider !== "demo")).toHaveLength(1);
    await db.delete(settings).where(eq(settings.key, "consent"));
    expect(
      (await post({ label: "Ad", address: "c@firma-ornek.com" })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("liste yanıtı kimlik bilgisi referansı veya sır içermez; düzenlenebilirlik doğru bildirilir", async () => {
    const { id } = await createGmailMailbox(db, {
      label: "Satış",
      address: "satis@firma-ornek.com",
    });
    await db
      .update(mailboxes)
      .set({ credentialsRef: "gizli-referans" })
      .where(eq(mailboxes.id, id));
    const list = await call(mailboxesRoute.GET(req("GET", "/api/mailboxes"), undefined));
    expect(list.text).not.toContain("gizli-referans");
    const items = list.body.items as Json[];
    expect(items.find((i) => i.id === DEMO_MAILBOX)).toMatchObject({
      editable: false,
      sendable: true,
    });
    expect(items.find((i) => i.id === id)).toMatchObject({
      editable: true,
      sendable: false,
      scope: "live",
    });
  });

  it("OAuth istemci bilgisi: geçersiz kimlik/sır reddedilir; sır ve tam kimlik hiçbir yanıtta yok", async () => {
    expect((await put({ clientId: "kimlik" })).body.code).toBe("INVALID_CLIENT");
    expect((await put({ clientId: CLIENT_ID, clientSecret: "kisa" })).body.code).toBe(
      "INVALID_CLIENT",
    );
    expect(
      (await put({ clientId: CLIENT_ID, clientSecret: "bosluk iceren sir degeri" })).body.code,
    ).toBe("INVALID_CLIENT");
    expect((await put({ clientId: CLIENT_ID, extra: 1 })).status).toBe(400);
    expect(await secretExists(OAUTH_CLIENT_SECRET)).toBe(false);

    const ok = await put({ clientId: CLIENT_ID, clientSecret: SECRET });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ clientIdConfigured: true, secretConfigured: true });
    for (const text of [
      ok.text,
      (await call(gmailClientRoute.GET(req("GET", "/api/mailboxes/gmail-client"), undefined))).text,
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("abcdefghijklmnop");
      expect(text).not.toContain(SECRET.slice(0, 8));
    }
  });

  it("sır yalnızca şifreli depoda; veritabanı, denetim kaydı ve gizli dosya düz metin içermez; sır güncellenmezse korunur", async () => {
    await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: SECRET });
    const dump = JSON.stringify(
      (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.length,
    );
    expect(dump).toBeTruthy();
    const all = await client.execute("SELECT * FROM settings");
    expect(JSON.stringify(all.rows)).not.toContain(SECRET);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain(SECRET);
    expect(await getSecret(OAUTH_CLIENT_SECRET)).toBe(SECRET);

    // Yalnızca kimlik güncellenirse sır korunur.
    await setGmailClient(db, {
      clientId: "999999999999-zyxwvutsrqponm.apps.googleusercontent.com",
    });
    expect(await getSecret(OAUTH_CLIENT_SECRET)).toBe(SECRET);
    expect((await getGmailClientStatus(db)).clientIdPreview).toBe(
      "9999…apps.googleusercontent.com",
    );
  });

  it("silme: istemci kimliği ve sırrı temizlenir", async () => {
    await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: SECRET });
    const r = await call(
      gmailClientRoute.DELETE(req("DELETE", "/api/mailboxes/gmail-client"), undefined),
    );
    expect(r.body).toEqual({
      clientIdConfigured: false,
      clientIdPreview: null,
      secretConfigured: false,
    });
    expect(await secretExists(OAUTH_CLIENT_SECRET)).toBe(false);
  });

  it("güvenlik: gerçek gönderim kapalı kalır ve istemci bilgisi eklemek hazırlığı açmaz", async () => {
    await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: SECRET });
    await createGmailMailbox(db, { label: "Satış", address: "satis@firma-ornek.com" });
    const r = await getLiveReadiness(db);
    expect(r.liveSendingEnabled).toBe(false);
    expect(r.allOk).toBe(false);
    expect(r.items.find((i) => i.key === "real_mailbox")?.status).toBe("blocked");
  });
});
