import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { and, eq, isNull } from "drizzle-orm";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import type { Db, DbExecutor } from "@/lib/db/client";
import { auditLog, categorySets, templates } from "@/lib/db/schema";
import { checkContent, type ContentIssue } from "./content-check";
import { buildFooter, FooterError, type FooterMode } from "./footer";
import { htmlToText } from "./html";
import { isSupportedLanguage, type TemplateLanguage } from "./language";
import { buildRenderContext, RenderContextError } from "./render-context";
import {
  renderTemplate,
  TemplateRenderError,
  validateTemplate,
  type TemplateIssue,
} from "./template-engine";

/**
 * Şablon servisi: kaydetme, güncelleme, arşivleme ve ön izleme. API rotası veya arayüz yoktur; GERÇEK GÖNDERİM
 * YAPMAZ.
 *
 *  - Kayıt: HTML temizlenip saklanır; `body_text` temiz HTML'den (değişkenler yerinde) üretilir. Geçersiz şablon
 *    veya yanıltıcı içerik kaydedilmez. Her değişiklik `version`'ı artırır ve denetim kaydına yazılır.
 *  - Ön izleme / gönderim çıktısı: her seferinde BELLEKTE üretilir; veritabanında hiçbir alan değişmez.
 */

export type TemplateServiceErrorKind =
  "invalid_template" | "unknown_category" | "not_found" | "archived" | "conflict";

export class TemplateServiceError extends Error {
  constructor(
    readonly kind: TemplateServiceErrorKind,
    readonly issues: (TemplateIssue | ContentIssue)[] = [],
  ) {
    super(kind);
  }
}

export interface TemplateDraft {
  name: string;
  language: string;
  kind: string;
  categoryKey?: string | null;
  subject: string;
  bodyHtml: string;
}

interface Prepared {
  fields: Pick<
    typeof templates.$inferInsert,
    "name" | "language" | "kind" | "categoryKey" | "subject" | "bodyHtml" | "bodyText"
  >;
  warnings: (TemplateIssue | ContentIssue)[];
}

async function prepare(db: Db, draft: TemplateDraft): Promise<Prepared> {
  const v = validateTemplate(draft);
  if (!v.ok) throw new TemplateServiceError("invalid_template", v.errors);
  const bodyText = htmlToText(v.sanitizedHtml);
  const content = checkContent({
    subject: draft.subject,
    body: bodyText,
    links: hrefs(v.sanitizedHtml),
  });
  if (content.errors.length > 0) throw new TemplateServiceError("invalid_template", content.errors);

  const categoryKey = draft.categoryKey?.trim() || null;
  if (categoryKey) {
    const [cat] = await db
      .select({ key: categorySets.key })
      .from(categorySets)
      .where(eq(categorySets.key, categoryKey))
      .limit(1);
    if (!cat) throw new TemplateServiceError("unknown_category");
  }
  return {
    fields: {
      name: draft.name.trim(),
      language: draft.language,
      kind: draft.kind as "initial" | "followup",
      categoryKey,
      subject: draft.subject.trim(),
      bodyHtml: v.sanitizedHtml,
      bodyText,
    },
    warnings: [...v.warnings, ...content.warnings],
  };
}

function hrefs(html: string): string[] {
  const $ = cheerio.load(html, null, false);
  return $("a[href]")
    .toArray()
    .map((a) => a.attribs.href ?? "");
}

export async function createTemplate(
  db: Db,
  draft: TemplateDraft,
  now = Date.now(),
): Promise<{ id: number; version: number; warnings: (TemplateIssue | ContentIssue)[] }> {
  const p = await prepare(db, draft);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(templates)
      .values({ ...p.fields, builtIn: false, version: 1, createdAt: now, updatedAt: now })
      .returning({ id: templates.id });
    await tx.insert(auditLog).values({
      at: now,
      action: "template.created",
      entity: "template",
      entityId: String(row!.id),
      detail: { version: 1, language: p.fields.language, kind: p.fields.kind },
    });
    return { id: row!.id, version: 1, warnings: p.warnings };
  });
}

