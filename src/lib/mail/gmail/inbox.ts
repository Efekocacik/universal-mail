import { and, eq, inArray, or } from "drizzle-orm";
import { LIVE_INBOX_READING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { mailboxes, messages } from "@/lib/db/schema";
import type { InboundEnvelope } from "../inbound/process";
import { MAX_RAW_BYTES, parseInbound } from "../inbound/parse";
import type { InboxFetchResult, InboxReader } from "../inbound/sync";
import { extractGmailAttestation } from "./attestation";
import {
  forgetAccessToken,
  getAccessToken,
  getOAuthDeps,
  OAuthError,
  requireScope,
  type OAuthDeps,
} from "./oauth";
import { GMAIL_API_BASE, parseRetryAfter } from "./provider";

/**
 * Gmail gelen kutusu okuyucusu (Aşama 15.5): yalnızca OKUMA (`users.messages.list/get`, `users.history.list`,
 * `users.getProfile`). Hiçbir değiştirme/silme/etiketleme çağrısı yoktur.
 *
 * KAPILAR (ağ isteğinden ÖNCE; biri kapalıysa HİÇBİR istek atılmaz):
 *  1. `LIVE_INBOX_READING_ENABLED` kapalıysa okuma yok.
 *  2. `gmail.readonly` izni zorunludur (gönderim izni okuma yerine geçmez).
 *  3. Kutu `gmail` türünde ve bağlı olmalı; ilk eşitlemede `getProfile` adresi kutunun adresiyle AYNI olmalı.
 *
 * EŞİTLEME VE VERİ GÜVENLİĞİ:
 *  - İmleç (`mailboxes.syncCursor`) JSON'dur: `{v,m,h,p,d,q}`. `m`: `backfill` (son 30 gün, sayfa sayfa) sonra
 *    `history` (artımlı). İmleç yalnızca eşitleme turu iletileri İŞLEDİKTEN sonra ilerler (sync.ts); herhangi bir
 *    hata imleci ilerletmez, aynı iletiler ham özetle "yinelenen" sayılır.
 *  - `q`: sayfadan fazla gelen ileti kimlikleri kuyruğu (`limit` aşılmaz, hiçbiri atlanmaz).
 *  - `historyId` süresi dolarsa (404) imleç sıfırlanır; sonraki tur 30 günü yeniden tarar (yinelenenler elenir).
 *  - Geçici hatalar (ağ, 429, 5xx, 401 sonrası) `GmailInboxError` fırlatır: kısmi sonuç DÖNMEZ.
 *  - Tek iletinin silinmiş olması (404) hata değildir, atlanır.
 *
 * VERİ AZALTMA: Yalnızca bizim giden iletilerimizle (Message-ID, DSN'deki orijinal kimlik veya konuşma kimliği)
 * ilişkili iletiler işlenir; ilgisiz gerçek posta HİÇ saklanmaz. Etiket süzgeci: INBOX olmalı; SENT/DRAFT/SPAM/
 * TRASH olanlar işlenmez. Tasdik çıkarımı `GMAIL_HEADER_TRUST_VERIFIED` kilidine bağlıdır (varsayılan KAPALI: hiçbir başlık tasdik
 *   üretmez, iletiler yalnızca inceleme için kaydedilir; bkz. attestation.ts ve docs/09-FAZ3-CANLI-DOGRULAMA.md).
 */

export type GmailInboxErrorCode =
  | "live_inbox_disabled"
  | "not_connected"
  | "scope_missing"
  | "reauthorization_required"
  | "account_mismatch"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "bad_response";

export class GmailInboxError extends Error {
  constructor(
    readonly code: GmailInboxErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "GmailInboxError";
  }
}

const PREFIX = "/gmail/v1/users/me";
const BACKFILL_QUERY = "newer_than:30d";
const MAX_LIST_BODY = 2_000_000;
const MAX_MESSAGE_BODY = 3_000_000;
const MAX_PAGE = 100;
const MAX_QUEUE = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
const ID_RE = /^[0-9a-zA-Z_-]{1,64}$/;
const HISTORY_RE = /^[0-9]{1,20}$/;
const EXCLUDED_LABELS = new Set(["SENT", "DRAFT", "SPAM", "TRASH"]);

interface CursorState {
  /** `backfill`: ilk tarama; `history`: artımlı. */
  m: "backfill" | "history";
  /** Backfill için başlangıç historyId'si; history için bir sonraki turun başlangıç historyId'si. */
  h: string;
  /** Sonraki sayfa belirteci (yoksa null). */
  p: string | null;
  /** Bu turun kaynağı tükendi mi? */
  d: boolean;
  /** Bekleyen ileti kimlikleri. */
  q: string[];
  /** History turunda görülen en yeni historyId (tur bitince `h` olur). */
  t: string | null;
}

export function encodeCursor(s: CursorState): string {
  return JSON.stringify({ v: 1, ...s });
}

/** Bozuk/yabancı imleç null döner (baştan eşitleme; yinelenenler elenir). */
export function decodeCursor(raw: string | null): CursorState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.v !== 1 || (o.m !== "backfill" && o.m !== "history")) return null;
    if (typeof o.h !== "string" || !HISTORY_RE.test(o.h)) return null;
    if (o.p !== null && (typeof o.p !== "string" || o.p.length === 0 || o.p.length > 2000))
      return null;
    if (typeof o.d !== "boolean") return null;
    if (o.t !== null && (typeof o.t !== "string" || !HISTORY_RE.test(o.t))) return null;
    if (!Array.isArray(o.q) || o.q.length > MAX_QUEUE) return null;
    if (!o.q.every((x) => typeof x === "string" && ID_RE.test(x))) return null;
    return {
      m: o.m,
      h: o.h,
      p: o.p as string | null,
      d: o.d,
      q: o.q as string[],
      t: o.t as string | null,
    };
  } catch {
    return null;
  }
}

