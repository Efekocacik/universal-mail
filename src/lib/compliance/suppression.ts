import crypto from "node:crypto";
import { domainToASCII } from "node:url";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { parse as parseHost } from "tldts";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import {
  auditLog,
  suppressions,
  type SuppressionReason,
  type SuppressionScope,
  type SuppressionSource,
} from "@/lib/db/schema";
import { parentDomains, parseEmail } from "@/lib/email/address";

/**
 * Gönderim engelleri (SRS 5.6.1, FR-CMPL-02/03).
 *
 * Kurallar:
 *  - Açık e-posta adresi ne `suppressions` tablosuna ne `audit_log`'a yazılır. Eşleştirme normalleştirilmiş adresin
 *    SHA-256 özetiyle (`email_hash`), gösterim maskeli adresle yapılır. Silme talebinde (`erasure`) maskeli adres de
 *    tutulmaz.
 *  - Engeller lead'e bağlı değildir: lead silinse veya yeniden taranıp eklense de adres/alan adı engelli kalır.
 *  - Aynı adres veya alan adı için en fazla bir etkin kayıt vardır; daha güçlü bir nedenle yeniden eklenirse mevcut
 *    kaydın nedeni güçlendirilir, zayıflatılmaz.
 *  - Kaldırma yalnızca açık onay ve gerekçeyle yapılır. Alıcının iradesine dayanan engeller (çıkış, şikâyet, silme
 *    talebi) sıradan işlemle KALDIRILAMAZ; yalnızca belgelenmiş bir alıcı talebi veya hukuki düzeltmeyle kaldırılır.
 *  - Her ekleme, güçlendirme ve kaldırma aynı işlem içinde denetim kaydına yazılır.
 */

export const SUPPRESSION_HASH_ALG = "sha256-v1";

/** Güçlüden zayıfa. Etkin kayıt yalnızca daha güçlü bir nedenle güncellenir. */
export const SUPPRESSION_REASON_STRENGTH: Readonly<Record<SuppressionReason, number>> = {
  erasure: 6,
  complaint: 5,
  unsubscribe: 4,
  bounce_hard: 3,
  negative_reply: 2,
  manual: 1,
};

/** Alıcının iradesine dayanan, sıradan kullanıcı işlemiyle kaldırılamayan nedenler. */
export const PROTECTED_REASONS: ReadonlySet<SuppressionReason> = new Set([
  "unsubscribe",
  "complaint",
  "erasure",
]);

const REASONS = Object.keys(SUPPRESSION_REASON_STRENGTH) as SuppressionReason[];

export type SuppressionErrorKind =
  | "invalid_input"
  | "invalid_email"
  | "invalid_domain"
  | "public_suffix"
  | "invalid_reason"
  | "not_found"
  | "already_lifted"
  | "protected"
  | "unconfirmed";

export class SuppressionError extends Error {
  constructor(
    readonly kind: SuppressionErrorKind,
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/* ------------------------------------------------------------------------------------------------
 * Normalleştirme
 * ---------------------------------------------------------------------------------------------- */

/** Normalleştirilmiş adresin özeti. Normalleştirme Faz 2 ile aynıdır (küçük harf, punycode alan adı). */
export function hashEmail(normalizedEmail: string): string {
  return crypto.createHash("sha256").update(normalizedEmail, "utf8").digest("hex");
}

/** `info@cafe.example` → `i***@cafe.example`. Yerel kısmın yalnızca ilk karakteri görünür. */
export function maskEmail(local: string, domain: string): string {
  return `${local.slice(0, 1)}***@${domain}`;
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Alan adını küçük harf ve punycode yapar; geçersizse null. En az iki etiket ister (`com` gibi tek etiket olmaz). */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!value || value.length > 253 || /[\s/:]/.test(value)) return null;
  const domain = domainToASCII(value);
  if (!domain) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1]!)) return null;
  return domain;
}

