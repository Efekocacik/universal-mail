import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes, settings } from "@/lib/db/schema";
import {
  getSecret,
  mailboxRefreshTokenName,
  OAUTH_CLIENT_SECRET,
  setSecret,
  deleteSecret,
} from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";

/**
 * Gmail OAuth 2.0 çekirdeği (Aşama 15.3): masaüstü uygulaması akışı, PKCE (S256), loopback yönlendirme.
 *
 * GÜVENLİK İLKELERİ
 *  - EN AZ YETKİ, KADEMELİ: varsayılan yalnızca `gmail.send` (+ `openid email`, hesabı doğrulamak için). Gelen kutusu
 *    okuma (`gmail.readonly`, kısıtlı kapsam) ayrı ve bilinçli bir yetkilendirmeyle eklenir. `gmail.modify`, tam
 *    erişim (`mail.google.com`) ve başka kapsamlar ASLA istenmez; yanıtta beklenmeyen kapsam varsa bağlantı REDDEDİLİR
 *    ve verilen yetki geri alınmaya çalışılır.
 *  - STATE tek kullanımlık, kutuya bağlı ve 10 dakikada sona erer; PKCE doğrulayıcısı yalnızca bellektedir.
 *  - HESAP DOĞRULAMA: kimlik belirteci (doğrudan Google'ın belirteç ucundan, TLS ile gelir) kontrol edilir; e-posta
 *    kutunun adresiyle aynı, doğrulanmış, hedef kitle bizim istemci kimliğimiz ve süresi dolmamış olmalıdır.
 *  - SAKLAMA: yenileme belirteci YALNIZCA şifreli gizli depoda; erişim belirteci YALNIZCA bellekte (sürece özgü).
 *    Veritabanına, denetim kaydına, günlüğe veya hata iletisine belirteç/sır/yanıt gövdesi yazılmaz.
 *  - AĞ: yalnızca Google'ın üç sabit ucu. Uçlar çevre değişkeniyle DEĞİŞTİRİLEMEZ; test için enjeksiyon yalnızca
 *    `NODE_ENV=test` iken kabul edilir. Hiçbir işlem kullanıcı eylemi olmadan ağa çıkmaz.
 *  - Gerçek gönderim `LIVE_SENDING_ENABLED=false` ile kapalıdır; bu modül iletiyi göndermez ve kapıyı açmaz.
 */

export const GMAIL_SCOPES = {
  send: "https://www.googleapis.com/auth/gmail.send",
  read: "https://www.googleapis.com/auth/gmail.readonly",
} as const;
const IDENTITY_SCOPES = ["openid", "email"] as const;
/** Yanıtta görülmesine izin verilen kapsamlar (e-posta kapsamı iki biçimde dönebilir). */
const ALLOWED_RESPONSE_SCOPES = new Set<string>([
  GMAIL_SCOPES.send,
  GMAIL_SCOPES.read,
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
]);

export type AccessLevel = "send" | "send_read";

export interface OAuthEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** Google'ın genel imza anahtarları (JWKS); kimlik belirteci imzası bununla doğrulanır. */
  jwks: string;
}
export const PRODUCTION_ENDPOINTS: OAuthEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
};

export interface OAuthDeps {
  fetch: typeof fetch;
  endpoints: OAuthEndpoints;
  now: () => number;
  random: (n: number) => Buffer;
}

export type OAuthErrorKind =
  | "client_not_configured"
  | "mailbox_not_found"
  | "not_gmail"
  | "invalid_status"
  | "invalid_state"
  | "expired"
  | "access_denied"
  | "scope_missing"
  | "scope_excess"
  | "account_mismatch"
  | "token_exchange_failed"
  | "invalid_response"
  | "no_refresh_token"
  | "not_connected"
  | "reauthorization_required"
  | "transient"
  | "unconfirmed";

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * Bağımlılıklar (üretimde sabit; yalnızca testte enjekte edilebilir)
 * ------------------------------------------------------------------------------------------------------------- */

let testOverride: Partial<OAuthDeps> | null = null;

