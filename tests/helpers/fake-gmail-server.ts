import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Yerel SAHTE Gmail API sunucusu (yalnızca testler): `POST /gmail/v1/users/me/messages/send`. 127.0.0.1 üzerinde
 * rastgele portta dinler; gerçek Google'a HİÇBİR istek atılmaz.
 */

export interface GmailBehavior {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** İsteği okuduktan sonra bağlantıyı koparır (yanıt yok): ileti işlenmiş olabilir → sonuç belirsiz. */
  drop?: boolean;
  /** Yanıtı bu kadar geciktirir (zaman aşımı/iptal testleri). */
  delayMs?: number;
}

export interface GmailRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  json: Record<string, unknown> | null;
  /** `raw` alanının base64url çözülmüş hâli. */
  rawDecoded: string | null;
}

export interface FakeGmail {
  base: string;
  requests: GmailRequest[];
  /** Sırayla tüketilir; bitince varsayılan başarı (200) döner. */
  script: GmailBehavior[];
  close(): Promise<void>;
}

export async function startFakeGmail(): Promise<FakeGmail> {
  const state: FakeGmail = { base: "", requests: [], script: [], close: async () => undefined };
  let seq = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        json = null;
      }
      state.requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        json,
        rawDecoded:
          typeof json?.raw === "string"
            ? Buffer.from(json.raw, "base64url").toString("latin1")
            : null,
      });
      const b = state.script.shift();
      if (b?.drop) {
        req.socket.destroy();
        return;
      }
      const respond = () => {
        seq++;
        const status = b?.status ?? 200;
        const body = b
          ? b.body
          : { id: `msg${seq}abc`, threadId: `thr${seq}abc`, labelIds: ["SENT"] };
        res.writeHead(status, { "Content-Type": "application/json", ...(b?.headers ?? {}) });
        res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
      };
      if (b?.delayMs) setTimeout(respond, b.delayMs);
      else respond();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}