export interface GmailInboxOptions {
  db: Db;
  oauth?: OAuthDeps;
  /** Yalnızca testte. */
  apiBase?: string;
  /** Yalnızca testte. */
  liveInboxEnabled?: () => boolean;
  /** Yalnızca testte: Gmail başlık güven kilidini geçersiz kılar. */
  headerTrustVerified?: () => boolean;
}

interface ApiResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

export class GmailInboxReader implements InboxReader {
  readonly id = "gmail" as const;
  private readonly oauth: OAuthDeps;
  private readonly apiBase: string;
  private readonly enabled: () => boolean;

  constructor(private readonly opts: GmailInboxOptions) {
    const testing = process.env.NODE_ENV === "test";
    if (
      (opts.apiBase !== undefined ||
        opts.liveInboxEnabled !== undefined ||
        opts.headerTrustVerified !== undefined) &&
      !testing
    ) {
      throw new Error("Gmail okuyucu ayarları yalnızca testte değiştirilebilir.");
    }
    this.apiBase = opts.apiBase ?? GMAIL_API_BASE;
    this.enabled = opts.liveInboxEnabled ?? (() => LIVE_INBOX_READING_ENABLED);
    this.oauth = opts.oauth ?? getOAuthDeps();
  }

  async fetch(mailboxId: number, cursor: string | null, limit: number): Promise<InboxFetchResult> {
    // 1. Kilit: kapalıysa HİÇBİR G/Ç yok.
    if (!this.enabled()) throw new GmailInboxError("live_inbox_disabled");
    const take = Math.max(1, Math.min(Math.floor(limit), 200));

    // 2. Kutu ve izin (ağ yok).
    const [mb] = await this.opts.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);
    if (!mb || mb.provider !== "gmail" || mb.status !== "connected" || !mb.address) {
      throw new GmailInboxError("not_connected");
    }
    try {
      await requireScope(this.opts.db, mailboxId, "read");
    } catch (e) {
      if (e instanceof OAuthError) {
        throw new GmailInboxError(e.kind === "scope_missing" ? "scope_missing" : "not_connected");
      }
      throw e;
    }

    // 3. Erişim belirteci.
    const ctx = { mailboxId, token: await this.token(mailboxId) };

    // 4. Durum: yoksa/bozuksa baştan (profil adresi doğrulanır).
    let st = decodeCursor(cursor);
    if (!st) {
      const prof = await this.get(ctx, `${PREFIX}/profile`, {}, MAX_LIST_BODY);
      const o = prof.json as { emailAddress?: unknown; historyId?: unknown } | null;
      if (
        prof.status !== 200 ||
        !o ||
        typeof o.emailAddress !== "string" ||
        typeof o.historyId !== "string" ||
        !HISTORY_RE.test(o.historyId)
      ) {
        throw new GmailInboxError("bad_response");
      }
      if (o.emailAddress.toLowerCase() !== mb.address.toLowerCase()) {
        throw new GmailInboxError("account_mismatch");
      }
      st = { m: "backfill", h: o.historyId, p: null, d: false, q: [], t: null };
    }