/** YALNIZCA testler için. Üretimde (`NODE_ENV=production`) çağrılırsa hata verir. */
export function setOAuthDepsForTests(d: Partial<OAuthDeps> | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("Üretimde kullanılamaz.");
  testOverride = d;
}

export function getOAuthDeps(): OAuthDeps {
  return {
    fetch: (...a) => globalThis.fetch(...a),
    endpoints: PRODUCTION_ENDPOINTS,
    now: Date.now,
    random: crypto.randomBytes,
    ...(testOverride ?? {}),
  };
}

function assertEndpoints(e: OAuthEndpoints): void {
  const prod =
    e.auth === PRODUCTION_ENDPOINTS.auth &&
    e.token === PRODUCTION_ENDPOINTS.token &&
    e.revoke === PRODUCTION_ENDPOINTS.revoke &&
    e.jwks === PRODUCTION_ENDPOINTS.jwks;
  if (!prod && process.env.NODE_ENV !== "test") {
    throw new Error("OAuth uçları değiştirilemez.");
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * Bellek durumu (süreç içi; globalThis: Next.js yol işleyicileri arasında paylaşılır)
 * ------------------------------------------------------------------------------------------------------------- */

interface Pending {
  mailboxId: number;
  verifier: string;
  level: AccessLevel;
  redirectUri: string;
  /** OIDC nonce: kimlik belirteci bu yetkilendirme isteğine bağlanır. */
  nonce: string;
  expiresAt: number;
}
interface Jwks {
  keys: Map<string, crypto.KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}
interface Memory {
  jwks: Jwks | null;
  pending: Map<string, Pending>;
  access: Map<number, { token: string; expiresAt: number }>;
  inflight: Map<number, Promise<string>>;
}
const MEM_KEY = "__umGmailOAuth";
function mem(): Memory {
  const g = globalThis as Record<string, unknown>;
  return (g[MEM_KEY] ??= {
    jwks: null,
    pending: new Map(),
    access: new Map(),
    inflight: new Map(),
  }) as Memory;
}
/** Önbellekteki erişim belirtecini unutur (401 sonrası kontrollü yenileme için). */
export function forgetAccessToken(mailboxId: number): void {
  mem().access.delete(mailboxId);
}

export function resetOAuthMemoryForTests(): void {
  const m = mem();
  m.pending.clear();
  m.access.clear();
  m.inflight.clear();
  m.jwks = null;
}

export const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 10;
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 15_000;
const SKEW_MS = 60_000;

const GRANTS_KEY = "mail.gmailGrants";
const b64url = (b: Buffer) => b.toString("base64url");

/* ---------------------------------------------------------------------------------------------------------------
 * Yardımcılar
 * ------------------------------------------------------------------------------------------------------------- */

const CLIENT_ID_RE = /^[0-9]{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;

async function clientCredentials(db: Db): Promise<{ clientId: string; clientSecret: string }> {
  const { clientId } = await getSetting(db, "mail.gmailOAuth");
  const clientSecret = await getSecret(OAUTH_CLIENT_SECRET);
  if (!CLIENT_ID_RE.test(clientId) || !clientSecret) {
    throw new OAuthError(
      "client_not_configured",
      "Google OAuth istemci kimliği ve sırrı tanımlı değil.",
    );
  }
  return { clientId, clientSecret };
}

async function gmailMailbox(db: Db, id: number) {
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
  if (!mb) throw new OAuthError("mailbox_not_found", "Posta kutusu bulunamadı.");
  if (mb.provider !== "gmail")
    throw new OAuthError("not_gmail", "Bu işlem yalnızca Gmail kutuları içindir.");
  return mb;
}

function scopesFor(level: AccessLevel): string {
  return [
    ...IDENTITY_SCOPES,
    GMAIL_SCOPES.send,
    ...(level === "send_read" ? [GMAIL_SCOPES.read] : []),
  ].join(" ");
}

/** Yalnızca belirtilen gövde sınırına kadar okur; sınırı aşarsa null döner. */
async function readCapped(res: Response): Promise<string | null> {
  const text = await res.text();
  return text.length > MAX_BODY ? null : text;
}

async function postForm(
  deps: OAuthDeps,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; json: unknown } | "network"> {
  assertEndpoints(deps.endpoints);
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    const text = await readCapped(res);
    if (text === null) return { status: res.status, json: null };
    try {
      return { status: res.status, json: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, json: null };
    }
  } catch {
    return "network";
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(10).max(4096),
  expires_in: z.number().int().min(60).max(86_400),
  token_type: z.string(),
  scope: z.string().max(2000).optional(),
  refresh_token: z.string().min(10).max(2048).optional(),
  id_token: z.string().max(8192).optional(),
});

const errorCode = (j: unknown): string =>
  j && typeof j === "object" && typeof (j as { error?: unknown }).error === "string"
    ? (j as { error: string }).error.slice(0, 64)
    : "";

/* ---------------------------------------------------------------------------------------------------------------
 * 1. Yetkilendirme başlatma
 * ------------------------------------------------------------------------------------------------------------- */

/** Yalnızca yerel adres ve kendi geri çağrı yolumuz; harici yönlendirme olamaz. */
export function loopbackRedirectUri(requestUrl: string): string {
  const u = new URL(requestUrl);
  const host = u.hostname === "localhost" ? "localhost" : "127.0.0.1";
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new OAuthError("invalid_state", "Yönlendirme adresi yerel olmalıdır.");
  }
  return `http://${host}:${u.port || "80"}/api/oauth/gmail/callback`;
}

export async function startAuthorization(
  db: Db,
  deps: OAuthDeps,
  input: { mailboxId: number; level: AccessLevel; redirectUri: string },
): Promise<{ authUrl: string; expiresAt: number }> {
  assertEndpoints(deps.endpoints);
  const mb = await gmailMailbox(db, input.mailboxId);
  if (mb.status === "disabled")
    throw new OAuthError("invalid_status", "Devre dışı kutu bağlanamaz.");
  if (!mb.address) throw new OAuthError("invalid_status", "Kutunun adresi yok.");
  const { clientId } = await clientCredentials(db);

  const m = mem();
  const now = deps.now();
  for (const [k, v] of m.pending) if (v.expiresAt <= now) m.pending.delete(k);
  if (m.pending.size >= MAX_PENDING) {
    // En eskiyi at (bellek sınırı).
    const oldest = [...m.pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) m.pending.delete(oldest[0]);
  }
  const state = b64url(deps.random(32));
  const verifier = b64url(deps.random(32));
  const nonce = b64url(deps.random(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const expiresAt = now + PENDING_TTL_MS;
  m.pending.set(state, {
    mailboxId: mb.id,
    verifier,
    level: input.level,
    redirectUri: input.redirectUri,
    nonce,
    expiresAt,
  });

  const url = new URL(deps.endpoints.auth);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopesFor(input.level));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("login_hint", mb.address);
  return { authUrl: url.toString(), expiresAt };
}

/* ---------------------------------------------------------------------------------------------------------------
 * 2. Geri çağrı: state doğrulama, kod değişimi, hesap ve kapsam denetimi, saklama
 * ------------------------------------------------------------------------------------------------------------- */

function grantedFrom(scope: string | undefined): { all: string[]; send: boolean; read: boolean } {
  const all = (scope ?? "").split(/\s+/).filter(Boolean);
  return { all, send: all.includes(GMAIL_SCOPES.send), read: all.includes(GMAIL_SCOPES.read) };
}

const JWKS_MIN_REFETCH_MS = 60_000;
const JWKS_DEFAULT_TTL_MS = 3_600_000;
const JWKS_MAX_TTL_MS = 24 * 3_600_000;
const MIN_RSA_BITS = 2048;

const jwkSchema = z.object({
  kid: z.string().min(1).max(128),
  kty: z.literal("RSA"),
  n: z.string().min(300).max(1400),
  e: z.string().min(1).max(16),
  alg: z.string().optional(),
  use: z.string().optional(),
});
const jwksSchema = z.object({ keys: z.array(z.unknown()).max(20) });

/** Google'ın genel imza anahtarlarını alır (önbellekli). Alınamaz/geçersizse `null` döner. */
async function loadJwks(deps: OAuthDeps, force: boolean): Promise<Jwks | null> {
  assertEndpoints(deps.endpoints);
  const m = mem();
  const now = deps.now();
  if (!force && m.jwks && m.jwks.expiresAt > now) return m.jwks;
  // Anahtar bilinmiyorsa en sık dakikada bir yeniden alınır (saldırgan kimliğiyle sunucuyu yormayı önler).
  if (force && m.jwks && now - m.jwks.fetchedAt < JWKS_MIN_REFETCH_MS) return m.jwks;
  try {
    const res = await deps.fetch(deps.endpoints.jwks, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    if (res.status !== 200) return null;
    const text = await readCapped(res);
    if (text === null) return null;
    const parsed = jwksSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const keys = new Map<string, crypto.KeyObject>();
    for (const raw of parsed.data.keys) {
      const jwk = jwkSchema.safeParse(raw);
      if (!jwk.success) continue;
      const k = jwk.data;
      if ((k.alg && k.alg !== "RS256") || (k.use && k.use !== "sig")) continue;
      try {
        const key = crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue; // zayıf anahtar
        keys.set(k.kid, key);
      } catch {
        /* geçersiz anahtar yok sayılır */
      }
    }
    if (keys.size === 0) return null;
    const maxAge = /max-age=(\d{1,8})/.exec(res.headers.get("cache-control") ?? "")?.[1];
    const ttl = Math.min(
      JWKS_MAX_TTL_MS,
      Math.max(JWKS_MIN_REFETCH_MS, maxAge ? Number(maxAge) * 1000 : JWKS_DEFAULT_TTL_MS),
    );
    m.jwks = { keys, fetchedAt: now, expiresAt: now + ttl };
    return m.jwks;
  } catch {
    return null;
  }
}

/**
 * Kimlik belirtecinin İMZASINI Google'ın JWKS anahtarlarıyla doğrular, sonra iddiaları denetler.
 *  - Algoritma YALNIZCA RS256 (`none`, HS256 ve algoritma karışıklığı reddedilir); `kid` zorunlu.
 *  - Anahtar en az 2048 bit RSA olmalıdır.
 *  - İddialar: yayıncı, hedef kitle (istemci kimliğimiz), süre, `nonce` (bu isteğe bağlı), doğrulanmış e-posta.
 * Anahtarlar alınamazsa (ağ/biçim) KAPALI BAŞARISIZ olur: belirteç güvenilmez sayılır.
 */
async function verifyIdToken(
  deps: OAuthDeps,
  idToken: string,
  expect: { clientId: string; nonce: string },
): Promise<Record<string, unknown>> {
  const bad = () => new OAuthError("invalid_response", "Hesap kimliği doğrulanamadı.");
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw bad();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw bad();
  }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw bad();
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0)
    throw bad();

  let jwks = await loadJwks(deps, false);
  if (!jwks)
    throw new OAuthError("transient", "Google imza anahtarlarına ulaşılamadı; yeniden deneyin.");
  let key = jwks.keys.get(header.kid);
  if (!key) {
    jwks = (await loadJwks(deps, true)) ?? jwks;
    key = jwks.keys.get(header.kid);
  }
  if (!key) throw bad();
  const signature = Buffer.from(parts[2]!, "base64url");
  const okSig = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature,
  );
  if (!okSig) throw bad();

  const now = deps.now();
  const issOk =
    claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const expOk = typeof claims.exp === "number" && claims.exp * 1000 > now;
  const iatOk = typeof claims.iat !== "number" || claims.iat * 1000 <= now + 5 * 60_000;
  if (
    !issOk ||
    claims.aud !== expect.clientId ||
    !expOk ||
    !iatOk ||
    claims.nonce !== expect.nonce ||
    claims.email_verified !== true ||
    typeof claims.email !== "string"
  ) {
    throw bad();
  }
  return claims;
}

