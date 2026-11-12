import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as callbackRoute from "@/app/api/oauth/gmail/callback/route";
import * as resultRoute from "@/app/api/oauth/gmail/callback/result/route";
import type { Db } from "@/lib/db/client";
import { mailboxes } from "@/lib/db/schema";
import {
  GMAIL_SCOPES,
  resetOAuthMemoryForTests,
  setOAuthDepsForTests,
  startAuthorization,
  type OAuthDeps,
} from "@/lib/mail/gmail/oauth";
import { oauthReasonKey, oauthResultText } from "@/lib/mail/gmail/oauth-messages";
import {
  lookupOAuthResult,
  MAX_RESULTS,
  recordOAuthResult,
  resetOAuthResultsForTests,
  RESULT_TTL_MS,
} from "@/lib/mail/gmail/oauth-result";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { setLocale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";
import { setSetting } from "@/lib/settings";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth-server";

/**
 * C12: Gmail OAuth geri çağrısı sistem tarayıcısında BAĞIMSIZ bir Türkçe sonuç sayfası gösterir (uygulamanın tamamı
 * açılmaz) ve sonucu, uygulama penceresinin sorgulayabilmesi için state özetiyle bellekte saklar. Yalnızca yerel
 * SAHTE OAuth sunucusu kullanılır; gerçek Google'a istek atılmaz.
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const REDIRECT = "http://127.0.0.1:3000/api/oauth/gmail/callback";
const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";

let client: Client;
let db: Db;
let dir: string;
let fake: FakeOAuth;
let deps: OAuthDeps;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-oauth-res-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "cd".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  resetOAuthResultsForTests();
  fake = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  deps = fake.deps(() => Date.now());
  globalFetch = vi.spyOn(globalThis, "fetch");
  setOAuthDepsForTests(deps);
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(async () => {
  expect(
    globalFetch.mock.calls.filter((c: unknown[]) => !String(c[0]).startsWith("http://127.0.0.1:"))
      .length,
  ).toBe(0);
  globalFetch.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  setOAuthDepsForTests(null);
  resetOAuthMemoryForTests();
  resetOAuthResultsForTests();
  await fake.close();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function begin(email = ADDRESS) {
  const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
  const { authUrl } = await startAuthorization(db, deps, {
    mailboxId: id,
    level: "send",
    redirectUri: REDIRECT,
  });
  const u = new URL(authUrl);
  const code = `code-${Math.random().toString(36).slice(2)}-abcdef`;
  fake.issue(code, {
    challenge: u.searchParams.get("code_challenge")!,
    redirectUri: REDIRECT,
    clientId: CLIENT_ID,
    email,
    nonce: u.searchParams.get("nonce")!,
    scope: `openid email ${GMAIL_SCOPES.send}`,
  });
  return { id, state: u.searchParams.get("state")!, code };
}

const callback = (qs: string) =>
  callbackRoute.GET(new Request(`${ORIGIN}/api/oauth/gmail/callback?${qs}`));
async function result(payload: unknown) {
  const r = await resultRoute.POST(
    new Request(`${ORIGIN}/api/oauth/gmail/callback/result`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(payload),
    }),
    undefined,
  );
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe("geri çağrı: sayfa dili (Faz 4)", () => {
  afterEach(() => setLocale("tr"));

  it("sayfa ui.language ayarının dilindedir; sunucudaki süreç içi etkin dile bakmaz", async () => {
    // Süreç içi dil başka bir sayfanın çizimiyle "en" kalmış olsa bile ayar Türkçe → Türkçe sayfa.
    setLocale("en");
    const trPage = await (await callback("state=bilinmeyen-state&code=x")).text();
    expect(trPage).toContain('<html lang="tr">');
    expect(trPage).toContain(tr["mbx.oauth.page.close"].replaceAll("'", "&#39;"));
    // Ayar İngilizce → süreç içi dil Türkçe olsa da İngilizce sayfa.
    await setSetting(db, "ui.language", "en");
    setLocale("tr");
    const enPage = await (await callback("state=bilinmeyen-state-2&code=x")).text();
    expect(enPage).toContain('<html lang="en">');
    expect(enPage).toContain(en["mbx.oauth.page.close"]!.replaceAll("'", "&#39;"));
    expect(oauthResultText({ ok: true, reason: null, readDenied: false }, "en").title).toBe(
      en["mbx.oauth.page.ok"],
    );
  });
});

describe("geri çağrı: bağımsız sonuç sayfası", () => {
  it("başarı: 200, Türkçe 'bağlantı tamamlandı / sekmeyi kapatın'; kod, state ve uygulama yönlendirmesi YOK", async () => {
    const b = await begin();
    const res = await callback(`code=${b.code}&state=${b.state}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain(tr["mbx.oauth.page.ok"]);
    expect(html).toContain(tr["mbx.oauth.page.close"]);
    expect(html).not.toContain(b.code);
    expect(html).not.toContain(b.state);
    expect(html).not.toMatch(/<script|\/settings|href=/i);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, b.id)))[0]!.status).toBe(
      "connected",
    );
  });

  it("takma adla giriş (account_mismatch): 400, nedene özgü açıklama ve 'birincil adres' ipucu", async () => {
    const b = await begin("takma-ad@firma-ornek.com");
    const res = await callback(`code=${b.code}&state=${b.state}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(tr["mbx.oauth.page.error"]);
    expect(html).toContain(tr["mbx.oauth.reason.account_mismatch"]);
    expect(html).toContain("birincil adres");
    // Metin HTML olarak kaçışlanır (kesme işareti → &#39;).
    expect(html).toContain(tr["mbx.oauth.page.retry"].replaceAll("'", "&#39;"));
    expect(html).not.toContain("takma-ad@");
  });

  it("süresi dolmuş/geçersiz state: yeniden başlatma ve uygulamayı açık tutma ipucu", async () => {
    const html = await (await callback("code=abcdef&state=bilinmeyen")).text();
    expect(html).toContain(tr["mbx.oauth.reason.invalid_state"]);
    expect(html).toContain(tr["mbx.oauth.hint.expired"]);
  });
});

describe("uygulama penceresi için sonuç ucu", () => {
  it("başarı state özetiyle bulunur; sekmenin yenilenmesi (invalid_state) başarıyı EZMEZ", async () => {
    const b = await begin();
    expect((await result({ state: b.state })).body).toEqual({ status: "pending" });
    await callback(`code=${b.code}&state=${b.state}`);
    const done = await result({ state: b.state });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "done", ok: true, reason: null, readDenied: false });
    expect(JSON.stringify(done.body)).not.toContain(b.code);

    // Sekme yenilendi: state zaten kullanıldı; sayfa kayıtlı BAŞARIYI gösterir ("kurulamadı" değil).
    const again = await callback(`code=${b.code}&state=${b.state}`);
    expect(again.status).toBe(200);
    const html = await again.text();
    expect(html).toContain(tr["mbx.oauth.page.ok"]);
    expect(html).not.toContain(tr["mbx.oauth.reason.invalid_state"]);
    expect((await result({ state: b.state })).body).toMatchObject({ status: "done", ok: true });
  });

  it("başarısız sonucun sekmesi yenilenirse kayıtlı neden gösterilir", async () => {
    const b = await begin("takma-ad@firma-ornek.com");
    await callback(`code=${b.code}&state=${b.state}`);
    const again = await callback(`code=${b.code}&state=${b.state}`);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain(tr["mbx.oauth.reason.account_mismatch"]);
  });

  it("bekleyen istekle eşleşmeyen state'ler kaydedilmez: toplu sahte geri çağrılar gerçek sonucu silemez", async () => {
    const b = await begin("takma-ad@firma-ornek.com");
    await callback(`code=${b.code}&state=${b.state}`);
    for (let i = 0; i < 40; i++) {
      const res = await callback(`code=abcdef&state=sahte-${i}`);
      expect(res.status).toBe(400);
    }
    expect((await result({ state: "sahte-1" })).body).toEqual({ status: "pending" });
    expect((await result({ state: b.state })).body).toMatchObject({
      status: "done",
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("hata nedeni (account_mismatch) pencereye iletilir; başka state'in sonucu görünmez", async () => {
    const b = await begin("baska@firma-ornek.com");
    await callback(`code=${b.code}&state=${b.state}`);
    expect((await result({ state: b.state })).body).toMatchObject({
      status: "done",
      ok: false,
      reason: "account_mismatch",
    });
    expect((await result({ state: `${b.state}x` })).body).toEqual({ status: "pending" });
  });

  it("katı şema: boş, aşırı uzun veya fazladan alanlı gövde 400", async () => {
    expect((await result({})).status).toBe(400);
    expect((await result({ state: "" })).status).toBe(400);
    expect((await result({ state: "a".repeat(129) })).status).toBe(400);
    expect((await result({ state: "abc", mailboxId: 1 })).status).toBe(400);
  });
});

describe("sonuç belleği", () => {
  it("ham state saklanmaz; süre dolunca silinir; kayıt sayısı sınırlıdır", () => {
    const now = 1_800_000_000_000;
    recordOAuthResult(
      "gizli-state-degeri",
      { ok: false, reason: "expired", readDenied: false, mailboxId: null },
      now,
    );
    const mem = (globalThis as Record<string, unknown>).__umGmailOAuthResults as Map<
      string,
      unknown
    >;
    expect([...mem.keys()].join()).not.toContain("gizli-state-degeri");
    expect(lookupOAuthResult("gizli-state-degeri", now + 1000)?.reason).toBe("expired");
    expect(lookupOAuthResult("gizli-state-degeri", now + RESULT_TTL_MS + 1)).toBeNull();

    for (let i = 0; i < MAX_RESULTS + 5; i++) {
      recordOAuthResult(
        `s-${i}`,
        { ok: true, reason: null, readDenied: false, mailboxId: i },
        now + i,
      );
    }
    expect(mem.size).toBe(MAX_RESULTS);
    expect(lookupOAuthResult("s-0", now + 100)).toBeNull(); // en eski düşer
    expect(lookupOAuthResult(`s-${MAX_RESULTS + 4}`, now + 100)?.mailboxId).toBe(MAX_RESULTS + 4);
    recordOAuthResult(null, { ok: true, reason: null, readDenied: false, mailboxId: 1 }, now);
    expect(lookupOAuthResult(null, now)).toBeNull();
  });

  it("metinler: bilinen nedenler kendi metniyle, bilinmeyen genel metinle; okuma reddi başarıda belirtilir", () => {
    expect(oauthReasonKey("scope_excess")).toBe("mbx.oauth.reason.scope_excess");
    expect(oauthReasonKey("invalid_response")).toBe("mbx.oauth.reason.other");
    expect(oauthReasonKey(null)).toBe("mbx.oauth.reason.other");
    expect(oauthResultText({ ok: false, reason: "no_refresh_token", readDenied: false })).toEqual({
      title: tr["mbx.oauth.page.error"],
      message: tr["mbx.oauth.reason.no_refresh_token"],
      hint: tr["mbx.oauth.hint.no_refresh_token"],
    });
    expect(oauthResultText({ ok: false, reason: "transient", readDenied: false }).hint).toBeNull();
    expect(oauthResultText({ ok: true, reason: null, readDenied: true }).message).toBe(
      tr["mbx.oauth.result.readDenied"],
    );
  });

  it("ayarlar ekranı: sonucu state ile sorar, uygulamayı açık tutma ve birincil adres ipuçlarını gösterir", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "features", "settings", "mailbox-section.tsx"),
      "utf8",
    );
    expect(src).toContain("/api/oauth/gmail/callback/result");
    expect(src).toContain('t("mbx.oauth.keepOpen")');
    expect(src).toContain('t("mbx.oauth.primaryAddress")');
    expect(src).toContain('t("mbx.address.hint")');
    expect(src).toContain("oauthResultText");
  });
});