    // 5. Kuyruk yeterli değilse TEK sayfa daha iste.
    const queue = [...st.q];
    if (queue.length < take) {
      if (st.d) {
        st =
          st.m === "backfill"
            ? { m: "history", h: st.h, p: null, d: false, q: [], t: null } // tarama bitti: artımlıya geç
            : { ...st, p: null, d: false, t: null }; // yeni artımlı tur
      }
      if (st.m === "backfill") {
        const r = await this.get(
          ctx,
          `${PREFIX}/messages`,
          {
            labelIds: "INBOX",
            q: BACKFILL_QUERY,
            maxResults: String(Math.min(take, MAX_PAGE)),
            ...(st.p ? { pageToken: st.p } : {}),
          },
          MAX_LIST_BODY,
        );
        if (r.status !== 200) throw new GmailInboxError("bad_response");
        const o = r.json as { messages?: unknown; nextPageToken?: unknown } | null;
        const ids = readIds(o?.messages, (x) => (x as { id?: unknown } | null)?.id, true);
        if (!ids || !validToken(o?.nextPageToken)) throw new GmailInboxError("bad_response");
        queue.push(...ids);
        const next = typeof o?.nextPageToken === "string" ? o.nextPageToken : null;
        st = { ...st, p: next, d: next === null };
      } else {
        const r = await this.get(
          ctx,
          `${PREFIX}/history`,
          {
            startHistoryId: st.h,
            historyTypes: "messageAdded",
            labelId: "INBOX",
            maxResults: String(Math.min(take, MAX_PAGE)),
            ...(st.p ? { pageToken: st.p } : {}),
          },
          MAX_LIST_BODY,
        );
        if (r.status === 404) {
          // historyId süresi doldu: imleç sıfırlanır; sonraki tur son 30 günü yeniden tarar.
          return { items: [], nextCursor: null, resynced: true };
        }
        if (r.status !== 200) throw new GmailInboxError("bad_response");
        const o = r.json as {
          history?: unknown;
          nextPageToken?: unknown;
          historyId?: unknown;
        } | null;
        const newest =
          typeof o?.historyId === "string" && HISTORY_RE.test(o.historyId) ? o.historyId : null;
        if (!validToken(o?.nextPageToken) || (o?.historyId !== undefined && newest === null)) {
          throw new GmailInboxError("bad_response");
        }
        const ids = readHistoryIds(o?.history);
        if (!ids) throw new GmailInboxError("bad_response");
        queue.push(...ids);
        const next = typeof o?.nextPageToken === "string" ? o.nextPageToken : null;
        const t = newest ?? st.t;
        st =
          next === null
            ? { ...st, h: newerHistory(st.h, t), p: null, d: true, t: null } // tur bitti: imleç ilerler
            : { ...st, p: next, d: false, t };
      }
    }

    // 6. Kuyruktan en çok `take` iletiyi al; fazlası imlecin kuyruğunda kalır (hiçbiri atlanmaz).
    const unique = [...new Set(queue)];
    const batch = unique.slice(0, take);
    const rest = unique.slice(take);
    if (rest.length > MAX_QUEUE) throw new GmailInboxError("bad_response");