/** En iyi çaba: verilen yetkiyi Google'da iptal eder. Hata sessizce yutulur; belirteç hiçbir yere yazılmaz. */
async function revokeToken(deps: OAuthDeps, token: string): Promise<boolean> {
  const r = await postForm(deps, deps.endpoints.revoke, { token });
  return r !== "network" && r.status >= 200 && r.status < 300;
}

export interface CallbackResult {
  mailboxId: number;
  send: boolean;
  read: boolean;
  /** İstenen okuma izni verilmedi (kullanıcı ekranda kapattı); kutu yalnızca gönderim izniyle bağlandı. */
  readRequestedButDenied: boolean;
}

export async function completeAuthorization(
  db: Db,
  deps: OAuthDeps,
  input: { state: string | null; code: string | null; error: string | null },
): Promise<CallbackResult> {
  assertEndpoints(deps.endpoints);
  const m = mem();
  const now = deps.now();
  const state = input.state ?? "";
  const p = state.length > 0 && state.length <= 128 ? m.pending.get(state) : undefined;
  if (!p)
    throw new OAuthError("invalid_state", "Yetkilendirme isteği geçersiz veya zaten kullanılmış.");
  m.pending.delete(state); // tek kullanımlık: her sonuçta tüketilir
  if (p.expiresAt <= now)
    throw new OAuthError("expired", "Yetkilendirme isteğinin süresi doldu; yeniden başlatın.");
  if (input.error) {
    throw input.error === "access_denied"
      ? new OAuthError("access_denied", "İzin verilmedi.")
      : new OAuthError("token_exchange_failed", "Google yetkilendirmeyi tamamlayamadı.");
  }
  const code = input.code ?? "";
  if (code.length < 4 || code.length > 2048)
    throw new OAuthError("invalid_response", "Geçersiz yetkilendirme kodu.");

  const mb = await gmailMailbox(db, p.mailboxId);
  if (mb.status === "disabled" || !mb.address)
    throw new OAuthError("invalid_status", "Kutu bu işlem için uygun değil.");
  const { clientId, clientSecret } = await clientCredentials(db);

  const res = await postForm(deps, deps.endpoints.token, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  if (res === "network" || res.status >= 500)
    throw new OAuthError("transient", "Google'a ulaşılamadı; daha sonra yeniden deneyin.");
  if (res.status !== 200)
    throw new OAuthError("token_exchange_failed", "Google yetkilendirme kodunu kabul etmedi.");
  const parsed = tokenSchema.safeParse(res.json);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new OAuthError("invalid_response", "Google'dan beklenmeyen yanıt alındı.");
  }
  const t = parsed.data;
  const dangling = t.refresh_token ?? t.access_token;

  // Kapsam denetimi (en az yetki): gerekli kapsam var, beklenmeyen kapsam yok.
  const granted = grantedFrom(t.scope);
  if (granted.all.some((s) => !ALLOWED_RESPONSE_SCOPES.has(s))) {
    await revokeToken(deps, dangling);
    throw new OAuthError("scope_excess", "Beklenmeyen izinler verildi; bağlantı reddedildi.");
  }
  if (!granted.send) {
    await revokeToken(deps, dangling);
    throw new OAuthError("scope_missing", "Gönderim izni verilmedi.");
  }

  // Hesap doğrulama: kimlik belirteci (İMZA Google'ın JWKS anahtarlarıyla doğrulanır, sonra iddialar).
  let claims: Record<string, unknown>;
  try {
    if (!t.id_token) throw new OAuthError("invalid_response", "Hesap kimliği doğrulanamadı.");
    claims = await verifyIdToken(deps, t.id_token, { clientId, nonce: p.nonce });
  } catch (e) {
    await revokeToken(deps, dangling);
    throw e;
  }
  const email = (claims.email as string).toLowerCase();
  if (email !== mb.address.toLowerCase()) {
    await revokeToken(deps, dangling);
    throw new OAuthError(
      "account_mismatch",
      "Giriş yapılan Google hesabı kutunun adresiyle aynı değil.",
    );
  }
  if (!t.refresh_token) {
    await revokeToken(deps, t.access_token);
    throw new OAuthError("no_refresh_token", "Google kalıcı yetki vermedi; yeniden deneyin.");
  }

  // Saklama: yenileme belirteci YALNIZCA şifreli depoda; veritabanında yalnızca adı ve izin özeti.
  const secretName = mailboxRefreshTokenName(mb.id);
  await setSecret(secretName, t.refresh_token);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(mailboxes)
        .set({
          status: "connected",
          credentialsRef: secretName,
          connectedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(mailboxes.id, mb.id));
      const grants = await getSetting(tx, "mail.gmailGrants");
      const next = {
        ...grants,
        [String(mb.id)]: { send: granted.send, read: granted.read, at: now },
      };
      await tx
        .insert(settings)
        .values({ key: GRANTS_KEY, value: next, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } });
      await audit(
        tx,
        mb.status === "connected" ? "mailbox.oauth_upgraded" : "mailbox.oauth_connected",
        "mailbox",
        mb.id,
        { send: granted.send, read: granted.read },
        now,
      );
    });
  } catch (e) {
    await deleteSecret(secretName);
    throw e;
  }
  m.access.set(mb.id, { token: t.access_token, expiresAt: now + t.expires_in * 1000 });
  return {
    mailboxId: mb.id,
    send: granted.send,
    read: granted.read,
    readRequestedButDenied: p.level === "send_read" && !granted.read,
  };
}