export async function updateTemplate(
  db: Db,
  id: number,
  patch: Partial<TemplateDraft>,
  now = Date.now(),
): Promise<{ version: number; warnings: (TemplateIssue | ContentIssue)[] }> {
  const [current] = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
  if (!current) throw new TemplateServiceError("not_found");
  if (current.archivedAt !== null) throw new TemplateServiceError("archived");
  const p = await prepare(db, {
    name: patch.name ?? current.name,
    language: patch.language ?? current.language,
    kind: patch.kind ?? current.kind,
    categoryKey: patch.categoryKey === undefined ? current.categoryKey : patch.categoryKey,
    subject: patch.subject ?? current.subject,
    bodyHtml: patch.bodyHtml ?? current.bodyHtml,
  });
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(templates)
      .set({ ...p.fields, version: current.version + 1, updatedAt: now })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.version, current.version),
          isNull(templates.archivedAt),
        ),
      )
      .returning({ version: templates.version });
    // Okunduktan sonra başka bir değişiklik/arşivleme olduysa üzerine yazma.
    if (updated.length !== 1) throw new TemplateServiceError("conflict");
    await tx.insert(auditLog).values({
      at: now,
      action: "template.updated",
      entity: "template",
      entityId: String(id),
      detail: { version: updated[0]!.version, language: p.fields.language, kind: p.fields.kind },
    });
    return { version: updated[0]!.version, warnings: p.warnings };
  });
}