/**
 * Alan adı bir genel kayıt uzantısı mı (Public Suffix List: `com`, `co.uk`, `gov.uk`, `github.io`...)? Bunlar tek bir
 * işletmeye ait olmadığından alan adı engeli hedefi olamaz. Özel (private) uzantılar da dahildir: `github.io` altındaki
 * siteler birbirinden bağımsızdır. Liste `tldts` paketiyle birlikte gelir; çalışırken ağa çıkılmaz.
 */
export function isPublicSuffix(normalizedDomain: string): boolean {
  const r = parseHost(normalizedDomain, { allowPrivateDomains: true });
  return r.domain === null || r.publicSuffix === normalizedDomain;
}

/* ------------------------------------------------------------------------------------------------
 * Kontrol
 * ---------------------------------------------------------------------------------------------- */

export interface SuppressionMatch {
  id: number;
  scope: SuppressionScope;
  reason: SuppressionReason;
  domain: string;
}

export interface SuppressionCheck {
  suppressed: boolean;
  /** Adres çözümlenemediyse gönderim güvenli tarafta kalarak engellenir. */
  invalidAddress: boolean;
  matches: SuppressionMatch[];
}

/**
 * Merkezi kontrol: adres, kendi özetiyle veya alan adıyla (üst alan adları dahil: `mail.cafe.example` için
 * `cafe.example` engeli de geçerlidir) engelli mi? Çözümlenemeyen adres engelli sayılır.
 */
export async function checkSuppression(db: Db, email: string): Promise<SuppressionCheck> {
  const parsed = parseEmail(email);
  if (!parsed) return { suppressed: true, invalidAddress: true, matches: [] };
  const rows = await db
    .select({
      id: suppressions.id,
      scope: suppressions.scope,
      reason: suppressions.reason,
      domain: suppressions.domain,
    })
    .from(suppressions)
    .where(
      and(
        isNull(suppressions.liftedAt),
        or(
          and(eq(suppressions.scope, "email"), eq(suppressions.emailHash, hashEmail(parsed.email))),
          and(
            eq(suppressions.scope, "domain"),
            inArray(suppressions.domain, domainCandidates(parsed.domain)),
          ),
        ),
      ),
    );
  return { suppressed: rows.length > 0, invalidAddress: false, matches: rows };
}