/* ---------------------------------------------------------------------------------------------------------------
 * 3. Erişim belirteci (bellek önbelleği + yenileme)
 * ------------------------------------------------------------------------------------------------------------- */

async function markReauthRequired(db: Db, mailboxId: number, now: number): Promise<void> {
  await deleteSecret(mailboxRefreshTokenName(mailboxId));
  mem().access.delete(mailboxId);
  await db.transaction(async (tx) => {
    await tx
      .update(mailboxes)
      .set({ status: "error", lastError: "reauthorization_required", updatedAt: now })
      .where(eq(mailboxes.id, mailboxId));
    const grants = await getSetting(tx, "mail.gmailGrants");
    const { [String(mailboxId)]: _gone, ...rest } = grants;
    void _gone;
    await tx
      .insert(settings)
      .values({ key: GRANTS_KEY, value: rest, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: rest, updatedAt: now } });
    await audit(tx, "mailbox.oauth_reauth_required", "mailbox", mailboxId, undefined, now);
  });
}

async function refreshAccessToken(db: Db, deps: OAuthDeps, mailboxId: number): Promise<string> {
  const mb = await gmailMailbox(db, mailboxId);
  if (mb.status === "error")
    throw new OAuthError("reauthorization_required", "Yeniden yetkilendirme gerekli.");
  if (mb.status !== "connected") throw new OAuthError("not_connected", "Kutu bağlı değil.");
  const name = mailboxRefreshTokenName(mailboxId);
  const refresh = await getSecret(name);
  const now = deps.now();
  if (!refresh) {
    await markReauthRequired(db, mailboxId, now);
    throw new OAuthError("reauthorization_required", "Yeniden yetkilendirme gerekli.");
  }
  const { clientId, clientSecret } = await clientCredentials(db);
  const res = await postForm(deps, deps.endpoints.token, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (res === "network" || res.status >= 500 || res.status === 429) {
    throw new OAuthError("transient", "Google'a ulaşılamadı; daha sonra yeniden deneyin.");
  }
  if (res.status >= 400) {
    const code = errorCode(res.json);
    if (["invalid_grant", "invalid_client", "unauthorized_client"].includes(code)) {
      await markReauthRequired(db, mailboxId, now);
      throw new OAuthError("reauthorization_required", "Yeniden yetkilendirme gerekli.");
    }
    throw new OAuthError("token_exchange_failed", "Erişim belirteci yenilenemedi.");
  }
  const parsed = tokenSchema.safeParse(res.json);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new OAuthError("invalid_response", "Google'dan beklenmeyen yanıt alındı.");
  }
  const t = parsed.data;
  if (t.refresh_token && t.refresh_token !== refresh) await setSecret(name, t.refresh_token);
  mem().access.set(mailboxId, { token: t.access_token, expiresAt: now + t.expires_in * 1000 });
  return t.access_token;
}

