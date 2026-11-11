import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Yerel SAHTE Gmail gelen kutusu API'si (yalnızca testler): profile, messages.list/get, history.list.
 * 127.0.0.1'de rastgele portta dinler; gerçek Google'a HİÇBİR istek atılmaz.
 */

export interface FakeMsg {
  id: string;
  threadId: string;
  labels: string[];
  internalDate: number;
  /** Ham ileti metni (UTF-8). */
  raw: string;
  /** Yanıtı bozmak için (test). */
  override?: Record<string, unknown>;
}

export interface Fault {
  /** Yola içerir (ör. "/messages/m3", "/history", "/profile"). */
  match: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  drop?: boolean;
  /** Kaç kez uygulanır (varsayılan 1). */
  times?: number;
}

export interface InboxRequest {
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  method: string;
}

export interface FakeGmailInbox {
  base: string;
  address: string;
  requests: InboxRequest[];
  messages: FakeMsg[];
  /** Geçmiş kayıtları: her biri bir historyId ve eklenen ileti kimlikleri. */
  history: { id: number; added: string[] }[];
  historyId: number;
  /** En eski geçerli historyId; daha eskisi 404. */
  oldestHistory: number;
  faults: Fault[];
  profileAddress: string | null;
  /** Yeni ileti ekler (geçmişe de yazar). */
  add(
    m: Omit<FakeMsg, "id" | "threadId" | "internalDate"> &
      Partial<Pick<FakeMsg, "id" | "threadId" | "internalDate">>,
  ): FakeMsg;
  close(): Promise<void>;
}

export async function startFakeGmailInbox(address: string): Promise<FakeGmailInbox> {
  const st: FakeGmailInbox = {
    base: "",
    address,
    requests: [],
    messages: [],
    history: [],
    historyId: 1000,
    oldestHistory: 1000,
    faults: [],
    profileAddress: address,
    add(m) {
      const n = st.messages.length + 1;
      st.historyId += 1;
      const full: FakeMsg = {
        id: m.id ?? `m${n}a`,
        threadId: m.threadId ?? `t${n}a`,
        internalDate: m.internalDate ?? 1_793_000_000_000 + n,
        labels: m.labels,
        raw: m.raw,
        ...(m.override ? { override: m.override } : {}),
      };
      st.messages.push(full);
      st.history.push({ id: st.historyId, added: [full.id] });
      return full;
    },
    close: async () => undefined,
  };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const query = Object.fromEntries(url.searchParams.entries());
    st.requests.push({
      path: url.pathname,
      query,
      authorization: req.headers.authorization,
      method: req.method ?? "",
    });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: { code: 405 } });

    const fi = st.faults.findIndex((f) => url.pathname.includes(f.match) && (f.times ?? 1) > 0);
    if (fi >= 0) {
      const f = st.faults[fi]!;
      f.times = (f.times ?? 1) - 1;
      if (f.drop) return void req.socket.destroy();
      return send(f.status ?? 500, f.body ?? {}, f.headers);
    }

    const p = url.pathname.replace("/gmail/v1/users/me", "");
    if (p === "/profile") {
      return send(200, {
        emailAddress: st.profileAddress,
        messagesTotal: st.messages.length,
        historyId: String(st.historyId),
      });
    }
    if (p === "/messages") {
      const max = Math.min(Number(query.maxResults ?? "100"), 500);
      const offset = query.pageToken ? Number(query.pageToken.replace("pg", "")) : 0;
      const label = query.labelIds;
      // En yeniden eskiye (Gmail gibi).
      const all = [...st.messages].reverse().filter((m) => !label || m.labels.includes(label));
      const slice = all.slice(offset, offset + max);
      const next = offset + max < all.length ? `pg${offset + max}` : undefined;
      return send(200, {
        ...(slice.length
          ? { messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })) }
          : {}),
        ...(next ? { nextPageToken: next } : {}),
        resultSizeEstimate: all.length,
      });
    }
    const one = /^\/messages\/([^/]+)$/.exec(p);
    if (one) {
      const m = st.messages.find((x) => x.id === one[1]);
      if (!m) return send(404, { error: { code: 404, status: "NOT_FOUND" } });
      return send(200, {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labels,
        internalDate: String(m.internalDate),
        sizeEstimate: Buffer.byteLength(m.raw),
        raw: Buffer.from(m.raw, "utf8").toString("base64url"),
        ...(m.override ?? {}),
      });
    }
    if (p === "/history") {
      const start = Number(query.startHistoryId);
      if (!Number.isFinite(start) || start < st.oldestHistory) {
        return send(404, { error: { code: 404, status: "NOT_FOUND" } });
      }
      const max = Math.min(Number(query.maxResults ?? "100"), 500);
      const offset = query.pageToken ? Number(query.pageToken.replace("hp", "")) : 0;
      const all = st.history.filter((h) => h.id > start);
      const slice = all.slice(offset, offset + max);
      const next = offset + max < all.length ? `hp${offset + max}` : undefined;
      return send(200, {
        ...(slice.length
          ? {
              history: slice.map((h) => ({
                id: String(h.id),
                messagesAdded: h.added.map((id) => ({ message: { id, threadId: "x" } })),
              })),
            }
          : {}),
        ...(next ? { nextPageToken: next } : {}),
        historyId: String(st.historyId),
      });
    }
    return send(404, { error: { code: 404 } });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  st.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  st.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return st;
}

const CRLF = "\r\n";

export interface WrapOptions {
  mailbox: string;
  /** Gmail'in eklediği `Authentication-Results` sonucu; "missing": hiç eklenmez. */
  dmarc?: "pass" | "fail" | "none" | "missing";
  /** `header.from` (varsayılan: iletinin From alan adı değil, açıkça verilmelidir). */
  headerFrom: string;
  returnPath?: string;
  authserv?: string;
  /** Gönderenin kontrolündeki özgün başlıkların EN BAŞINA (From'dan önce) eklenir: sahte başlıklar. */
  forgedFirst?: string[];
  /** Gmail başlıkları: Delivered-To değeri (varsayılan mailbox). */
  deliveredTo?: string;
}

/** Özgün iletinin başına Gmail'in eklediği başlıkları koyar (Delivered-To, Return-Path, Received, AR). */
export function gmailWrap(original: string, o: WrapOptions): string {
  const dmarc = o.dmarc ?? "pass";
  const gmail = [
    `Delivered-To: ${o.deliveredTo ?? o.mailbox}`,
    "Received: by 2002:a05:6a00:1 with SMTP id x1csp1;",
    " Mon, 2 Nov 2026 02:05:01 -0800 (PST)",
    `Return-Path: ${o.returnPath ?? "<sender@example.invalid>"}`,
    "Received: from mail.example.invalid (mail.example.invalid [192.0.2.1])",
    " by mx.google.com with ESMTPS id abc123;",
    ...(dmarc === "missing"
      ? []
      : [
          `Authentication-Results: ${o.authserv ?? "mx.google.com"};`,
          "       dkim=pass header.i=@example.invalid header.s=s1;",
          "       spf=pass smtp.mailfrom=sender@example.invalid;",
          `       dmarc=${dmarc} (p=NONE sp=NONE dis=NONE) header.from=${o.headerFrom}`,
        ]),
  ];
  return [...gmail, ...(o.forgedFirst ?? []), original].join(CRLF);
}