/** Alan adı engeli kontrolü (adres bilinmeden, ör. web sitesi alan adı için). */
export async function isDomainSuppressed(db: Db, rawDomain: string): Promise<boolean> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return true;
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        isNull(suppressions.liftedAt),
        eq(suppressions.scope, "domain"),
        inArray(suppressions.domain, domainCandidates(domain)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Alan adı ve en az iki etiketli üst alan adları (`a.b.example` → `a.b.example`, `b.example`). */
function domainCandidates(domain: string): string[] {
  return parentDomains(domain);
}

/* ------------------------------------------------------------------------------------------------
 * Ekleme
 * ---------------------------------------------------------------------------------------------- */

export type AddOutcome = "added" | "strengthened" | "existing";

export interface AddResult {
  outcome: AddOutcome;
  id: number;
  scope: SuppressionScope;
  reason: SuppressionReason;
}

interface AddEmailInput {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  note?: string | null;
  messageId?: number | null;
}

interface AddDomainInput {
  domain: string;
  reason: Exclude<SuppressionReason, "erasure">;
  source: SuppressionSource;
  note?: string | null;
}

/** Bir adresi engeller. Etkin kayıt varsa kopya oluşturmaz; yeni neden daha güçlüyse kaydı güçlendirir. */
export async function suppressEmail(
  db: Db,
  input: AddEmailInput,
  now = Date.now(),
): Promise<AddResult> {
  const parsed = parseEmail(input.email);
  if (!parsed) throw new SuppressionError("invalid_email", "Geçersiz e-posta adresi.");
  if (!(input.reason in SUPPRESSION_REASON_STRENGTH))
    throw new SuppressionError("invalid_reason", "Geçersiz engelleme nedeni.");
  return db.transaction((tx) => addEmailInTx(tx, parsed, input, now));
}

/** Bir alan adının tamamını (alt alan adları dahil) engeller. Silme talebi kişiye özgü olduğundan alan adına uygulanmaz. */
export async function suppressDomain(
  db: Db,
  input: AddDomainInput,
  now = Date.now(),
): Promise<AddResult> {
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new SuppressionError("invalid_domain", "Geçersiz alan adı.");
  if (isPublicSuffix(domain)) {
    throw new SuppressionError(
      "public_suffix",
      "Genel bir alan adı uzantısı (ör. com, co.uk) engellenemez; işletmenin kendi alan adını girin.",
    );
  }
  if (
    !(input.reason in SUPPRESSION_REASON_STRENGTH) ||
    input.reason === ("erasure" as SuppressionReason)
  )
    throw new SuppressionError("invalid_reason", "Geçersiz engelleme nedeni.");
  return db.transaction((tx) => addDomainInTx(tx, domain, input, now));
}

async function addEmailInTx(
  tx: Tx,
  parsed: { email: string; local: string; domain: string },
  input: AddEmailInput,
  now: number,
): Promise<AddResult> {
  const emailHash = hashEmail(parsed.email);
  const erasure = input.reason === "erasure";
  const [active] = await tx
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.scope, "email"),
        eq(suppressions.emailHash, emailHash),
        isNull(suppressions.liftedAt),
      ),
    )
    .limit(1);

  if (active) {
    if (SUPPRESSION_REASON_STRENGTH[input.reason] <= SUPPRESSION_REASON_STRENGTH[active.reason]) {
      return { outcome: "existing", id: active.id, scope: "email", reason: active.reason };
    }
    await tx
      .update(suppressions)
      .set({
        reason: input.reason,
        // Silme talebinde maskeli adres de silinir; yalnızca özet ve alan adı kalır.
        ...(erasure ? { emailMasked: null, note: null } : {}),
      })
      .where(eq(suppressions.id, active.id));
    await writeAudit(
      tx,
      "suppression.strengthened",
      active.id,
      {
        scope: "email",
        from: active.reason,
        to: input.reason,
        source: input.source,
      },
      now,
    );
    return { outcome: "strengthened", id: active.id, scope: "email", reason: input.reason };
  }

  const [row] = await tx
    .insert(suppressions)
    .values({
      scope: "email",
      emailHash,
      hashAlg: SUPPRESSION_HASH_ALG,
      emailMasked: erasure ? null : maskEmail(parsed.local, parsed.domain),
      domain: parsed.domain,
      reason: input.reason,
      source: input.source,
      messageId: input.messageId ?? null,
      note: erasure ? null : (input.note ?? null),
      addedAt: now,
    })
    .returning({ id: suppressions.id });
  await writeAudit(
    tx,
    "suppression.added",
    row!.id,
    {
      scope: "email",
      reason: input.reason,
      source: input.source,
    },
    now,
  );
  return { outcome: "added", id: row!.id, scope: "email", reason: input.reason };
}