/** Geçerli bir erişim belirteci döndürür (gerekirse yeniler). Aynı kutu için eşzamanlı yenilemeler tek istekte birleşir. */
export async function getAccessToken(db: Db, deps: OAuthDeps, mailboxId: number): Promise<string> {
  const m = mem();
  const cached = m.access.get(mailboxId);
  if (cached && cached.expiresAt - deps.now() > SKEW_MS) return cached.token;
  const running = m.inflight.get(mailboxId);
  if (running) return running;
  const p = refreshAccessToken(db, deps, mailboxId).finally(() => m.inflight.delete(mailboxId));
  m.inflight.set(mailboxId, p);
  return p;
}

/* ---------------------------------------------------------------------------------------------------------------
 * 4. İzinler, durum, bağlantıyı kesme
 * ------------------------------------------------------------------------------------------------------------- */

export interface OAuthStatus {
  connected: boolean;
  send: boolean;
  read: boolean;
  reauthorizationRequired: boolean;
}

export async function getOAuthStatus(db: Db, mailboxId: number): Promise<OAuthStatus> {
  const mb = await gmailMailbox(db, mailboxId);
  const g = (await getSetting(db, "mail.gmailGrants"))[String(mailboxId)];
  const connected = mb.status === "connected";
  return {
    connected,
    send: connected && !!g?.send,
    read: connected && !!g?.read,
    reauthorizationRequired: mb.status === "error" && mb.lastError === "reauthorization_required",
  };
}