    const items: InboundEnvelope[] = [];
    const skipped = { unrelated: 0, oversize: 0, gone: 0, unparseable: 0 };
    for (const id of batch) {
      const env = await this.readMessage(ctx, mailboxId, mb.address, id, skipped);
      if (env) items.push(env);
    }
    return {
      items,
      nextCursor: encodeCursor({ ...st, q: rest }),
      skipped,
    };
  }

  /* ------------------------------------------------------------------------------------------ */

  private async readMessage(
    ctx: { mailboxId: number; token: string },
    mailboxId: number,
    address: string,
    id: string,
    skipped: { unrelated: number; oversize: number; gone: number; unparseable: number },
  ): Promise<InboundEnvelope | null> {
    const r = await this.get(ctx, `${PREFIX}/messages/${id}`, { format: "raw" }, MAX_MESSAGE_BODY);
    if (r.status === 404) {
      skipped.gone++;
      return null;
    }
    if (r.status !== 200) throw new GmailInboxError("bad_response");
    const o = r.json as {
      id?: unknown;
      threadId?: unknown;
      labelIds?: unknown;
      internalDate?: unknown;
      sizeEstimate?: unknown;
      raw?: unknown;
    } | null;
    if (
      !o ||
      o.id !== id ||
      typeof o.threadId !== "string" ||
      !ID_RE.test(o.threadId) ||
      typeof o.raw !== "string" ||
      !Array.isArray(o.labelIds) ||
      !o.labelIds.every((l) => typeof l === "string") ||
      typeof o.internalDate !== "string" ||
      !/^[0-9]{1,15}$/.test(o.internalDate)
    ) {
      throw new GmailInboxError("bad_response");
    }
    const labels = o.labelIds as string[];
    if (!labels.includes("INBOX") || labels.some((l) => EXCLUDED_LABELS.has(l))) {
      skipped.unrelated++;
      return null;
    }
    if (
      (typeof o.sizeEstimate === "number" && o.sizeEstimate > MAX_RAW_BYTES) ||
      o.raw.length > Math.ceil((MAX_RAW_BYTES * 4) / 3) + 8
    ) {
      skipped.oversize++;
      return null;
    }
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(o.raw)) throw new GmailInboxError("bad_response");
    const raw = Buffer.from(o.raw, "base64url").toString("utf8");

    // Veri azaltma: bizim giden iletilerimizle ilişkisi olmayan ileti saklanmaz.
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      skipped.unparseable++;
      return null;
    }
    const refs = [
      ...parsed.inReplyTo,
      ...parsed.references,
      ...(parsed.dsn?.originalMessageId ? [parsed.dsn.originalMessageId] : []),
      ...(parsed.arf?.originalMessageId ? [parsed.arf.originalMessageId] : []),
    ].slice(0, 20);
    const conds = [eq(messages.threadId, o.threadId)];
    if (refs.length > 0) conds.push(inArray(messages.rfcMessageId, refs));
    const related = await this.opts.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.direction, "out"), eq(messages.mailboxId, mailboxId), or(...conds)))
      .limit(1);
    if (related.length === 0) {
      skipped.unrelated++;
      return null;
    }

    const internal = Number(o.internalDate);
    return {
      mailboxId,
      raw,
      receivedAt: Number.isSafeInteger(internal) ? internal : Date.now(),
      attestation: extractGmailAttestation(raw, address, {
        ...(this.opts.headerTrustVerified
          ? { trustVerified: this.opts.headerTrustVerified() }
          : {}),
      }),
      threadId: o.threadId,
      providerMessageId: id,
    };
  }

  private async token(mailboxId: number): Promise<string> {
    try {
      return await getAccessToken(this.opts.db, this.oauth, mailboxId);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.kind === "reauthorization_required")
        throw new GmailInboxError("reauthorization_required");
      if (e.kind === "not_connected") throw new GmailInboxError("not_connected");
      throw new GmailInboxError("unavailable");
    }
  }

  /** GET (idempotent): 401'de belirteç BİR kez yenilenip istek BİR kez tekrarlanır. */
  private async get(
    ctx: { mailboxId: number; token: string },
    path: string,
    params: Record<string, string>,
    maxBody: number,
  ): Promise<ApiResponse> {
    let res = await this.once(ctx.token, path, params, maxBody);
    if (res.status === 401) {
      forgetAccessToken(ctx.mailboxId);
      ctx.token = await this.token(ctx.mailboxId);
      res = await this.once(ctx.token, path, params, maxBody);
      if (res.status === 401) throw new GmailInboxError("unauthorized");
    }
    const retry = parseRetryAfter(res.headers.get("retry-after"), this.oauth.now());
    if (res.status === 429) throw new GmailInboxError("rate_limited", retry);
    if (res.status === 403) {
      const e = (
        res.json as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null
      )?.error;
      const reason = String(e?.errors?.[0]?.reason ?? "");
      if (
        /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded/.test(reason) ||
        e?.status === "RESOURCE_EXHAUSTED"
      ) {
        throw new GmailInboxError("rate_limited", retry);
      }
      throw new GmailInboxError("forbidden");
    }
    if (res.status >= 500) throw new GmailInboxError("unavailable", retry);
    if (res.status !== 200 && res.status !== 404) throw new GmailInboxError("bad_response");
    return res;
  }

  private async once(
    token: string,
    path: string,
    params: Record<string, string>,
    maxBody: number,
  ): Promise<ApiResponse> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.oauth.fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new GmailInboxError("network");
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new GmailInboxError("network");
    }
    if (text.length > maxBody) throw new GmailInboxError("bad_response");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    if (res.status === 200 && json === null) throw new GmailInboxError("bad_response");
    return { status: res.status, json, headers: res.headers };
  }
}

/* -------------------------------------------------------------------------------------------- */

const validToken = (v: unknown) =>
  v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 2000);

/** `[{id}]` dizisi → kimlikler; biçim bozuksa null. `optional`: alan yoksa boş dizi. */
function readIds(v: unknown, pick: (x: unknown) => unknown, optional: boolean): string[] | null {
  if (v === undefined) return optional ? [] : null;
  if (!Array.isArray(v) || v.length > 1000) return null;
  const out: string[] = [];
  for (const x of v) {
    const id = pick(x);
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    out.push(id);
  }
  return out;
}

function readHistoryIds(history: unknown): string[] | null {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 1000) return null;
  const out: string[] = [];
  for (const rec of history) {
    const added = (rec as { messagesAdded?: unknown } | null)?.messagesAdded;
    if (added === undefined) continue;
    const ids = readIds(
      added,
      (x) => (x as { message?: { id?: unknown } } | null)?.message?.id,
      false,
    );
    if (!ids) return null;
    out.push(...ids);
  }
  return out;
}

/** Daha büyük (yeni) historyId; geriye gitmez. */
function newerHistory(current: string, candidate: string | null): string {
  if (!candidate) return current;
  return BigInt(candidate) > BigInt(current) ? candidate : current;
}