async function addDomainInTx(
  tx: Tx,
  domain: string,
  input: AddDomainInput,
  now: number,
): Promise<AddResult> {
  const [active] = await tx
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.scope, "domain"),
        eq(suppressions.domain, domain),
        isNull(suppressions.liftedAt),
      ),
    )
    .limit(1);
  if (active) {
    if (SUPPRESSION_REASON_STRENGTH[input.reason] <= SUPPRESSION_REASON_STRENGTH[active.reason]) {
      return { outcome: "existing", id: active.id, scope: "domain", reason: active.reason };
    }
    await tx
      .update(suppressions)
      .set({ reason: input.reason })
      .where(eq(suppressions.id, active.id));
    await writeAudit(
      tx,
      "suppression.strengthened",
      active.id,
      {
        scope: "domain",
        domain,
        from: active.reason,
        to: input.reason,
        source: input.source,
      },
      now,
    );
    return { outcome: "strengthened", id: active.id, scope: "domain", reason: input.reason };
  }
  const [row] = await tx
    .insert(suppressions)
    .values({
      scope: "domain",
      domain,
      reason: input.reason,
      source: input.source,
      note: input.note ?? null,
      addedAt: now,
    })
    .returning({ id: suppressions.id });
  await writeAudit(
    tx,
    "suppression.added",
    row!.id,
    {
      scope: "domain",
      domain,
      reason: input.reason,
      source: input.source,
    },
    now,
  );
  return { outcome: "added", id: row!.id, scope: "domain", reason: input.reason };
}

/** Denetim kaydı: kayıt kimliği, kapsam, neden ve kaynak. Açık adres veya özet YAZILMAZ. */
async function writeAudit(
  tx: Tx,
  action: string,
  id: number,
  detail: Record<string, unknown>,
  now: number,
) {
  await tx
    .insert(auditLog)
    .values({ at: now, action, entity: "suppression", entityId: String(id), detail });
}

/* ------------------------------------------------------------------------------------------------
 * Kaldırma
 * ---------------------------------------------------------------------------------------------- */

const liftSchema = z
  .object({
    id: z.number().int().positive(),
    /** Kullanıcının açık onayı; yanlışlıkla (ör. toplu işlemde) kaldırmayı önler. */
    confirm: z.literal(true),
    justification: z.string().trim().min(10).max(500),
  })
  .strict();

const protectedLiftSchema = z
  .object({
    id: z.number().int().positive(),
    confirm: z.literal("ALICI_TALEBI_DOGRULANDI"),
    basis: z.enum(["recipient_request", "legal_correction"]),
    /** Talebin belgesine referans (ör. yazışma kimliği). Kişisel veri İÇERMEMELİDİR. */
    evidenceRef: z.string().trim().min(3).max(200),
    justification: z.string().trim().min(10).max(500),
  })
  .strict();

/**
 * Sıradan kaldırma: yalnızca kullanıcının kendi koyduğu veya teknik nedenli engeller (`manual`, `bounce_hard`,
 * `negative_reply`). Çıkış, şikâyet ve silme talebi engelleri bu yolla kaldırılamaz.
 */
export async function liftSuppression(db: Db, input: unknown, now = Date.now()): Promise<void> {
  const parsed = liftSchema.safeParse(input);
  if (!parsed.success) {
    const unconfirmed =
      typeof input === "object" &&
      input !== null &&
      (input as { confirm?: unknown }).confirm !== true;
    throw new SuppressionError(
      unconfirmed ? "unconfirmed" : "invalid_input",
      unconfirmed
        ? "Kaldırma için açık onay gerekir."
        : "Geçersiz kaldırma isteği (gerekçe en az 10 karakter).",
    );
  }
  await liftInTx(db, parsed.data.id, false, `manual: ${parsed.data.justification}`, now);
}

/**
 * Korumalı kaldırma: çıkış, şikâyet veya silme talebi engelini yalnızca belgelenmiş bir alıcı talebi ya da hukuki
 * düzeltme ile kaldırır.
 *
 * GÜVENLİK: Bu fonksiyon bilerek hiçbir API rotasına, arayüze veya Electron IPC'sine bağlı DEĞİLDİR
 * (`tests/suppression.test.ts` bunu denetler). `confirm` ifadesi ve `evidenceRef` yalnızca kazara çağrıyı önleyen
 * bir sürtünmedir; GERÇEK YETKİLENDİRME YERİNE GEÇMEZ: çağıranın kim olduğunu ya da talebin gerçekten var olduğunu
 * doğrulamaz. Arayüze açılmadan önce ayrı bir yetkilendirme tasarımı (kim, hangi kanıtla, çift onay) gerekir.
 */
