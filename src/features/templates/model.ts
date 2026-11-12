import { SUPPORTED_LANGUAGES } from "@/lib/mail/language";
import { TEMPLATE_VARIABLES, type TemplateVariable } from "@/lib/mail/variables";
import type { TemplateDetail } from "@/lib/client/templates";
import { t, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Şablon ekranlarının saf mantığı (DOM'suz; node testleriyle doğrulanır). Sunucu kurallarının yerine GEÇMEZ:
 * pasif alanlar yalnızca kullanıcı deneyimi içindir; yerleşik/kilitli/arşivli şablon denetimi API'dedir.
 */

export const LANGUAGES = SUPPORTED_LANGUAGES;
export const KINDS = ["initial", "followup"] as const;
export type Kind = (typeof KINDS)[number];

function has(key: string): key is TrKey {
  return Object.prototype.hasOwnProperty.call(tr, key);
}

function lookup(prefix: string, code: string): string {
  const key = `${prefix}.${code}`;
  return has(key) ? t(key) : code;
}

export const languageName = (code: string) => lookup("lang", code);
export const kindName = (kind: string) => lookup("tplKind", kind);

/** Bir sorun nesnesinin (şablon doğrulaması, içerik denetimi veya birleştirme hatası) okunur karşılığı. */
export function issueText(issue: {
  code: string;
  field?: string;
  where?: string;
  detail?: string;
}): string {
  const base = has(`tplIssue.${issue.code}`)
    ? t(`tplIssue.${issue.code}` as TrKey)
    : has(`contentIssue.${issue.code}`)
      ? t(`contentIssue.${issue.code}` as TrKey)
      : has(`composeError.${issue.code}`)
        ? t(`composeError.${issue.code}` as TrKey)
        : issue.code;
  const field =
    issue.field && has(`tplField.${issue.field}`) ? t(`tplField.${issue.field}` as TrKey) : null;
  const detail = issue.detail && /^[\w,.\- ]{1,80}$/.test(issue.detail) ? ` (${issue.detail})` : "";
  return `${field ? `${field}: ` : ""}${base}${detail}`;
}

export type ReadOnlyReason = "built_in" | "archived" | "locked";

/** Şablon neden düzenlenemiyor? Düzenlenebilirse null. */
export function readOnlyReason(
  d: Pick<TemplateDetail, "builtIn" | "archived" | "locked">,
): ReadOnlyReason | null {
  if (d.builtIn) return "built_in";
  if (d.archived) return "archived";
  if (d.locked) return "locked";
  return null;
}

export interface VariableChip {
  key: string;
  token: string;
  unsupported: boolean;
  footer: boolean;
  source: TemplateVariable["source"];
}

/** Değişken paneli: desteklenenler önce. */
export function variableChips(): VariableChip[] {
  return [...TEMPLATE_VARIABLES]
    .map((v) => ({
      key: v.key,
      token: `{{${v.key}}}`,
      unsupported: !!v.unsupported,
      footer: !!v.footer,
      source: v.source,
    }))
    .sort((a, b) => Number(a.unsupported) - Number(b.unsupported));
}

/** Seçili aralığın yerine metin ekler; imleç eklenen metnin sonunda olur. */
export function insertAt(
  value: string,
  start: number,
  end: number,
  insertion: string,
): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  return { value: value.slice(0, s) + insertion + value.slice(e), caret: s + insertion.length };
}

export interface Draft {
  name: string;
  language: string;
  kind: Kind;
  subject: string;
  bodyHtml: string;
  /** Takip şablonunda ilk e-postanın konusu "Re:" ile kullanılır (9d). İlk e-posta şablonunda etkisizdir. */
  followupReuseSubject: boolean;
}

export const EMPTY_DRAFT: Draft = {
  name: "",
  language: "tr",
  kind: "initial",
  subject: "",
  bodyHtml: "",
  followupReuseSubject: true,
};

export function toDraft(
  d: Pick<TemplateDetail, "name" | "language" | "kind" | "subject" | "bodyHtml"> &
    Partial<Pick<TemplateDetail, "followupReuseSubject">>,
): Draft {
  return {
    name: d.name,
    language: d.language,
    kind: d.kind,
    subject: d.subject,
    bodyHtml: d.bodyHtml,
    followupReuseSubject: d.followupReuseSubject ?? true,
  };
}

/** Konu alanının açıklaması: takip şablonunda konu devamı açıksa şablon konusu yalnızca yedektir (9d). */
export function subjectHintKey(
  d: Pick<Draft, "kind" | "followupReuseSubject">,
): "tplEditor.subject.reuseHint" | null {
  return d.kind === "followup" && d.followupReuseSubject ? "tplEditor.subject.reuseHint" : null;
}

/** Yalnızca değişen alanlar (PATCH gövdesi). */
export function changedFields(base: Draft, next: Draft): Partial<Draft> {
  const out: Partial<Draft> = {};
  for (const k of Object.keys(next) as (keyof Draft)[]) {
    if (next[k] !== base[k]) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

/** Arayüzün yaptığı hafif denetim: sunucu asıl doğrulamayı yapar. */
export function draftReady(d: Draft): boolean {
  return d.name.trim().length > 0 && d.subject.trim().length > 0 && d.bodyHtml.trim().length > 0;
}

/** Ön izleme isteği için gecikme (ms): her tuşta istek atılmaz. */
export const PREVIEW_DEBOUNCE_MS = 600;