/** Bir işlev için gereken izin yoksa `scope_missing` fırlatır (gelen kutusu okuma ayrı izindir). */
export async function requireScope(
  db: Db,
  mailboxId: number,
  scope: "send" | "read",
): Promise<void> {
  const s = await getOAuthStatus(db, mailboxId);
  if (!s.connected) throw new OAuthError("not_connected", "Kutu bağlı değil.");
  if (!s[scope]) {
    throw new OAuthError(
      "scope_missing",
      scope === "send" ? "Gönderim izni yok." : "Gelen kutusu okuma izni yok.",
    );
  }
}

/** Kullanıcı eylemiyle bağlantıyı keser: yetkiyi Google'da iptal etmeyi dener, yerel kayıtları temizler. */
export async function disconnectGmail(
  db: Db,
  deps: OAuthDeps,
  mailboxId: number,
  input: { confirm: boolean },
): Promise<{ revoked: boolean }> {
  if (input.confirm !== true) throw new OAuthError("unconfirmed", "Açık onay gerekli.");
  const mb = await gmailMailbox(db, mailboxId);
  if (mb.status !== "connected" && mb.status !== "error") {
    throw new OAuthError("not_connected", "Kutu bağlı değil.");
  }
  const name = mailboxRefreshTokenName(mailboxId);
  const token = await getSecret(name);
  const revoked = token ? await revokeToken(deps, token) : false;
  await deleteSecret(name);
  const m = mem();
  m.access.delete(mailboxId);
  m.inflight.delete(mailboxId);
  const now = deps.now();
  await db.transaction(async (tx) => {
    await tx
      .update(mailboxes)
      .set({
        status: "not_configured",
        credentialsRef: null,
        connectedAt: null,
        lastError: null,
        syncCursor: null,
        updatedAt: now,
      })
      .where(eq(mailboxes.id, mailboxId));
    const grants = await getSetting(tx, "mail.gmailGrants");
    const { [String(mailboxId)]: _gone, ...rest } = grants;
    void _gone;
    await tx
      .insert(settings)
      .values({ key: GRANTS_KEY, value: rest, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: rest, updatedAt: now } });
    await audit(tx, "mailbox.oauth_disconnected", "mailbox", mailboxId, { revoked }, now);
  });
  return { revoked };
}