export async function liftProtectedSuppression(
  db: Db,
  input: unknown,
  now = Date.now(),
): Promise<void> {
  const parsed = protectedLiftSchema.safeParse(input);
  if (!parsed.success) {
    throw new SuppressionError(
      "unconfirmed",
      "Korumalı engel yalnızca belgelenmiş talep ve açık onayla kaldırılır.",
    );
  }
  const { id, basis, evidenceRef, justification } = parsed.data;
  await liftInTx(db, id, true, `${basis} [${evidenceRef}]: ${justification}`, now, {
    basis,
    evidenceRef,
  });
}

async function liftInTx(
  db: Db,
  id: number,
  protectedPath: boolean,
  liftedReason: string,
  now: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(suppressions).where(eq(suppressions.id, id)).limit(1);
    if (!row) throw new SuppressionError("not_found", "Engel kaydı bulunamadı.");
    if (row.liftedAt !== null)
      throw new SuppressionError("already_lifted", "Engel zaten kaldırılmış.");
    if (PROTECTED_REASONS.has(row.reason) && !protectedPath) {
      throw new SuppressionError(
        "protected",
        "Çıkış, şikâyet ve silme talebi engelleri sıradan işlemle kaldırılamaz.",
      );
    }
    const updated = await tx
      .update(suppressions)
      .set({ liftedAt: now, liftedReason })
      .where(and(eq(suppressions.id, id), isNull(suppressions.liftedAt)))
      .returning({ id: suppressions.id });
    if (updated.length !== 1)
      throw new SuppressionError("already_lifted", "Engel zaten kaldırılmış.");
    await writeAudit(
      tx,
      "suppression.lifted",
      id,
      {
        scope: row.scope,
        reason: row.reason,
        protected: PROTECTED_REASONS.has(row.reason),
        ...extra,
      },
      now,
    );
  });
}

/* ------------------------------------------------------------------------------------------------
 * CSV içe aktarma
 * ---------------------------------------------------------------------------------------------- */

/** CSV ile eklenebilecek nedenler. Silme talebi kişiye özgü, ayrı bir işlemdir; CSV ile eklenmez. */
export const CSV_REASONS: readonly SuppressionReason[] = REASONS.filter((r) => r !== "erasure");
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 20_000;

export type CsvRowError =
  | "missing_value"
  | "ambiguous_value"
  | "invalid_email"
  | "invalid_domain"
  | "public_suffix"
  | "invalid_reason"
  | "erasure_not_allowed";

export interface CsvImportReport {
  added: number;
  strengthened: number;
  duplicates: number;
  /** Geçersiz satırlar: satır numarası ve hata kodu. Satırın içeriği (adres) raporda TEKRARLANMAZ. */
  invalid: { line: number; error: CsvRowError }[];
}

/**
 * Suppression CSV'sini içe aktarır. Sütunlar (başlık satırı zorunlu, büyük/küçük harf duyarsız):
 * `email` veya `domain` (biri dolu), isteğe bağlı `reason` (varsayılan `manual`) ve `note`.
 * Geçerli satırlar tek işlemde eklenir; geçersiz satırlar atlanır ve raporlanır.
 */