/** Şablon silinmez, arşivlenir (gönderilmiş iletiler sürümüne başvurur). */
export async function archiveTemplate(db: Db, id: number, now = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(templates).where(eq(templates.id, id)).limit(1);
    if (!row) throw new TemplateServiceError("not_found");
    if (row.archivedAt !== null) throw new TemplateServiceError("archived");
    await tx.update(templates).set({ archivedAt: now, updatedAt: now }).where(eq(templates.id, id));
    await tx.insert(auditLog).values({
      at: now,
      action: "template.archived",
      entity: "template",
      entityId: String(id),
      detail: { version: row.version },
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * Ön izleme ve gönderim çıktısı (yalnızca okuma)
 * ---------------------------------------------------------------------------------------------- */

export type ComposeErrorCode =
  | "template_not_found"
  | "template_archived"
  | "template_invalid"
  | "lead_not_found"
  | "unsupported_language"
  | "sender_profile_incomplete"
  | "unsubscribe_link_required"
  | "live_sending_disabled"
  | "missing_variables"
  | "content_blocked";

export interface ComposeIssue {
  code: ComposeErrorCode;
  detail?: string;
}

/**
 * İçerik özetinin (`messages.body_sha256`) tanım sürümü.
 *
 * Sürüm 1: `sha256(JSON.stringify([subject, text, html]))`, UTF-8, küçük harf onaltılık. Alıcının gördüğü konu, düz
 * metin ve HTML'in TAMAMINI kapsar; MIME'nin rastgele ayracından ve `Date`/`Message-ID` başlıklarından bağımsızdır
 * (aynı içerik → aynı özet). JSON dizisi alan sınırlarını korur ("ab"+"c" ile "a"+"bc" farklı özet verir).
 * Tanım değişirse eski kayıtlarla karşılaştırılamaz; sürüm artırılmalı ve veritabanında ayrıca belirtilmelidir.
 */
export const CONTENT_HASH_VERSION = 1;

export function contentSha256(subject: string, text: string, html: string): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([subject, text, html]), "utf8")
    .digest("hex");
}

export interface ComposedEmail {
  /** Gönderilebilir mi? `send` amacında hata yoksa true. Bu sürümde live hiçbir zaman gönderilebilir değildir. */
  sendable: boolean;
  errors: ComposeIssue[];
  warnings: (TemplateIssue | ContentIssue)[];
  templateId: number;
  templateVersion: number | null;
  language: TemplateLanguage | null;
  subject: string;
  /** Gönderim geçmişine yazılacak konu (Google verisi kullanılmadığından konu ile aynıdır). */
  subjectLogged: string;
  html: string;
  text: string;
  /** İçerik kanıtı (`messages.body_sha256`, tanım: `CONTENT_HASH_VERSION`); gövde saklanmaz. */
  bodySha256: string | null;
  missing: string[];
}

/**
 * Bir şablonu bir lead için doldurur ve zorunlu alt bilgiyi ekler.
 *  - `purpose: "preview"`: eksik değişkenler görünür işaretle gösterilir; uyarılar listelenir.
 *  - `purpose: "send"`: eksik değişken, alt bilgi eksikliği veya içerik hatası `sendable`'ı false yapar.
 * Hiçbir durumda veritabanına yazmaz ve ileti göndermez.
 */
export async function composeEmail(
  db: DbExecutor,
  input: {
    templateId: number;
    leadId: number;
    mode: FooterMode;
    purpose: "preview" | "send";
    unsubscribeUrl?: string | null;
  },
): Promise<ComposedEmail> {
  const errors: ComposeIssue[] = [];
  const warnings: (TemplateIssue | ContentIssue)[] = [];
  const empty: ComposedEmail = {
    sendable: false,
    errors,
    warnings,
    templateId: input.templateId,
    templateVersion: null,
    language: null,
    subject: "",
    subjectLogged: "",
    html: "",
    text: "",
    bodySha256: null,
    missing: [],
  };

  if (input.mode === "live" && !LIVE_SENDING_ENABLED)
    errors.push({ code: "live_sending_disabled" });

  const [tpl] = await db
    .select()
    .from(templates)
    .where(eq(templates.id, input.templateId))
    .limit(1);
  if (!tpl) {
    errors.push({ code: "template_not_found" });
    return empty;
  }
  if (tpl.archivedAt !== null) errors.push({ code: "template_archived" });
  if (!isSupportedLanguage(tpl.language)) {
    errors.push({ code: "unsupported_language" });
    return { ...empty, templateVersion: tpl.version };
  }
  const language = tpl.language;

  let ctx;
  try {
    ctx = await buildRenderContext(db, input.leadId, language);
  } catch (e) {
    if (e instanceof RenderContextError) {
      errors.push({ code: "lead_not_found" });
      return { ...empty, templateVersion: tpl.version, language };
    }
    throw e;
  }

  let footer: ReturnType<typeof buildFooter> | null = null;
  try {
    footer = buildFooter({
      profile: ctx.profile,
      language,
      mode: input.mode,
      unsubscribeUrl: input.unsubscribeUrl,
    });
  } catch (e) {
    if (!(e instanceof FooterError)) throw e;
    errors.push({ code: e.kind });
  }

  let body;
  try {
    body = renderTemplate(
      { subject: tpl.subject, bodyHtml: tpl.bodyHtml },
      { ...ctx.values, cikis_linki: footer?.unsubscribeUrl ?? null },
      { markMissing: input.purpose === "preview" },
    );
  } catch (e) {
    if (!(e instanceof TemplateRenderError)) throw e;
    errors.push({ code: "template_invalid" });
    warnings.push(...e.issues);
    return { ...empty, templateVersion: tpl.version, language };
  }
  if (body.missing.length > 0)
    errors.push({ code: "missing_variables", detail: body.missing.join(",") });

  const content = checkContent({ subject: body.subject, body: body.text, links: hrefs(body.html) });
  for (const c of content.errors) errors.push({ code: "content_blocked", detail: c.code });
  warnings.push(...content.warnings);

  const html = footer ? `${body.html}\n${footer.html}` : body.html;
  const text = footer ? `${body.text}\n\n${footer.text}` : body.text;
  return {
    sendable: input.purpose === "send" && errors.length === 0,
    errors,
    warnings,
    templateId: tpl.id,
    templateVersion: tpl.version,
    language,
    subject: body.subject,
    subjectLogged: body.subject,
    html,
    text,
    bodySha256: contentSha256(body.subject, text, html),
    missing: body.missing,
  };
}
