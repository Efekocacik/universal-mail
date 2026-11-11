import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthDeps } from "@/lib/mail/gmail/oauth";

/**
 * Yerel SAHTE Google OAuth sunucusu (yalnızca testler): 127.0.0.1 üzerinde rastgele portta dinler. Gerçek Google'a
 * HİÇBİR istek atılmaz; `deps.fetch` sarmalayıcısı 127.0.0.1 dışındaki her adresi reddeder.
 * Kimlik belirteçleri GERÇEK RS256 imzasıyla üretilir ve `/certs` (JWKS) ucundan yayımlanır; böylece imza
 * doğrulaması (geçerli, sahte, değiştirilmiş, algoritma karışıklığı, bilinmeyen anahtar...) uçtan uca sınanır.
 */

export interface TestKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

let cached: { valid: TestKey; attacker: TestKey; weak: TestKey } | null = null;

function gen(bits: number, kid: string): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits });
  return { kid, privateKey, publicKey };
}

/** Anahtarlar bir kez üretilir (RSA üretimi pahalıdır). `attacker` AYNI `kid`i taşır: anahtar karışıklığı denemesi. */
export function testKeys() {
  cached ??= {
    valid: gen(2048, "kid-valid"),
    attacker: gen(2048, "kid-valid"),
    weak: gen(1024, "kid-weak"),
  };
  return cached;
}

export const jwkOf = (k: TestKey) => ({
  ...(k.publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string }),
  kid: k.kid,
  alg: "RS256",
  use: "sig",
});

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Üç parçalı JWT üretir; `key` verilirse RS256 ile imzalar, verilmezse `rawSignature` (varsayılan boş) kullanılır. */
export function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key?: crypto.KeyObject,
  rawSignature = "",
): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = key
    ? crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")
    : rawSignature;
  return `${input}.${sig}`;
}

export interface IssuedCode {
  challenge: string;
  redirectUri: string;
  clientId: string;
  email: string;
  scope: string;
  /** Yetki adresindeki nonce (verilmezse kimlik belirtecine nonce konmaz). */
  nonce?: string;
  /** Yanıtı değiştirmek için (ör. refresh_token yok, fazladan kapsam...). */
  override?: Record<string, unknown>;
  /** Varsayılan kimlik belirtecinin iddialarını değiştirmek için. */
  claims?: Record<string, unknown>;
  /** Kimlik belirtecini tamamen kendi üretimiyle değiştirmek için. */
  idToken?: string;
  omit?: string[];
}

export interface FakeOAuth {
  base: string;
  deps: (now?: () => number) => OAuthDeps;
  issue(code: string, c: IssuedCode): void;
  requests: { path: string; params: Record<string, string> }[];
  expected: { clientId: string; clientSecret: string };
  forceToken: { status: number; body?: string } | null;
  forceRevokeStatus: number | null;
  /** /certs yanıtını zorla (ör. 503 veya bozuk gövde). */
  forceJwks: { status: number; body?: string } | null;
  /** Yayımlanan anahtarlar (varsayılan: yalnızca geçerli anahtar). */
  jwks: object[];
  validRefresh: Set<string>;
  accessCounter: { n: number };
  close(): Promise<void>;
}

export async function startFakeOAuth(expected: {
  clientId: string;
  clientSecret: string;
}): Promise<FakeOAuth> {
  const keys = testKeys();
  /** Sunucunun saati, testin saatiyle aynıdır (iat/exp tutarlı olsun). */
  let clockFn: () => number = Date.now;
  const codes = new Map<string, IssuedCode>();
  const state: FakeOAuth = {
    base: "",
    expected,
    requests: [],
    forceToken: null,
    forceRevokeStatus: null,
    forceJwks: null,
    jwks: [jwkOf(keys.valid)],
    validRefresh: new Set(),
    accessCounter: { n: 0 },
    issue: (code, c) => void codes.set(code, c),
    deps: () => {
      throw new Error("sunucu başlamadı");
    },
    close: async () => undefined,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const params = Object.fromEntries(
        new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
      );
      const path = req.url ?? "";
      state.requests.push({ path, params });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (path === "/certs") {
        if (state.forceJwks) return send(state.forceJwks.status, state.forceJwks.body ?? "{}");
        return send(200, { keys: state.jwks }, { "Cache-Control": "public, max-age=3600" });
      }
      if (path === "/revoke") return send(state.forceRevokeStatus ?? 200, {});
      if (path !== "/token") return send(404, {});
      if (state.forceToken) return send(state.forceToken.status, state.forceToken.body ?? "{}");
      if (
        params.client_id !== expected.clientId ||
        params.client_secret !== expected.clientSecret
      ) {
        return send(401, { error: "invalid_client" });
      }
      if (params.grant_type === "refresh_token") {
        if (!params.refresh_token || !state.validRefresh.has(params.refresh_token)) {
          return send(400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          });
        }
        state.accessCounter.n++;
        return send(200, {
          access_token: `ya29.fake-access-${state.accessCounter.n}-xxxxxxxx`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (params.grant_type !== "authorization_code")
        return send(400, { error: "unsupported_grant_type" });
      const issued = codes.get(params.code ?? "");
      if (!issued) return send(400, { error: "invalid_grant" });
      codes.delete(params.code!); // tek kullanımlık kod
      const verifierOk =
        !!params.code_verifier &&
        crypto.createHash("sha256").update(params.code_verifier).digest("base64url") ===
          issued.challenge;
      if (
        !verifierOk ||
        params.redirect_uri !== issued.redirectUri ||
        issued.clientId !== expected.clientId
      ) {
        return send(400, {
          error: "invalid_grant",
          error_description: "SECRET-DETAIL-should-never-leak",
        });
      }
      state.accessCounter.n++;
      const refresh = `1//fake-refresh-${state.accessCounter.n}-yyyyyyyy`;
      state.validRefresh.add(refresh);
      const idToken =
        issued.idToken ??
        signJwt(
          { alg: "RS256", kid: keys.valid.kid, typ: "JWT" },
          {
            iss: "https://accounts.google.com",
            aud: expected.clientId,
            sub: "1234567890",
            email: issued.email,
            email_verified: true,
            ...(issued.nonce !== undefined ? { nonce: issued.nonce } : {}),
            iat: Math.floor(clockFn() / 1000),
            exp: Math.floor(clockFn() / 1000) + 3600,
            ...(issued.claims ?? {}),
          },
          keys.valid.privateKey,
        );
      const body: Record<string, unknown> = {
        access_token: `ya29.fake-access-${state.accessCounter.n}-xxxxxxxx`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: issued.scope,
        refresh_token: refresh,
        id_token: idToken,
        ...(issued.override ?? {}),
      };
      for (const k of issued.omit ?? []) delete body[k];
      return send(200, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  state.base = `http://127.0.0.1:${port}`;
  state.deps = (now = Date.now) => {
    clockFn = now;
    return {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
        if (u.hostname !== "127.0.0.1")
          throw new Error(`Testte dış ağ isteği yasak: ${u.hostname}`);
        return fetch(u, init);
      }) as typeof fetch,
      endpoints: {
        auth: `${state.base}/auth`,
        token: `${state.base}/token`,
        revoke: `${state.base}/revoke`,
        jwks: `${state.base}/certs`,
      },
      now,
      random: crypto.randomBytes,
    };
  };
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}