export async function importSuppressionsCsv(
  db: Db,
  text: string,
  now = Date.now(),
): Promise<CsvImportReport> {
  if (Buffer.byteLength(text, "utf8") > CSV_MAX_BYTES) {
    throw new SuppressionError("invalid_input", "Dosya çok büyük (en çok 2 MB).");
  }
  const clean = text.replace(/^﻿/, "");
  // Türkçe Excel ";" ile kaydeder: ayırıcı başlık satırından seçilir.
  const headerLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const records = parseCsv(
    clean,
    headerLine.includes(";") && !headerLine.includes(",") ? ";" : ",",
  );
  if (records.length === 0) throw new SuppressionError("invalid_input", "Dosya boş.");
  const header = records[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iEmail = col("email");
  const iDomain = col("domain");
  if (iEmail < 0 && iDomain < 0) {
    throw new SuppressionError(
      "invalid_input",
      "Başlık satırında 'email' veya 'domain' sütunu olmalıdır.",
    );
  }
  const iReason = col("reason");
  const iNote = col("note");
  const rows = records.slice(1);
  if (rows.length > CSV_MAX_ROWS) {
    throw new SuppressionError("invalid_input", `En çok ${CSV_MAX_ROWS} satır içe aktarılabilir.`);
  }

  type Valid =
    | {
        kind: "email";
        parsed: { email: string; local: string; domain: string };
        reason: SuppressionReason;
        note: string | null;
      }
    | {
        kind: "domain";
        domain: string;
        reason: Exclude<SuppressionReason, "erasure">;
        note: string | null;
      };
  const valid: Valid[] = [];
  const report: CsvImportReport = { added: 0, strengthened: 0, duplicates: 0, invalid: [] };

  rows.forEach((cells, idx) => {
    const line = idx + 2; // 1 = başlık
    if (cells.every((c) => c.trim() === "")) return; // boş satır
    const emailRaw = iEmail >= 0 ? (cells[iEmail] ?? "").trim() : "";
    const domainRaw = iDomain >= 0 ? (cells[iDomain] ?? "").trim() : "";
    const reasonRaw = iReason >= 0 ? (cells[iReason] ?? "").trim().toLowerCase() : "";
    const noteRaw = iNote >= 0 ? (cells[iNote] ?? "").trim().slice(0, 500) : "";
    const reason = (reasonRaw || "manual") as SuppressionReason;
    const note = noteRaw || null;

    if (!emailRaw && !domainRaw) return void report.invalid.push({ line, error: "missing_value" });
    if (emailRaw && domainRaw) return void report.invalid.push({ line, error: "ambiguous_value" });
    if (reason === "erasure")
      return void report.invalid.push({ line, error: "erasure_not_allowed" });
    if (!(CSV_REASONS as string[]).includes(reason))
      return void report.invalid.push({ line, error: "invalid_reason" });
    if (emailRaw) {
      const parsed = parseEmail(emailRaw);
      if (!parsed) return void report.invalid.push({ line, error: "invalid_email" });
      valid.push({ kind: "email", parsed, reason, note });
    } else {
      const domain = normalizeDomain(domainRaw);
      if (!domain) return void report.invalid.push({ line, error: "invalid_domain" });
      if (isPublicSuffix(domain)) return void report.invalid.push({ line, error: "public_suffix" });
      valid.push({
        kind: "domain",
        domain,
        reason: reason as Exclude<SuppressionReason, "erasure">,
        note,
      });
    }
  });

  await db.transaction(async (tx) => {
    for (const v of valid) {
      const r =
        v.kind === "email"
          ? await addEmailInTx(
              tx,
              v.parsed,
              { email: v.parsed.email, reason: v.reason, source: "csv", note: v.note },
              now,
            )
          : await addDomainInTx(
              tx,
              v.domain,
              { domain: v.domain, reason: v.reason, source: "csv", note: v.note },
              now,
            );
      if (r.outcome === "added") report.added++;
      else if (r.outcome === "strengthened") report.strengthened++;
      else report.duplicates++;
    }
    await tx.insert(auditLog).values({
      at: now,
      action: "suppression.csv_import",
      entity: "suppression",
      entityId: null,
      detail: {
        added: report.added,
        strengthened: report.strengthened,
        duplicates: report.duplicates,
        invalid: report.invalid.length,
      },
    });
  });
  return report;
}

/** RFC 4180 CSV ayrıştırıcı: tırnaklı alanlar, kaçışlı tırnak (""), CRLF/LF, tırnak içinde satır sonu. */
export function parseCsv(text: string, delimiter: "," | ";" = ","): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}
