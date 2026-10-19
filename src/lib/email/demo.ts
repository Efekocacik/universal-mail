import { createHash } from "node:crypto";
import { normalizeHost } from "./address";
import type { FetchFn, FetchResult } from "./safe-fetch";
import type { Resolver } from "./verify";

/**
 * Demo modu için çevrimdışı "web": `.example` alan adlarındaki sahte işletme siteleri (bkz. places/mock.ts) belirleyici
 * (deterministik) sayfalar üretir. Gerçek ağa çıkılmaz. Çeşitlilik: genel/kişisel adres, mailto, düz metin, JSON-LD,
 * Cloudflare koruması, gizlenmiş yazım, yalnızca sosyal bağlantı/form, robots engeli, erişim engeli, geçici hata.
 */
function h(host: string): number {
  return parseInt(createHash("sha1").update(host).digest("hex").slice(0, 8), 16);
}

function cfHex(email: string, key = 0x5a): string {
  return (
    key.toString(16).padStart(2, "0") +
    [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("")
  );
}

const html = (body: string) =>
  `<!doctype html><html><head><title>Demo</title></head><body><main>${body}</main></body></html>`;
const ok = (url: string, body: string, status = 200): FetchResult => ({
  url,
  status,
  headers: { "content-type": "text/html" },
  body,
  skippedBody: false,
  truncated: false,
  hops: 0,
});
const text = (url: string, body: string, status = 200): FetchResult => ({
  ...ok(url, body, status),
  headers: { "content-type": "text/plain" },
});

/** İlk istekte geçici hata verilen siteler (yeniden deneme akışını sınamak için). */
const flaky = new Map<string, number>();

export function resetDemoWeb(): void {
  flaky.clear();
}

export function createDemoFetch(): FetchFn {
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const host = normalizeHost(url.hostname);
    if (!host.endsWith(".example")) {
      return ok(rawUrl, "", 404); // demo modunda gerçek siteler taranmaz
    }
    const n = h(host);
    const path = url.pathname;
    const fullHome = `https://${url.hostname}/`;

    if (path === "/robots.txt") {
      if (n % 31 === 0) return text(rawUrl, "User-agent: *\nDisallow: /\n");
      if (n % 37 === 0) return text(rawUrl, "", 403);
      return text(rawUrl, "User-agent: *\nDisallow: /admin\n");
    }
    if (n % 23 === 0 && path === "/") {
      const seen = (flaky.get(host) ?? 0) + 1;
      flaky.set(host, seen);
      if (seen === 1) return ok(rawUrl, "geçici hata", 503);
    }
    if (n % 29 === 0 && path === "/") return ok(rawUrl, "Forbidden", 403);

    const variant = (n >>> 4) % 5;
    const hasEmail = n % 10 < 7;
    const generic = `info@${host}`;
    const personal = `${["anna", "marco", "sofia", "john", "lena"][(n >>> 8) % 5]}@${host}`;
    const outside = n % 20 === 1 ? `${host.split(".")[0]}@gmail.com` : null;
    const social = [
      n % 3 === 0 ? `<a href="https://www.instagram.com/${host.split(".")[0]}/">Instagram</a>` : "",
      n % 4 === 0 ? `<a href="https://www.facebook.com/${host.split(".")[0]}">Facebook</a>` : "",
    ].join("");
    const contactLink = `<a href="/contact">Contact</a>`;

    if (path === "/") {
      const body: string[] = [
        `<h1>${host}</h1><p>Welcome to our place. We serve fresh coffee, homemade cakes and light lunches every day of the week, in the heart of the neighbourhood. Come and say hello.</p>`,
        contactLink,
        social,
      ];
      if (hasEmail && variant === 0)
        body.push(`<footer><a href="mailto:${generic}">${generic}</a></footer>`);
      if (hasEmail && variant === 2)
        body.push(
          `<script type="application/ld+json">${JSON.stringify({ "@type": "Restaurant", email: generic })}</script>`,
        );
      if (hasEmail && variant === 4)
        body.push(`<a href="/cdn-cgi/l/email-protection#${cfHex(generic)}">e-mail</a>`);
      if (!hasEmail && outside) body.push(`<p>${outside}</p>`);
      return ok(fullHome, html(body.join("")));
    }
    if (path === "/contact" || path === "/contact-us") {
      const body: string[] = ["<h1>Contact</h1>"];
      if (hasEmail && variant === 1) body.push(`<p>General: ${generic}. Manager: ${personal}</p>`);
      if (hasEmail && variant === 3)
        body.push(`<p>Mail: ${generic.split("@")[0]} [at] ${host.replace(/\./g, " [dot] ")}</p>`);
      if (!hasEmail && n % 3 !== 2)
        body.push(
          `<form action="/send"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea></form>`,
        );
      return ok(url.toString(), html(body.join("")));
    }
    return ok(rawUrl, "not found", 404);
  };
}

/** Demo DNS: alan adlarının ~%8'inin MX kaydı yoktur; gerisi geçerlidir. */
export function createDemoResolver(): Resolver {
  const noAnswer = () => Object.assign(new Error("ENODATA"), { code: "ENODATA" });
  return {
    resolveMx: async (host) => {
      if (h(host) % 12 === 0) throw noAnswer();
      return [{ exchange: `mx.${host}`, priority: 10 }];
    },
    resolve4: async () => {
      throw noAnswer();
    },
    resolve6: async () => {
      throw noAnswer();
    },
  };
}
