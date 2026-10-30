import * as cheerio from "cheerio";

/**
 * E-posta HTML'i için güvenlik yardımcıları (yeni paket yok; cheerio ile izinli liste).
 *
 *  - `sanitizeEmailHtml`: yalnızca izinli etiket ve özellikler kalır. Betik, stil, çerçeve, form ve GÖRSELLER
 *    (uzak görsel = açılma izleme pikseli; SRS FR-CMP-09 açılma takibi varsayılan kapalı) içerikleriyle silinir;
 *    bilinmeyen etiketler açılır (metni korunur). `style` özelliği de silinir: gizli metinle ticari niteliğin
 *    saklanmasını önler (SRS 8.3).
 *  - `htmlToText`: temiz HTML'den düz metin sürümü üretir.
 *  - `escapeHtml`: değişken değerlerinin HTML'e güvenli yerleştirilmesi.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "a",
  "h2",
  "h3",
  "blockquote",
  "span",
  "div",
  "hr",
]);

/** İçeriğiyle birlikte silinen etiketler. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "noscript",
  "template",
  "svg",
  "math",
  "head",
  "title",
  "meta",
  "link",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "img",
  "picture",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
]);

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

export interface SanitizeResult {
  html: string;
  /** Silinen veya açılan etiket ve özellikler (ör. "script", "img", "a[href]", "p[style]"). */
  removed: string[];
}

export function sanitizeEmailHtml(input: string): SanitizeResult {
  const removed = new Set<string>();
  const $ = cheerio.load(input, null, false);

  // Yorumlar (koşullu yorumlar dahil) her düzeyde silinir.
  const all = $.root().find("*").addBack();
  all
    .contents()
    .filter((_, n) => n.type === "comment" || n.type === "directive" || n.type === "cdata")
    .remove();

  // En derindekiler önce: bir üst etiket açıldığında çocukları zaten temizlenmiştir.
  for (const el of $.root().find("*").toArray().reverse()) {
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      removed.add(tag);
      $(el).remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      removed.add(tag);
      $(el).replaceWith($(el).contents());
      continue;
    }
    for (const attr of Object.keys(el.attribs)) {
      const value = el.attribs[attr] ?? "";
      const keep = tag === "a" && attr === "href" && SAFE_HREF.test(value.trim());
      if (!keep) {
        removed.add(`${tag}[${attr}]`);
        $(el).removeAttr(attr);
      }
    }
  }
  return { html: $.html().trim(), removed: [...removed].sort() };
}

const BLOCK = new Set(["p", "div", "h2", "h3", "blockquote", "ul", "ol"]);

/** HTML'den düz metin: paragraflar boş satırla, `<br>` satır sonuyla, liste öğesi "- ", bağlantı "metin (adres)". */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html, null, false);
  const out: string[] = [];
  const roots = $.root().contents().toArray();
  const walk = (nodes: typeof roots) => {
    for (const node of nodes) {
      if (node.type === "text") {
        out.push(("data" in node ? String(node.data) : "").replace(/\s+/g, " "));
        continue;
      }
      if (!("tagName" in node)) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "br") {
        out.push("\n");
        continue;
      }
      if (tag === "hr") {
        out.push("\n\n----\n\n");
        continue;
      }
      if (BLOCK.has(tag)) out.push("\n\n");
      if (tag === "li") out.push("\n- ");
      walk($(node).contents().toArray());
      if (tag === "a") {
        const href = node.attribs.href?.trim();
        const text = $(node).text().trim();
        if (href && href !== text && !href.startsWith("mailto:")) out.push(` (${href})`);
      }
      if (BLOCK.has(tag)) out.push("\n\n");
    }
  };
  walk(roots);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
