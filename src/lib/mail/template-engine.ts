import { escapeHtml, htmlToText, sanitizeEmailHtml } from "./html";
import { SUPPORTED_LANGUAGES } from "./language";
import { variableInfo, type VariableKey } from "./variables";

/**
 * Şablon motoru (SRS FR-TPL-01..04).
 *
 * Söz dizimi: `{{degisken}}` veya yedek metinli `{{degisken|yedek metin}}`. Değeri olmayan değişken yedek metinle
 * doldurulur; yedek de yoksa EKSİK sayılır (ön izlemede işaretlenir, gönderimde engeller). Değer uydurulmaz.
 *
 * Bu modül saf fonksiyonlardan oluşur: veritabanına dokunmaz, girdiyi değiştirmez. Çıktı (konu, HTML, düz metin)
 * her seferinde bellekte üretilir; kayıtlı şablon alanları değişmez.
 */

export const SUBJECT_MAX = 150;
export const BODY_MAX_BYTES = 50_000;
export const NAME_MAX = 120;
export const FALLBACK_MAX = 80;

export type TemplateField = "name" | "language" | "kind" | "subject" | "body";

export type TemplateIssueCode =
  | "required"
  | "too_long"
  | "invalid_language"
  | "invalid_kind"
  | "subject_newline"
  | "unclosed_variable"
  | "stray_braces"
  | "empty_variable"
  | "unknown_variable"
  | "unsupported_variable"
  | "invalid_fallback"
  | "variable_in_tag"
  | "html_sanitized";

export interface TemplateIssue {
  field: TemplateField;
  code: TemplateIssueCode;
  detail?: string;
}

export type TemplateToken =
  { type: "text"; value: string } | { type: "var"; name: VariableKey; fallback: string | null };

/** `{{...}}` ifadelerini ayrıştırır. Hata varsa `errors` doludur ve belirteçler kullanılmamalıdır. */
export function parseTemplateText(
  text: string,
  field: TemplateField,
): { tokens: TemplateToken[]; errors: TemplateIssue[] } {
  const tokens: TemplateToken[] = [];
  const errors: TemplateIssue[] = [];
  let i = 0;
  let buf = "";
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    const strayClose = text.indexOf("}}", i);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      errors.push({ field, code: "stray_braces" });
      buf += text.slice(i, strayClose + 2);
      i = strayClose + 2;
      continue;
    }
    if (open === -1) {
      buf += text.slice(i);
      break;
    }
    buf += text.slice(i, open);
    const close = text.indexOf("}}", open + 2);
    const nextOpen = text.indexOf("{{", open + 2);
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      errors.push({ field, code: "unclosed_variable" });
      buf += text.slice(open, open + 2);
      i = open + 2;
      continue;
    }
    const inner = text.slice(open + 2, close);
    i = close + 2;
    const bar = inner.indexOf("|");
    const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const fallbackRaw = bar === -1 ? null : inner.slice(bar + 1).trim();
    if (!name) {
      errors.push({ field, code: "empty_variable" });
      continue;
    }
    const info = variableInfo(name);
    if (!info || !/^[a-z_]+$/.test(name)) {
      errors.push({ field, code: "unknown_variable", detail: name.slice(0, 40) });
      continue;
    }
    if (info.unsupported) {
      errors.push({ field, code: "unsupported_variable", detail: name });
      continue;
    }
    if (
      fallbackRaw !== null &&
      (fallbackRaw.length === 0 ||
        fallbackRaw.length > FALLBACK_MAX ||
        /[{}<>|\r\n]/.test(fallbackRaw))
    ) {
      errors.push({ field, code: "invalid_fallback", detail: name });
      continue;
    }
    if (buf) tokens.push({ type: "text", value: buf });
    buf = "";
    tokens.push({ type: "var", name: name as VariableKey, fallback: fallbackRaw });
  }
  if (buf) tokens.push({ type: "text", value: buf });
  return { tokens, errors };
}

/** HTML'de bir değişken etiketin içinde mi (`<a href="{{...}}">`)? Değişken yalnızca metin içinde kullanılabilir. */
function hasVariableInsideTag(html: string): boolean {
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (inTag && ch === "{" && html[i + 1] === "{") return true;
  }
  return false;
}

export interface TemplateInput {
  name: string;
  language: string;
  kind: string;
  subject: string;
  bodyHtml: string;
}

export interface TemplateValidation {
  ok: boolean;
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
  /** Kaydedilecek, temizlenmiş HTML (girdi değiştirilmez). */
  sanitizedHtml: string;
  /** Şablonda kullanılan değişkenler. */
  variables: VariableKey[];
}

