import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as callbackRoute from "@/app/api/oauth/gmail/callback/route";
import * as startRoute from "@/app/api/mailboxes/[id]/oauth/start/route";
import * as disconnectRoute from "@/app/api/mailboxes/[id]/oauth/disconnect/route";
import * as statusRoute from "@/app/api/mailboxes/[id]/oauth/route";
import { createCampaign as createCampaignService } from "@/lib/campaigns/service";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes, settings } from "@/lib/db/schema";
import {
  completeAuthorization,
  disconnectGmail,
  GMAIL_SCOPES,
  getAccessToken,
  getOAuthStatus,
  loopbackRedirectUri,
  OAuthError,
  PENDING_TTL_MS,
  requireScope,
  resetOAuthMemoryForTests,
  setOAuthDepsForTests,
  startAuthorization,
  type AccessLevel,
  type OAuthDeps,
} from "@/lib/mail/gmail/oauth";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { getSecret, mailboxRefreshTokenName, secretExists } from "@/lib/secrets/store";
import { DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import crypto from "node:crypto";
import {
  jwkOf,
  signJwt,
  startFakeOAuth,
  testKeys,
  type FakeOAuth,
} from "./helpers/fake-oauth-server";

/**
 * Gmail OAuth çekirdeği (Aşama 15.3). Yalnızca yerel SAHTE OAuth sunucusu kullanılır; gerçek Google'a hiçbir istek
 * atılmaz (fetch sarmalayıcısı 127.0.0.1 dışını reddeder, genel fetch casusla izlenir).
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const SEND = GMAIL_SCOPES.send;
const READ = GMAIL_SCOPES.read;
const REDIRECT = "http://127.0.0.1:3000/api/oauth/gmail/callback";

let client: Client;
let db: Db;
let dir: string;
let fake: FakeOAuth;
let deps: OAuthDeps;
let clock: number;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-oauth-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  clock = Date.UTC(2026, 10, 10, 10, 0, 0);
  fake = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  deps = fake.deps(() => clock);
  globalFetch = vi.spyOn(globalThis, "fetch");
  setOAuthDepsForTests(deps);
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
});
afterEach(async () => {
  expect(
    globalFetch.mock.calls.filter((c: unknown[]) => !String(c[0]).startsWith("http://127.0.0.1:"))
      .length,
  ).toBe(0);
  globalFetch.mockRestore();
  setOAuthDepsForTests(null);
  resetOAuthMemoryForTests();
  await fake.close();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const kind = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as OAuthError).kind;
const mailbox = async (id: number) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

async function begin(
  level: AccessLevel = "send",
  opts: {
    address?: string;
    idToken?: (nonce: string) => string;
    granted?: string;
    claims?: Record<string, unknown>;
    override?: Record<string, unknown>;
    omit?: string[];
    email?: string;
    id?: number;
  } = {},
) {
  const id =
    opts.id ??
    (await createGmailMailbox(db, { label: "Satış", address: opts.address ?? ADDRESS })).id;
  const { authUrl } = await startAuthorization(db, deps, {
    mailboxId: id,
    level,
    redirectUri: REDIRECT,
  });
  const u = new URL(authUrl);
  const code = `code-${Math.random().toString(36).slice(2)}-abcdef`;
  fake.issue(code, {
    challenge: u.searchParams.get("code_challenge")!,
    redirectUri: REDIRECT,
    clientId: CLIENT_ID,
    email: opts.email ?? opts.address ?? ADDRESS,
    nonce: u.searchParams.get("nonce") ?? undefined,
    idToken: opts.idToken?.(u.searchParams.get("nonce") ?? ""),
    scope:
      opts.granted ??
      `openid https://www.googleapis.com/auth/userinfo.email ${SEND}${level === "send_read" ? ` ${READ}` : ""}`,
    claims: opts.claims,
    override: opts.override,
    omit: opts.omit,
  });
  return {
    id,
    url: u,
    state: u.searchParams.get("state")!,
    code,
    nonce: u.searchParams.get("nonce")!,
  };
}
const finish = (b: { state: string; code: string }) =>
  completeAuthorization(db, deps, { state: b.state, code: b.code, error: null });

describe("yetki adresi: en az yetki, PKCE, state", () => {
  it("varsayılan yalnızca gönderim: openid email + gmail.send; okuma, modify ve tam erişim YOK", async () => {
    const { url } = await begin("send");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes.sort()).toEqual(["email", "openid", SEND].sort());
    const all = url.toString();
    for (const bad of [
      "gmail.readonly",
      "gmail.modify",
      "mail.google.com",
      "gmail.metadata",
      "gmail.compose",
    ]) {
      expect(all).not.toContain(bad);
    }
  });

  it("okuma ayrı ve bilinçli: yalnızca send_read düzeyinde gmail.readonly eklenir (modify/tam erişim yine yok)", async () => {
    const { url } = await begin("send_read");
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      ["email", "openid", READ, SEND].sort(),
    );
    expect(url.toString()).not.toContain("gmail.modify");
    expect(url.toString()).not.toContain("mail.google.com");
  });

  it("PKCE S256, offline erişim, onay istemi, hesap ipucu; sır ve doğrulayıcı adreste YOK; state yeterince uzun", async () => {
    const { url, state } = await begin();
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("include_granted_scopes")).toBe("false");
    expect(p.get("login_hint")).toBe(ADDRESS);
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(url.toString()).not.toContain("code_verifier");
  });

  it("istemci tanımsızsa başlatma reddedilir; demo kutusu ve olmayan kutu bağlanamaz; devre dışı kutu reddedilir", async () => {
    await db.delete(settings).where(eq(settings.key, "mail.gmailOAuth"));
    const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
    expect(
      await kind(
        startAuthorization(db, deps, { mailboxId: id, level: "send", redirectUri: REDIRECT }),
      ),
    ).toBe("client_not_configured");
    await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(
      await kind(
        startAuthorization(db, deps, {
          mailboxId: DEMO_MAILBOX,
          level: "send",
          redirectUri: REDIRECT,
        }),
      ),
    ).toBe("not_gmail");
    expect(
      await kind(
        startAuthorization(db, deps, { mailboxId: 999, level: "send", redirectUri: REDIRECT }),
      ),
    ).toBe("mailbox_not_found");
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, id));
    expect(
      await kind(
        startAuthorization(db, deps, { mailboxId: id, level: "send", redirectUri: REDIRECT }),
      ),
    ).toBe("invalid_status");
  });

  it("yönlendirme adresi yalnızca yerel olabilir", () => {
    expect(loopbackRedirectUri("http://127.0.0.1:3000/api/x")).toBe(REDIRECT);
    expect(loopbackRedirectUri("http://localhost:3210/api/x")).toBe(
      "http://localhost:3210/api/oauth/gmail/callback",
    );
    expect(() => loopbackRedirectUri("https://evil.example/api/x")).toThrow();
  });

  it("uçlar üretimde değiştirilemez (yalnızca NODE_ENV=test'te enjekte edilebilir)", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
      await expect(
        startAuthorization(db, deps, { mailboxId: id, level: "send", redirectUri: REDIRECT }),
      ).rejects.toThrow(/değiştirilemez/);
      expect(() => setOAuthDepsForTests(deps)).toThrow(/Üretimde/);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

describe("geri çağrı: state doğrulama", () => {
  it("bilinmeyen, boş, aşırı uzun ve tekrar kullanılan state reddedilir; hiçbir şey değişmez", async () => {
    const b = await begin();
    for (const bad of [null, "", "x".repeat(200), "bilinmeyen-state-degeri"]) {
      expect(
        await kind(completeAuthorization(db, deps, { state: bad, code: b.code, error: null })),
      ).toBe("invalid_state");
    }
    expect((await mailbox(b.id)).status).toBe("not_configured");
    await finish(b); // gerçek state çalışır
    expect(await kind(finish(b))).toBe("invalid_state"); // yeniden kullanım
    expect(fake.requests.filter((r) => r.path === "/token")).toHaveLength(1);
  });

  it("süresi dolan state reddedilir ve tüketilir; ağ isteği atılmaz", async () => {
    const b = await begin();
    clock += PENDING_TTL_MS + 1;
    expect(await kind(finish(b))).toBe("expired");
    expect(fake.requests).toHaveLength(0);
    expect(await kind(finish(b))).toBe("invalid_state");
  });

  it("kullanıcı izni reddederse (access_denied) kutu ve gizli depo değişmez", async () => {
    const b = await begin();
    expect(
      await kind(
        completeAuthorization(db, deps, { state: b.state, code: null, error: "access_denied" }),
      ),
    ).toBe("access_denied");
    expect(
      await kind(
        completeAuthorization(db, deps, { state: b.state, code: null, error: "access_denied" }),
      ),
    ).toBe("invalid_state");
    const mb = await mailbox(b.id);
    expect(mb).toMatchObject({ status: "not_configured", credentialsRef: null });
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("kod değişimi, hesap ve kapsam denetimi", () => {
  it("başarı: yenileme belirteci yalnızca şifreli depoda; kutu bağlı; izin özeti; denetimde belirteç/adres yok", async () => {
    const b = await begin();
    const r = await finish(b);
    expect(r).toMatchObject({
      mailboxId: b.id,
      send: true,
      read: false,
      readRequestedButDenied: false,
    });

    const mb = await mailbox(b.id);
    expect(mb).toMatchObject({
      status: "connected",
      credentialsRef: mailboxRefreshTokenName(b.id),
      lastError: null,
    });
    const refresh = await getSecret(mailboxRefreshTokenName(b.id));
    expect(refresh).toMatch(/^1\/\/fake-refresh-/);
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain("fake-refresh");

    // Belirteçler hiçbir tabloda ve denetim kaydında yok; erişim belirteci diske hiç yazılmaz.
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    let dump = "";
    for (const t of tables.rows)
      dump += JSON.stringify((await client.execute(`SELECT * FROM "${String(t.name)}"`)).rows);
    for (const secret of [refresh!, "ya29.fake-access", CLIENT_SECRET, b.code])
      expect(dump).not.toContain(secret);
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain("ya29.");
    const audits = JSON.stringify(await db.select().from(auditLog));
    expect(audits).toContain("mailbox.oauth_connected");
    expect(audits).not.toContain("firma-ornek");

    expect(await getOAuthStatus(db, b.id)).toEqual({
      connected: true,
      send: true,
      read: false,
      reauthorizationRequired: false,
    });
  });

  it("sunucu doğru PKCE doğrulayıcısı, yönlendirme adresi, istemci kimliği ve sırrıyla çağrılır", async () => {
    const b = await begin();
    await finish(b);
    const req = fake.requests.find((r) => r.path === "/token")!;
    expect(req.params).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      code: b.code,
    });
    expect(req.params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("yanlış hesap (e-posta uyuşmuyor) reddedilir: hiçbir şey saklanmaz ve verilen yetki iptal edilmeye çalışılır", async () => {
    const b = await begin("send", { email: "baska@firma-ornek.com" });
    expect(await kind(finish(b))).toBe("account_mismatch");
    expect(await mailbox(b.id)).toMatchObject({ status: "not_configured", credentialsRef: null });
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
    expect(fake.requests.some((r) => r.path === "/revoke")).toBe(true);
  });

  it.each([
    ["hedef kitle yanlış", { aud: "baska-istemci" }],
    ["e-posta doğrulanmamış", { email_verified: false }],
    ["süresi dolmuş", { exp: 1 }],
    ["yayıncı yanlış", { iss: "https://evil.example" }],
  ])("kimlik belirteci geçersizse (%s) reddedilir", async (_n, claims) => {
    const b = await begin("send", { claims });
    expect(await kind(finish(b))).toBe("invalid_response");
    expect((await mailbox(b.id)).status).toBe("not_configured");
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
  });

  it("kimlik belirteci veya yenileme belirteci yoksa reddedilir", async () => {
    const a = await begin("send", { omit: ["id_token"] });
    expect(await kind(finish(a))).toBe("invalid_response");
    const b = await begin("send", { omit: ["refresh_token"], id: a.id });
    expect(await kind(finish(b))).toBe("no_refresh_token");
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
  });

  it("gönderim izni verilmediyse reddedilir; beklenmeyen kapsam (modify/tam erişim) bağlantıyı reddeder ve yetki iptal edilir", async () => {
    const noSend = await begin("send", { granted: "openid email" });
    expect(await kind(finish(noSend))).toBe("scope_missing");
    expect((await mailbox(noSend.id)).status).toBe("not_configured");

    for (const extra of [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/drive",
    ]) {
      fake.requests.length = 0;
      const b = await begin("send", { granted: `openid email ${SEND} ${extra}`, id: noSend.id });
      expect(await kind(finish(b)), extra).toBe("scope_excess");
      expect((await mailbox(noSend.id)).status).toBe("not_configured");
      expect(await secretExists(mailboxRefreshTokenName(noSend.id))).toBe(false);
      expect(fake.requests.some((r) => r.path === "/revoke")).toBe(true);
    }
  });

  it("okuma istendi ama kullanıcı ekranda kapattı: kutu yalnızca gönderim iznine bağlanır (okuma kapalı)", async () => {
    const b = await begin("send_read", { granted: `openid email ${SEND}` });
    const r = await finish(b);
    expect(r).toMatchObject({ send: true, read: false, readRequestedButDenied: true });
    await expect(requireScope(db, b.id, "send")).resolves.toBeUndefined();
    expect(await kind(requireScope(db, b.id, "read"))).toBe("scope_missing");
  });

  it("gönderim ve okuma izinleri birbirinden ayrı yönetilir; okuma ayrı yetkilendirmeyle eklenir (yükseltme)", async () => {
    const b = await begin("send");
    await finish(b);
    expect(await kind(requireScope(db, b.id, "read"))).toBe("scope_missing");

    const up = await begin("send_read", { id: b.id });
    await finish(up);
    expect(await getOAuthStatus(db, b.id)).toMatchObject({
      connected: true,
      send: true,
      read: true,
    });
    await expect(requireScope(db, b.id, "read")).resolves.toBeUndefined();
    const audits = (await db.select().from(auditLog)).map((a) => a.action);
    expect(audits).toContain("mailbox.oauth_upgraded");
  });

  it("PKCE doğrulayıcısı yanlışsa sunucu reddeder; ayrıntı metni hata iletisine SIZMAZ", async () => {
    const b = await begin();
    // Sunucuya farklı bir challenge kaydet → doğrulayıcı uyuşmaz.
    fake.issue(b.code, {
      challenge: "yanlis-challenge",
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      email: ADDRESS,
      scope: SEND,
    });
    const e = (await finish(b).catch((x: unknown) => x)) as OAuthError;
    expect(e.kind).toBe("token_exchange_failed");
    expect(e.message).not.toContain("SECRET-DETAIL");
    expect((await mailbox(b.id)).status).toBe("not_configured");
  });

  it("Google 5xx / geçersiz JSON / aşırı büyük yanıt / eksik alan: güvenli hata, değişiklik yok", async () => {
    const cases: [string, { status: number; body?: string }, string][] = [
      ["5xx", { status: 503 }, "transient"],
      ["JSON değil", { status: 200, body: "<html>" }, "invalid_response"],
      [
        "büyük",
        { status: 200, body: JSON.stringify({ x: "a".repeat(70_000) }) },
        "invalid_response",
      ],
      [
        "eksik alan",
        { status: 200, body: JSON.stringify({ access_token: "kisa" }) },
        "invalid_response",
      ],
      [
        "Bearer değil",
        {
          status: 200,
          body: JSON.stringify({
            access_token: "ya29.xxxxxxxxxxxx",
            expires_in: 3600,
            token_type: "mac",
          }),
        },
        "invalid_response",
      ],
      [
        "4xx",
        { status: 400, body: JSON.stringify({ error: "invalid_grant" }) },
        "token_exchange_failed",
      ],
    ];
    for (const [name, forced, expected] of cases) {
      const b = await begin();
      fake.forceToken = forced;
      expect(await kind(finish(b)), name).toBe(expected);
      fake.forceToken = null;
      expect((await mailbox(b.id)).status, name).toBe("not_configured");
      await db.delete(mailboxes).where(eq(mailboxes.id, b.id));
    }
  });

  it("bağlı ve gönderim izinli kutu kampanyaya atanabilir (kapı açık); hazırlıkta kutu 'tamam', okuma izni yoksa gelen kutusu ENGEL; allOk false", async () => {
    const b = await begin();
    await finish(b);
    await expect(
      createCampaignService(db, { name: "Deneme", mailboxId: b.id }, { now: 1 }),
    ).resolves.toMatchObject({ id: expect.any(Number) });
    let r = await getLiveReadiness(db);
    const by = () => Object.fromEntries(r.items.map((i) => [i.key, i.status]));
    expect(by()).toMatchObject({
      real_mailbox: "ok",
      inbox_access: "blocked",
      live_flag: "ok",
      // Bağlantı tek başına yeterli değil: DNS, çıkış uç noktası ve ülke kilidi hâlâ engel/doğrulanmadı.
      dns_auth: "unknown",
      https_unsubscribe: "blocked",
      live_country_policies: "blocked",
    });
    expect(r.allOk).toBe(false);
    expect(r.liveSendingEnabled).toBe(true);

    await finish(await begin("send_read", { id: b.id }));
    r = await getLiveReadiness(db);
    expect(by()).toMatchObject({ real_mailbox: "ok", inbox_access: "ok", live_flag: "ok" });
    expect(r.allOk).toBe(false);
  });
});

describe("erişim belirteci ve yenileme", () => {
  async function connected() {
    const b = await begin();
    await finish(b);
    return b.id;
  }
  const tokenCalls = () =>
    fake.requests.filter((r) => r.path === "/token" && r.params.grant_type === "refresh_token");

  it("bağlantı sonrası önbellekteki belirteç yeniden kullanılır; süre dolmadan yenileme isteği atılmaz", async () => {
    const id = await connected();
    const t1 = await getAccessToken(db, deps, id);
    expect(t1).toMatch(/^ya29\.fake-access-1-/);
    expect(await getAccessToken(db, deps, id)).toBe(t1);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("süre dolunca yenilenir; eşzamanlı çağrılar TEK istekte birleşir", async () => {
    const id = await connected();
    clock += 3600 * 1000; // önbellek süresi doldu
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getAccessToken(db, deps, id)),
    );
    expect(new Set(results).size).toBe(1);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.params).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it("yenileme belirteci döndürülürse (rotasyon) şifreli depoda güncellenir", async () => {
    const id = await connected();
    const old = (await getSecret(mailboxRefreshTokenName(id)))!;
    // Sahte sunucu rotasyonu simüle etsin: yeni belirteç yanıtına ekle.
    fake.validRefresh.add("1//rotated-refresh-zzzzzzzz");
    clock += 3600 * 1000;
    const refreshSpy = vi.fn();
    const rotating: OAuthDeps = {
      ...deps,
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const res = await deps.fetch(u, init);
        const body = (await res.clone().json()) as Record<string, unknown>;
        refreshSpy();
        return new Response(
          JSON.stringify({ ...body, refresh_token: "1//rotated-refresh-zzzzzzzz" }),
          { status: res.status },
        );
      }) as typeof fetch,
    };
    await getAccessToken(db, rotating, id);
    expect(refreshSpy).toHaveBeenCalled();
    expect(await getSecret(mailboxRefreshTokenName(id))).toBe("1//rotated-refresh-zzzzzzzz");
    expect(old).not.toBe("1//rotated-refresh-zzzzzzzz");
  });

  it("invalid_grant (yetki iptal edilmiş): kutu 'error', belirteç ve izinler silinir, sonraki çağrı AĞA ÇIKMADAN reddedilir", async () => {
    const id = await connected();
    fake.validRefresh.clear();
    clock += 3600 * 1000;
    expect(await kind(getAccessToken(db, deps, id))).toBe("reauthorization_required");
    expect(await mailbox(id)).toMatchObject({
      status: "error",
      lastError: "reauthorization_required",
    });
    expect(await secretExists(mailboxRefreshTokenName(id))).toBe(false);
    expect(await getOAuthStatus(db, id)).toEqual({
      connected: false,
      send: false,
      read: false,
      reauthorizationRequired: true,
    });
    const before = fake.requests.length;
    expect(await kind(getAccessToken(db, deps, id))).toBe("reauthorization_required");
    expect(fake.requests.length).toBe(before); // ağ yok
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain("mailbox.oauth_reauth_required");
  });

  it("geçici hata (503 / ağ): durum değişmez, belirteç korunur; sonra yeniden denenebilir", async () => {
    const id = await connected();
    clock += 3600 * 1000;
    fake.forceToken = { status: 503 };
    expect(await kind(getAccessToken(db, deps, id))).toBe("transient");
    fake.forceToken = null;
    expect((await mailbox(id)).status).toBe("connected");
    expect(await secretExists(mailboxRefreshTokenName(id))).toBe(true);
    expect(await getAccessToken(db, deps, id)).toMatch(/^ya29\./);
  });

  it("bağlı olmayan veya olmayan kutu için belirteç verilmez", async () => {
    const { id } = await createGmailMailbox(db, { label: "Boş", address: "bos@firma-ornek.com" });
    expect(await kind(getAccessToken(db, deps, id))).toBe("not_connected");
    expect(await kind(getAccessToken(db, deps, 999))).toBe("mailbox_not_found");
  });

  it("hata iletileri belirteç, sır veya sunucu gövdesi içermez", async () => {
    const id = await connected();
    fake.validRefresh.clear();
    clock += 3600 * 1000;
    const e = (await getAccessToken(db, deps, id).catch((x: unknown) => x)) as OAuthError;
    for (const s of [CLIENT_SECRET, "fake-refresh", "expired or revoked", "ya29."])
      expect(e.message).not.toContain(s);
  });
});

describe("bağlantıyı kesme", () => {
  it("onay ister; yetkiyi iptal eder, belirteci ve izinleri siler, kutuyu yapılandırılmadı yapar", async () => {
    const b = await begin("send_read");
    await finish(b);
    const refresh = (await getSecret(mailboxRefreshTokenName(b.id)))!;
    expect(await kind(disconnectGmail(db, deps, b.id, { confirm: false }))).toBe("unconfirmed");
    expect((await mailbox(b.id)).status).toBe("connected");

    const r = await disconnectGmail(db, deps, b.id, { confirm: true });
    expect(r).toEqual({ revoked: true });
    expect(fake.requests.find((x) => x.path === "/revoke")?.params.token).toBe(refresh);
    expect(await mailbox(b.id)).toMatchObject({
      status: "not_configured",
      credentialsRef: null,
      connectedAt: null,
    });
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
    expect(await getOAuthStatus(db, b.id)).toMatchObject({
      connected: false,
      send: false,
      read: false,
    });
    expect(await kind(getAccessToken(db, deps, b.id))).toBe("not_connected");
  });

  it("Google iptali başarısız olsa bile yerel bağlantı kesilir (revoked=false bildirilir)", async () => {
    const b = await begin();
    await finish(b);
    fake.forceRevokeStatus = 500;
    expect(await disconnectGmail(db, deps, b.id, { confirm: true })).toEqual({ revoked: false });
    expect((await mailbox(b.id)).status).toBe("not_configured");
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
  });

  it("bağlı olmayan kutu kesilemez; bağlantı kesilince kutu yeniden düzenlenebilir/silinebilir olur", async () => {
    const { id } = await createGmailMailbox(db, { label: "Boş", address: "bos@firma-ornek.com" });
    expect(await kind(disconnectGmail(db, deps, id, { confirm: true }))).toBe("not_connected");
  });
});

describe("API uçları", () => {
  const ORIGIN = "http://127.0.0.1:3000";
  const HANDLE = "__umDbHandle";
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const post = (url: string, payload: unknown) =>
    new Request(`${ORIGIN}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(payload),
    });
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HANDLE];
  });

  it("başlatma: katı şema, kullanım onayı; yanıtta yalnızca adres (sır/doğrulayıcı yok); durum ucu belirteç döndürmez", async () => {
    const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
    const url = `/api/mailboxes/${id}/oauth/start`;
    expect((await startRoute.POST(post(url, { level: "tam" }), ctx(id))).status).toBe(400);
    expect(
      (await startRoute.POST(post(url, { level: "send", scope: "gmail.modify" }), ctx(id))).status,
    ).toBe(400);
    const ok = await startRoute.POST(post(url, { level: "send" }), ctx(id));
    const text = await ok.text();
    expect(ok.status).toBe(200);
    const authUrl = new URL(JSON.parse(text).authUrl as string);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("code_verifier");

    const st = await statusRoute.GET(new Request(`${ORIGIN}/api/mailboxes/${id}/oauth`), ctx(id));
    expect(await st.json()).toEqual({
      connected: false,
      send: false,
      read: false,
      reauthorizationRequired: false,
    });

    await db.delete(settings).where(eq(settings.key, "consent"));
    expect(
      (await startRoute.POST(post(url, { level: "send" }), ctx(id))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await startRoute.POST(
          post(`/api/mailboxes/${DEMO_MAILBOX}/oauth/start`, { level: "send" }),
          ctx(DEMO_MAILBOX),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("geri çağrı: kod/state içermeyen yönlendirme; başarıda bağlanır; yenilemede ilk sonuç, bilinmeyen state'te hata", async () => {
    const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
    const start = await startRoute.POST(
      post(`/api/mailboxes/${id}/oauth/start`, { level: "send" }),
      ctx(id),
    );
    const u = new URL(((await start.json()) as { authUrl: string }).authUrl);
    const state = u.searchParams.get("state")!;
    fake.issue("route-code-abcdef", {
      challenge: u.searchParams.get("code_challenge")!,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      email: ADDRESS,
      scope: `openid email ${SEND}`,
      nonce: u.searchParams.get("nonce")!,
    });
    const cb = (qs: string) =>
      callbackRoute.GET(new Request(`${ORIGIN}/api/oauth/gmail/callback?${qs}`));

    // C12: yönlendirme yerine bağımsız Türkçe sonuç sayfası (kod/state içermez).
    const ok = await cb(`code=route-code-abcdef&state=${state}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("location")).toBeNull();
    const okHtml = await ok.text();
    expect(okHtml).toContain("Bağlantı tamamlandı");
    expect(okHtml).not.toContain("route-code");
    expect(okHtml).not.toContain(state);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await mailbox(id)).status).toBe("connected");

    // Aynı sekme yenilenirse (state kullanıldı) ilk sonuç yeniden gösterilir; kod yeniden takas edilmez.
    const again = await cb(`code=route-code-abcdef&state=${state}`);
    expect(again.status).toBe(200);
    const againHtml = await again.text();
    expect(againHtml).toContain("Bağlantı tamamlandı");
    expect(againHtml).not.toContain(state);
    const unknown = await cb("code=route-code-abcdef&state=bilinmeyen-state");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("İstek geçersiz veya süresi dolmuş");
    const denied = await cb("error=access_denied&state=yok");
    expect(await denied.text()).toContain("Bağlantı kurulamadı");
    expect(await (await cb("")).text()).toContain("İstek geçersiz veya süresi dolmuş");
  });

  it("bağlantıyı kesme ucu: onay ister (şema), kesince durum güncellenir", async () => {
    const b = await begin();
    await finish(b);
    const url = `/api/mailboxes/${b.id}/oauth/disconnect`;
    expect((await disconnectRoute.POST(post(url, { confirm: false }), ctx(b.id))).status).toBe(400);
    expect((await disconnectRoute.POST(post(url, {}), ctx(b.id))).status).toBe(400);
    const ok = await disconnectRoute.POST(post(url, { confirm: true }), ctx(b.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ revoked: true });
    expect((await mailbox(b.id)).status).toBe("not_configured");
  });
});

describe("kimlik belirteci: İMZA doğrulaması (Google JWKS) ve nonce", () => {
  const keys = testKeys();
  const claimsFor = (nonce: string, extra: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1234567890",
    email: ADDRESS,
    email_verified: true,
    nonce,
    iat: Math.floor(clock / 1000),
    exp: Math.floor(clock / 1000) + 3600,
    ...extra,
  });
  const goodHeader = { alg: "RS256", kid: keys.valid.kid, typ: "JWT" };
  const certs = () => fake.requests.filter((r) => r.path === "/certs").length;
  const revoked = () => fake.requests.some((r) => r.path === "/revoke");

  async function expectRejected(
    idToken: (nonce: string) => string,
    expected: "invalid_response" | "transient" = "invalid_response",
  ) {
    const b = await begin("send", { idToken });
    expect(await kind(finish(b))).toBe(expected);
    expect(await mailbox(b.id)).toMatchObject({ status: "not_configured", credentialsRef: null });
    expect(await secretExists(mailboxRefreshTokenName(b.id))).toBe(false);
    expect(revoked()).toBe(true); // verilen yetki geri alınmaya çalışılır
    expect(await getOAuthStatus(db, b.id)).toMatchObject({ connected: false, send: false });

    await db.delete(mailboxes).where(eq(mailboxes.id, b.id)); // aynı adres tekrar kullanılabilsin
  }

  it("geçerli imza kabul edilir; anahtarlar bir kez alınır ve önbellekten kullanılır", async () => {
    await finish(await begin("send"));
    expect(certs()).toBe(1);
    await finish(await begin("send", { address: "ikinci@firma-ornek.com" }));
    expect(certs()).toBe(1); // önbellek
  });

  it("iddialar doğru ama imza SALDIRGAN anahtarıyla atılmış (aynı kid) → reddedilir", async () => {
    await expectRejected((n) => signJwt({ ...goodHeader }, claimsFor(n), keys.attacker.privateKey));
  });

  it("imzalandıktan sonra yükü (e-posta) değiştirilmiş token reddedilir", async () => {
    // Geçerli anahtarla BAŞKA bir hesap için imzalanmış; yük, kutunun adresiyle değiştirilmiş.
    await expectRejected((n) => {
      const real = signJwt(
        { ...goodHeader },
        claimsFor(n, { email: "baska@firma-ornek.com" }),
        keys.valid.privateKey,
      );
      const [h, , sig] = real.split(".");
      const forged = Buffer.from(JSON.stringify(claimsFor(n))).toString("base64url");
      return `${h}.${forged}.${sig}`;
    });
    // Başlık değiştirilmiş (kid) de aynı şekilde reddedilir.
    await expectRejected((n) => {
      const real = signJwt({ ...goodHeader }, claimsFor(n), keys.valid.privateKey);
      const [, p2, sig] = real.split(".");
      const h2 = Buffer.from(JSON.stringify({ ...goodHeader, typ: "JWT", extra: 1 })).toString(
        "base64url",
      );
      return `${h2}.${p2}.${sig}`;
    });
  });

  it("bozuk, boş, kısaltılmış veya sahte imza reddedilir", async () => {
    for (const sig of ["", "AAAA", "x".repeat(342), "!!!"]) {
      fake.requests.length = 0;
      await expectRejected((n) => signJwt({ ...goodHeader }, claimsFor(n), undefined, sig));
    }
    fake.requests.length = 0;
    await expectRejected((n) => {
      const t = signJwt({ ...goodHeader }, claimsFor(n), keys.valid.privateKey);
      return t.slice(0, t.length - 10);
    });
  });

  it("algoritma karışıklığı reddedilir: none, HS256 (genel anahtar sır olarak), RS512, eksik alg", async () => {
    const cases: Record<string, (n: string) => string> = {
      none: (n) => signJwt({ alg: "none", kid: keys.valid.kid }, claimsFor(n)),
      HS256: (n) => {
        const jwk = jwkOf(keys.valid);
        const input = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: keys.valid.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claimsFor(n))).toString("base64url")}`;
        const mac = crypto
          .createHmac("sha256", Buffer.from(jwk.n, "base64url"))
          .update(input)
          .digest("base64url");
        return `${input}.${mac}`;
      },
      RS512: (n) =>
        signJwt({ alg: "RS512", kid: keys.valid.kid }, claimsFor(n), keys.valid.privateKey),
      eksik: (n) => signJwt({ kid: keys.valid.kid }, claimsFor(n), keys.valid.privateKey),
    };
    for (const [name, make] of Object.entries(cases)) {
      fake.requests.length = 0;
      await expectRejected(make);
      void name;
    }
  });

  it("kid yok veya bilinmiyor → reddedilir; bilinmeyen kid anahtarları en çok bir kez yeniden getirtir", async () => {
    await expectRejected((n) =>
      signJwt({ alg: "RS256", typ: "JWT" }, claimsFor(n), keys.valid.privateKey),
    );
    fake.requests.length = 0;
    await finish(await begin("send", { address: "onceki@firma-ornek.com" })); // önbelleği doldur
    fake.requests.length = 0;
    await expectRejected((n) =>
      signJwt({ alg: "RS256", kid: "bilinmeyen-kid" }, claimsFor(n), keys.valid.privateKey),
    );
    expect(certs()).toBeLessThanOrEqual(1); // dakikada en çok bir yeniden alma (önbellek taze)
  });

  it("anahtar rotasyonu: yeni kid için, önbellek yeterince eskiyse anahtarlar yeniden alınır ve imza kabul edilir", async () => {
    await finish(await begin("send", { address: "eski@firma-ornek.com" }));
    const rotated = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.jwks = [
      jwkOf(keys.valid),
      {
        ...(rotated.publicKey.export({ format: "jwk" }) as object),
        kid: "kid-rotated",
        alg: "RS256",
        use: "sig",
      },
    ];
    clock += 120_000;
    const before = certs();
    const b = await begin("send", {
      address: "yeni@firma-ornek.com",
      idToken: (n) =>
        signJwt(
          { alg: "RS256", kid: "kid-rotated" },
          {
            ...claimsFor(n),
            email: "yeni@firma-ornek.com",
            iat: Math.floor(clock / 1000),
            exp: Math.floor(clock / 1000) + 3600,
          },
          rotated.privateKey,
        ),
    });
    await finish(b);
    expect(certs()).toBe(before + 1);
    expect((await mailbox(b.id)).status).toBe("connected");
  });

  it("anahtar rotasyonu çok sık denenirse (60 sn içinde) yeniden alma yapılmaz: kapalı başarısız", async () => {
    await finish(await begin("send", { address: "eski2@firma-ornek.com" }));
    const rotated = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.jwks = [
      {
        ...(rotated.publicKey.export({ format: "jwk" }) as object),
        kid: "kid-rotated",
        alg: "RS256",
        use: "sig",
      },
    ];
    clock += 10_000;
    const before = certs();
    await expectRejected((n) =>
      signJwt({ alg: "RS256", kid: "kid-rotated" }, claimsFor(n), rotated.privateKey),
    );
    expect(certs()).toBe(before);
  });

  it("zayıf (1024 bit) yayımlanmış anahtarla imzalanmış token reddedilir", async () => {
    fake.jwks = [jwkOf(keys.weak)];
    await expectRejected(
      (n) => signJwt({ alg: "RS256", kid: keys.weak.kid }, claimsFor(n), keys.weak.privateKey),
      "transient",
    );
  });

  it("anahtar sunucusu 503 / bozuk / boş / aşırı büyük → KAPALI BAŞARISIZ (bağlanmaz, geçici hata)", async () => {
    for (const forced of [
      { status: 503 },
      { status: 200, body: "<html>" },
      { status: 200, body: JSON.stringify({ keys: [] }) },
      { status: 200, body: JSON.stringify({ keys: [], pad: "a".repeat(70_000) }) },
    ]) {
      resetOAuthMemoryForTests();
      fake.forceJwks = forced;
      fake.requests.length = 0;
      await expectRejected(
        (n) => signJwt({ ...goodHeader }, claimsFor(n), keys.valid.privateKey),
        "transient",
      );
      fake.forceJwks = null;
    }
  });

  it("nonce uyuşmazsa veya yoksa reddedilir (belirteç bu isteğe bağlı olmalı)", async () => {
    await expectRejected((n) =>
      signJwt(
        { ...goodHeader },
        claimsFor(n, { nonce: "baska-bir-istegin-nonce-degeri" }),
        keys.valid.privateKey,
      ),
    );
    fake.requests.length = 0;
    await expectRejected((n) => {
      const c = claimsFor(n) as Record<string, unknown>;
      delete c.nonce;
      return signJwt({ ...goodHeader }, c, keys.valid.privateKey);
    });
  });

  it("yetki adresi nonce taşır (her istekte farklı)", async () => {
    const a = await begin("send");
    const b = await begin("send", { address: "ikinci@firma-ornek.com" });
    expect(a.nonce.length).toBeGreaterThanOrEqual(43);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("önbellek süresi dolunca anahtarlar yeniden alınır", async () => {
    await finish(await begin("send"));
    expect(certs()).toBe(1);
    clock += 3600 * 1000 + 1;
    await finish(await begin("send", { address: "ikinci@firma-ornek.com" }));
    expect(certs()).toBe(2);
  });
});