/** Şablonu kaydetmeden önce doğrular. Hata varsa kaydedilmemelidir. */
export function validateTemplate(input: TemplateInput): TemplateValidation {
  const errors: TemplateIssue[] = [];
  const warnings: TemplateIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) errors.push({ field: "name", code: "required" });
  else if (name.length > NAME_MAX) errors.push({ field: "name", code: "too_long" });
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(input.language)) {
    errors.push({ field: "language", code: "invalid_language" });
  }
  if (input.kind !== "initial" && input.kind !== "followup") {
    errors.push({ field: "kind", code: "invalid_kind" });
  }

  const subject = input.subject ?? "";
  if (!subject.trim()) errors.push({ field: "subject", code: "required" });
  if (subject.length > SUBJECT_MAX) errors.push({ field: "subject", code: "too_long" });
  if (/[\r\n]/.test(subject)) errors.push({ field: "subject", code: "subject_newline" });
  const s = parseTemplateText(subject, "subject");
  errors.push(...s.errors);

  const body = input.bodyHtml ?? "";
  let sanitizedHtml = "";
  let bodyVars: TemplateToken[] = [];
  if (!body.trim()) errors.push({ field: "body", code: "required" });
  else if (Buffer.byteLength(body, "utf8") > BODY_MAX_BYTES) {
    errors.push({ field: "body", code: "too_long" });
  } else {
    if (hasVariableInsideTag(body)) errors.push({ field: "body", code: "variable_in_tag" });
    const san = sanitizeEmailHtml(body);
    sanitizedHtml = san.html;
    if (san.removed.length > 0) {
      warnings.push({ field: "body", code: "html_sanitized", detail: san.removed.join(",") });
    }
    if (!htmlToText(sanitizedHtml).trim()) errors.push({ field: "body", code: "required" });
    const b = parseTemplateText(sanitizedHtml, "body");
    errors.push(...b.errors);
    bodyVars = b.tokens;
  }

  const variables = [
    ...new Set(
      [...s.tokens, ...bodyVars]
        .filter((t): t is Extract<TemplateToken, { type: "var" }> => t.type === "var")
        .map((t) => t.name),
    ),
  ];
  return { ok: errors.length === 0, errors, warnings, sanitizedHtml, variables };
}

/* ------------------------------------------------------------------------------------------------
 * Değişken doldurma
 * ---------------------------------------------------------------------------------------------- */

export type VariableValues = Partial<Record<VariableKey, string | null | undefined>>;

export interface RenderOptions {
  /** Eksik değişkenin yerine görünür bir işaret koy (ön izleme). Gönderimde kullanılmaz. */
  markMissing?: boolean;
}

export interface RenderedBody {
  subject: string;
  /** Temizlenmiş gövde HTML'i (alt bilgi hariç). */
  html: string;
  /** HTML'den üretilen düz metin (alt bilgi hariç). */
  text: string;
  /** Değeri ve yedeği olmayan değişkenler. */
  missing: VariableKey[];
  /** Yedek metinle doldurulan değişkenler. */
  usedFallback: VariableKey[];
}

export class TemplateRenderError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super("Şablon geçersiz.");
  }
}

/** C0 kontrol karakterleri, DEL ve Unicode satır/paragraf ayırıcıları (U+2028, U+2029). */
const HEADER_UNSAFE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]+`,
  "g",
);

/** Başlıkta kullanılacak metin: kontrol karakterleri ve satır sonları tek boşluğa iner (başlık enjeksiyonu yok). */
export function headerSafe(s: string): string {
  return s.replace(HEADER_UNSAFE, " ").replace(/\s+/g, " ").trim();
}

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Kayıtlı (temizlenmiş) şablonu verilen değerlerle doldurur. Değerler HTML'de kaçışlanır, konuda tek satıra indirilir.
 * Sonuç ayrıca yeniden temizlenir (derinlemesine savunma). Şablon geçersizse `TemplateRenderError` fırlatır.
 */
export function renderTemplate(
  template: { subject: string; bodyHtml: string },
  values: VariableValues,
  opts: RenderOptions = {},
): RenderedBody {
  const s = parseTemplateText(template.subject, "subject");
  const b = parseTemplateText(template.bodyHtml, "body");
  const issues = [...s.errors, ...b.errors];
  if (/[\r\n]/.test(template.subject)) issues.push({ field: "subject", code: "subject_newline" });
  if (hasVariableInsideTag(template.bodyHtml))
    issues.push({ field: "body", code: "variable_in_tag" });
  if (issues.length > 0) throw new TemplateRenderError(issues);

  const missing = new Set<VariableKey>();
  const usedFallback = new Set<VariableKey>();
  const fill = (
    tokens: TemplateToken[],
    encode: (v: string) => string,
    marker: (k: string) => string,
  ) =>
    tokens
      .map((t) => {
        if (t.type === "text") return t.value;
        const v = values[t.name];
        if (present(v)) return encode(v.trim());
        if (t.fallback !== null) {
          usedFallback.add(t.name);
          return encode(t.fallback);
        }
        missing.add(t.name);
        return opts.markMissing ? marker(t.name) : "";
      })
      .join("");

  const subject = headerSafe(fill(s.tokens, headerSafe, (k) => `[eksik: ${k}]`));
  const filled = fill(
    b.tokens,
    (v) => escapeHtml(v),
    (k) => `<strong>[eksik: ${escapeHtml(k)}]</strong>`,
  );
  const html = sanitizeEmailHtml(filled).html;
  return {
    subject,
    html,
    text: htmlToText(html),
    missing: [...missing],
    usedFallback: [...usedFallback],
  };
}
