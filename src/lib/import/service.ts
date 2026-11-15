import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ACTIVE_SEQUENCE } from "@/lib/compliance/eligibility";
import { audit } from "@/lib/db/audit";
import { placeCache } from "@/lib/db/cache-schema";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  categorySets,
  importBatches,
  importBatchLeads,
  leadEmails,
  leadEnrichment,
  leads,
} from "@/lib/db/schema";
import { classifyKind, domainMatchesSite, parseEmail } from "@/lib/email/address";
import { SHARED_SITE_DOMAINS } from "@/lib/email/lists";
import { isKnownCountry } from "@/lib/geo/countries";
import { chunk } from "@/lib/util";
import { csvParser } from "./csv";
import { mappingSchema, requireUsableMapping, suggestMapping } from "./mapping";
import {
  cleanText,
  normaliseCity,
  normaliseName,
  normaliseWebsite,
  resolveCountry,
  websiteKey,
} from "./normalise";
import {
  detectImportFormat,
  IMPORT_LIMITS,
  ImportError,
  type ImportFormat,
  type ImportMapping,
  type ImportWarning,
  type ParsedTable,
} from "./types";
import { xlsxParser } from "./xlsx";

/**
 * CSV/XLSX içe aktarma hizmeti (Faz 5, paket I).
 *
 * Akış: dosya → biçim (uzantı + imza) → ayrıştırma → (önizleme: öneri eşleme, ilk 20 satır; hiçbir şey yazılmaz)
 * → eşleme + kaynak notu + kullanım onayı → satır sınıflandırma (geçersiz / kopya / eklenecek) → TEK işlemde yazma.
 *
 * Değişmezler:
 *  - Toplu ekleme ya hep ya hiç: parti satırı, lead'ler, e-postalar ve bağlantı satırları tek işlemdedir (yarıda kalan
 *    içe aktarma geri alınamayan sahipsiz lead bırakmaz). Çok satırlı INSERT'ler 500'lük parçalardır.
 *  - Kopya denetimi okumaları da aynı yazma işlemindedir: aynı dosya iki kez gönderilirse (çift tıklama, ağ yeniden
 *    denemesi) ikinci gönderim yeni lead oluşturmaz, hepsi kopya sayılır (doğal idempotentlik).
 *  - Google içeriği (oturum önbelleğindeki ad/site) yalnızca karşılaştırma için BELLEKTE okunur; hiçbir yere yazılmaz.
 *  - Ağ isteği yok: web sitesi yalnızca normalleştirilir; e-posta "doğrulanmamış" saklanır (MX denetimi sonra).
 *  - Denetim kaydında ad, adres veya e-posta yoktur; yalnızca sayılar.
 */

export type DuplicateReason = "same_website" | "same_email" | "same_name_city" | "in_file";
export type InvalidReason = "no_name" | "no_country" | "bad_country" | "bad_website" | "bad_email";

/** Yanıttaki satır listelerinin üst sınırı (sayılar her zaman tamdır). */
export const REPORT_LIST_MAX = 200;
const WRITE_CHUNK = 500;
const NAME_MAX = 200;
const CITY_MAX = 100;
const NOTES_MAX = 1000;

const PARSERS = { csv: csvParser, xlsx: xlsxParser } as const;

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

/** Dosya adını güvenli bir taban ada indirger (yol ayırıcıları ve kontrol karakterleri atılır, en çok 200). */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return (clean || "import").slice(0, 200);
}

/** Boyut + biçim + ayrıştırma. Her hata `ImportError` (kodlu). */
export function parseUpload(file: UploadedFile): { format: ImportFormat; table: ParsedTable } {
  if (file.bytes.byteLength > IMPORT_LIMITS.maxBytes)
    throw new ImportError("IMPORT_TOO_LARGE", "Dosya 5 MB sınırını aşıyor.");
  const format = detectImportFormat(file.filename, file.bytes.subarray(0, 4));
  if (!format)
    throw new ImportError("IMPORT_UNSUPPORTED", "Yalnızca .csv ve .xlsx dosyaları desteklenir.");
  if (file.bytes.byteLength === 0) throw new ImportError("IMPORT_EMPTY", "Dosya boş.");
  return { format, table: PARSERS[format].parse(file.bytes) };
}

export interface ImportPreview {
  format: ImportFormat;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
  suggestedMapping: ImportMapping;
  warnings: ImportWarning[];
}

/** Durumsuz önizleme: hiçbir şey yazılmaz. */
export function previewImport(file: UploadedFile): ImportPreview {
  const { format, table } = parseUpload(file);
  return {
    format,
    headers: table.headers,
    sampleRows: table.rows.slice(0, IMPORT_LIMITS.previewRows),
    totalRows: table.rows.length,
    suggestedMapping: suggestMapping(table.headers),
    warnings: table.warnings ?? [],
  };
}

/** İçe aktarma isteğinin `meta` alanı (çok parçalı formda JSON metni). */
export const importMetaSchema = z
  .object({
    mapping: mappingSchema,
    defaultCountry: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isKnownCountry, "Bilinmeyen ülke.")
      .nullish(),
    categoryKey: z.string().trim().min(1).max(64).nullish(),
    sourceNote: z.string().trim().max(200).optional(),
    usageAck: z.boolean().optional(),
    /** Yalnızca sınıflandır ve say; hiçbir şey yazma ("Kontrol et"). Onay gerekmez. */
    dryRun: z.boolean().optional(),
  })
  .strict();
export type ImportMeta = z.infer<typeof importMetaSchema>;

export interface ImportCandidate {
  row: number;
  displayName: string;
  countryCode: string;
  city: string | null;
  categoryKey: string | null;
  website: string | null;
  email: string | null;
  notes: string | null;
  /** `domain`: web sitesi kopya anahtarı (`websiteKey`: kayıtlı alan adı veya paylaşımlı platformda sunucu + yol). */
  keys: { domain: string | null; email: string | null; name: string };
}

export interface ExistingKeys {
  /** Web sitesi kopya anahtarları (`websiteKey`). */
  domains: ReadonlySet<string>;
  emails: ReadonlySet<string>;
  names: ReadonlySet<string>;
}

export interface Classified {
  candidates: ImportCandidate[];
  duplicates: { row: number; reason: DuplicateReason }[];
  invalid: { row: number; reason: InvalidReason }[];
}

/** Ad + ülke + şehir kopya anahtarı. */
export function nameKey(name: string, country: string, city: string | null | undefined): string {
  return `${country}|${normaliseCity(city)}|${normaliseName(name)}`;
}

/**
 * Kategori değeri → bilinen anahtar. Eşleşenler (büyük/küçük harf ve aksan duyarsız): anahtar ("cafe"), tam ad
 * ("Kafe / kahveci"), adın "/" ile ayrılmış parçaları ("Kafe") ve Google yer türleri ("coffee_shop" → "coffee shop").
 */
export function categoryResolver(
  categories: readonly { key: string; name: string; placeTypes?: readonly string[] }[],
): (v: string) => string | null {
  const map = new Map<string, string>();
  const add = (label: string, key: string) => {
    const k = normaliseCity(label);
    if (k && !map.has(k)) map.set(k, key);
  };
  for (const c of categories) add(c.key, c.key);
  for (const c of categories) {
    add(c.name, c.key);
    for (const part of c.name.split("/")) add(part, c.key);
    for (const pt of c.placeTypes ?? []) add(pt.replace(/_/g, " "), c.key);
  }
  return (v) => map.get(normaliseCity(v)) ?? null;
}

/**
 * Satırları sınıflandırır (saf). Geçersizlik sırası: ad → ülke → web sitesi → e-posta. Kopya sırası (ilk eşleşen
 * neden raporlanır): web sitesi alan adı → e-posta → ad+ülke+şehir; her anahtar için önce mevcut kayıtlar, sonra
 * dosyanın önceki satırları (`in_file`).
 */
export function classifyRows(
  table: ParsedTable,
  mapping: ImportMapping,
  opts: {
    defaultCountry: string | null;
    categoryKey: string | null;
    resolveCategory: (v: string) => string | null;
  },
  existing: ExistingKeys,
): Classified {
  const out: Classified = { candidates: [], duplicates: [], invalid: [] };
  const seen = { domains: new Set<string>(), emails: new Set<string>(), names: new Set<string>() };
  const cell = (r: string[], i: number | null) => (i === null ? "" : (r[i] ?? "").trim());
  table.rows.forEach((r, idx) => {
    const row = table.rowNumbers?.[idx] ?? idx + 2;
    const bad = (reason: InvalidReason) => out.invalid.push({ row, reason });
    const displayName = cleanText(cell(r, mapping.name), NAME_MAX);
    if (!displayName || !normaliseName(displayName)) return bad("no_name");
    const countryRaw = cell(r, mapping.country);
    let countryCode: string | null;
    if (countryRaw) {
      countryCode = resolveCountry(countryRaw);
      if (!countryCode) return bad("bad_country");
    } else countryCode = opts.defaultCountry;
    if (!countryCode) return bad("no_country");
    const websiteRaw = cell(r, mapping.website);
    const website = websiteRaw ? normaliseWebsite(websiteRaw) : null;
    if (websiteRaw && !website) return bad("bad_website");
    const emailRaw = cell(r, mapping.email).split(/[;,\s]+/)[0] ?? "";
    const email = emailRaw ? (parseEmail(emailRaw)?.email ?? null) : null;
    if (emailRaw && !email) return bad("bad_email");
    const city = cleanText(cell(r, mapping.city), CITY_MAX);
    const categoryRaw = cell(r, mapping.category);
    const categoryKey = (categoryRaw && opts.resolveCategory(categoryRaw)) || opts.categoryKey;

    const keys = {
      domain: websiteKey(website),
      email,
      name: nameKey(displayName, countryCode, city),
    };
    const dup = (reason: DuplicateReason) => out.duplicates.push({ row, reason });
    if (keys.domain && existing.domains.has(keys.domain)) return dup("same_website");
    if (keys.domain && seen.domains.has(keys.domain)) return dup("in_file");
    if (keys.email && existing.emails.has(keys.email)) return dup("same_email");
    if (keys.email && seen.emails.has(keys.email)) return dup("in_file");
    if (existing.names.has(keys.name)) return dup("same_name_city");
    if (seen.names.has(keys.name)) return dup("in_file");
    if (keys.domain) seen.domains.add(keys.domain);
    if (keys.email) seen.emails.add(keys.email);
    seen.names.add(keys.name);
    out.candidates.push({
      row,
      displayName,
      countryCode,
      city,
      categoryKey: categoryKey || null,
      website,
      email,
      notes: cleanText(cell(r, mapping.notes), NOTES_MAX),
      keys,
    });
  });
  return out;
}

/** SQL `IN` yerine tek JSON parametresi (SQLite değişken sınırına takılmaz). */
const jsonList = (values: readonly string[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * Kopya denetimi için mevcut ARŞİVLENMEMİŞ kayıtların anahtarları. Sorgular dosyadaki adaylarla sınırlıdır
 * (ülkeler, alan adları, e-postalar); satır başına sorgu yoktur (sabit 4 sorgu).
 */
export async function loadExistingKeys(
  tx: DbExecutor,
  probe: { countries: string[]; domains: string[]; emails: string[] },
): Promise<ExistingKeys> {
  const notArchived = isNull(leads.archivedAt);
  const names = new Set<string>();
  const domains = new Set<string>();
  const emails = new Set<string>();
  if (probe.countries.length) {
    // Google kaynaklı lead'lerde ad yalnızca oturum önbelleğindedir: bellekte karşılaştırılır, yazılmaz.
    const rows = await tx
      .select({
        name: sql<string | null>`coalesce(${leads.displayName}, ${placeCache.name})`,
        city: leads.city,
        country: leads.countryCode,
        website: leads.website,
        cacheWebsite: placeCache.website,
      })
      .from(leads)
      .leftJoin(placeCache, eq(placeCache.placeId, leads.placeId))
      .where(and(notArchived, sql`${leads.countryCode} IN ${jsonList(probe.countries)}`));
    for (const r of rows) {
      if (r.name && r.country) names.add(nameKey(r.name, r.country, r.city));
      for (const w of [r.website, r.cacheWebsite]) {
        const d = w ? websiteKey(normaliseWebsite(w)) : null;
        if (d) domains.add(d);
      }
    }
  }
  if (probe.domains.length) {
    // Başka ülkedeki aynı site de kopyadır: kendi taramamızın alan adı (dizinli) ve kullanıcı siteleri.
    // Taramada yalnızca kayıtlı alan adı saklanır: paylaşımlı platformlar (facebook.com…) işletmeyi tanımlamadığı
    // için bu sorguya girmez; onlar yalnızca sunucu + yol anahtarıyla karşılaştırılır.
    const plain = probe.domains.filter((d) => !d.includes("/") && !SHARED_SITE_DOMAINS.has(d));
    if (plain.length) {
      const crawled = await tx
        .select({ d: leadEnrichment.siteDomain })
        .from(leadEnrichment)
        .innerJoin(leads, eq(leads.id, leadEnrichment.leadId))
        .where(and(notArchived, sql`${leadEnrichment.siteDomain} IN ${jsonList(plain)}`));
      for (const r of crawled) if (r.d && !SHARED_SITE_DOMAINS.has(r.d)) domains.add(r.d);
    }
    // Kullanıcının verdiği siteler: yalnızca içe aktarma/sicil lead'leri (Google lead'lerinde bu sütun hep boştur);
    // `leads_source_idx` ile tüm tablo taranmaz. Anahtar saklanmadığı için adresler TEK doğrusal okumayla gelir ve
    // `websiteKey` bellekte bir kez hesaplanıp dosyanın anahtar kümesinde (Set, O(1)) aranır: O(lead + dosya).
    // Önceki `EXISTS (json_each(...) WHERE instr(...))` süzgeci her satırı her alan adıyla karşılaştırıyordu
    // (O(lead × dosya); 20 bin lead × 5 bin satır ≈ 100 milyon `instr`, yazma işlemi kilidinin içinde).
    const wanted = new Set(probe.domains);
    const own = await tx
      .select({ w: leads.website })
      .from(leads)
      .where(
        and(notArchived, inArray(leads.source, ["import", "registry"]), isNotNull(leads.website)),
      );
    for (const r of own) {
      const d = websiteKey(r.w);
      if (d && wanted.has(d)) domains.add(d);
    }
  }
  if (probe.emails.length) {
    const rows = await tx
      .select({ e: leadEmails.email })
      .from(leadEmails)
      .innerJoin(leads, eq(leads.id, leadEmails.leadId))
      .where(and(notArchived, sql`${leadEmails.email} IN ${jsonList(probe.emails)}`));
    for (const r of rows) emails.add(r.e);
  }
  return { domains, emails, names };
}

export interface ImportBatchDto {
  id: number;
  filename: string;
  format: ImportFormat;
  sourceNote: string;
  usageAckAt: number;
  mapping: Record<string, number | null>;
  rowCount: number;
  createdCount: number;
  duplicateCount: number;
  invalidCount: number;
  createdAt: number;
  /** Partinin hâlâ listede (arşivlenmemiş) olan lead sayısı. */
  activeCount: number;
  /**
   * "Geri al" ile arşivlenmiş ve henüz geri getirilmemiş lead sayısı ("Geri getir" bunları hedefler). Kullanıcının
   * tek tek veya toplu arşivlediği lead'ler sayılmaz, geri getirilmez.
   */
  restorableCount: number;
}

export interface ImportResult {
  dryRun: boolean;
  batch: ImportBatchDto | null;
  rowCount: number;
  created: number;
  duplicateCount: number;
  invalidCount: number;
  duplicates: { row: number; reason: DuplicateReason }[];
  invalid: { row: number; reason: InvalidReason }[];
  /** Listeler `REPORT_LIST_MAX`'ta kesildi mi? */
  truncated: boolean;
}

/** Ön tarama: kopya sorgularının dar tutulması için dosyadaki olası anahtarlar. */
function probeOf(table: ParsedTable, mapping: ImportMapping, defaultCountry: string | null) {
  const countries = new Set<string>();
  const domains = new Set<string>();
  const emails = new Set<string>();
  if (defaultCountry) countries.add(defaultCountry);
  for (const r of table.rows) {
    const c = mapping.country === null ? null : resolveCountry(r[mapping.country]);
    if (c) countries.add(c);
    const d = mapping.website === null ? null : websiteKey(normaliseWebsite(r[mapping.website]));
    if (d) domains.add(d);
    const e =
      mapping.email === null
        ? null
        : parseEmail((r[mapping.email] ?? "").trim().split(/[;,\s]+/)[0] ?? "")?.email;
    if (e) emails.add(e);
  }
  return { countries: [...countries], domains: [...domains], emails: [...emails] };
}

/**
 * İçe aktarır (veya `dryRun` ile yalnızca sayar). Onay ve kaynak notu yalnızca gerçek yazmada zorunludur
 * (`IMPORT_ACK_REQUIRED`). Eşleme dosyaya uymuyorsa `IMPORT_MAPPING`.
 */
export async function commitImport(
  db: Db,
  file: UploadedFile,
  meta: ImportMeta,
  now: number = Date.now(),
): Promise<ImportResult> {
  const dryRun = meta.dryRun === true;
  const sourceNote = meta.sourceNote?.trim() ?? "";
  if (!dryRun && (meta.usageAck !== true || sourceNote.length < 3))
    throw new ImportError(
      "IMPORT_ACK_REQUIRED",
      "Listeyi kullanma hakkınızı onaylayın ve kaynağını yazın.",
    );
  const { format, table } = parseUpload(file);
  const defaultCountry = meta.defaultCountry ?? null;
  const mapping = meta.mapping;
  requireUsableMapping(mapping, table.headers.length, defaultCountry);
  const probe = probeOf(table, mapping, defaultCountry);

  const run = async (tx: DbExecutor): Promise<ImportResult> => {
    const categories = await tx
      .select({
        key: categorySets.key,
        name: categorySets.name,
        placeTypes: categorySets.placeTypes,
      })
      .from(categorySets);
    const batchCategory =
      meta.categoryKey && categories.some((c) => c.key === meta.categoryKey)
        ? meta.categoryKey
        : null;
    const existing = await loadExistingKeys(tx, probe);
    const c = classifyRows(
      table,
      mapping,
      { defaultCountry, categoryKey: batchCategory, resolveCategory: categoryResolver(categories) },
      existing,
    );
    const result: ImportResult = {
      dryRun,
      batch: null,
      rowCount: table.rows.length,
      created: c.candidates.length,
      duplicateCount: c.duplicates.length,
      invalidCount: c.invalid.length,
      duplicates: c.duplicates.slice(0, REPORT_LIST_MAX),
      invalid: c.invalid.slice(0, REPORT_LIST_MAX),
      truncated: c.duplicates.length > REPORT_LIST_MAX || c.invalid.length > REPORT_LIST_MAX,
    };
    if (dryRun) return result;

    const [batch] = await tx
      .insert(importBatches)
      .values({
        filename: sanitiseFilename(file.filename),
        format,
        sourceNote: sourceNote.slice(0, 200),
        usageAckAt: now,
        mapping: { ...mapping },
        rowCount: result.rowCount,
        createdCount: result.created,
        duplicateCount: result.duplicateCount,
        invalidCount: result.invalidCount,
        createdAt: now,
      })
      .returning();
    const links: { batchId: number; leadId: number; rowNumber: number }[] = [];
    const withEmail: { leadId: number; cand: ImportCandidate }[] = [];
    for (const part of chunk(c.candidates, WRITE_CHUNK)) {
      const inserted = await tx
        .insert(leads)
        .values(
          part.map((x) => ({
            source: "import" as const,
            displayName: x.displayName,
            countryCode: x.countryCode,
            city: x.city,
            categoryKey: x.categoryKey,
            website: x.website,
            notes: x.notes,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .returning({
          id: leads.id,
          displayName: leads.displayName,
          countryCode: leads.countryCode,
          city: leads.city,
        });
      // RETURNING sırası garanti değildir: satırlar (ad, ülke, şehir) ile eşlenir. Ad anahtarı dosya içinde tekil
      // olduğundan bu üçlü de tekildir (aynı üçlü → aynı anahtar → `in_file`).
      const byTuple = new Map(
        part.map((x) => [`${x.displayName}\u0000${x.countryCode}\u0000${x.city ?? ""}`, x]),
      );
      for (const r of inserted) {
        const cand = byTuple.get(`${r.displayName}\u0000${r.countryCode}\u0000${r.city ?? ""}`);
        if (!cand) throw new Error("import: eklenen satır eşlenemedi");
        links.push({ batchId: batch!.id, leadId: r.id, rowNumber: Math.max(1, cand.row) });
        if (cand.email) withEmail.push({ leadId: r.id, cand });
      }
    }
    for (const part of chunk(links, WRITE_CHUNK)) await tx.insert(importBatchLeads).values(part);
    for (const part of chunk(withEmail, WRITE_CHUNK)) {
      await tx.insert(leadEmails).values(
        part.map(({ leadId, cand }) => {
          const parsed = parseEmail(cand.email!)!;
          const host = cand.website ? new URL(cand.website).hostname : null;
          return {
            leadId,
            email: parsed.email,
            domain: parsed.domain,
            kind: classifyKind(parsed),
            sourceUrl: null,
            sourceType: "manual" as const,
            siteMatch: host ? domainMatchesSite(parsed.domain, host) : true,
            verifyStatus: "unverified" as const,
            verifyReason: null,
            verifiedAt: null,
            isPrimary: true,
            foundAt: now,
            updatedAt: now,
          };
        }),
      );
      // Elle ekleme yolu ile aynı: adres varsa e-posta araması "tamamlandı", durum "doğrulanmamış bulundu".
      await tx.insert(leadEnrichment).values(
        part.map(({ leadId }) => ({
          leadId,
          status: "done" as const,
          emailStatus: "found_unverified" as const,
          completedAt: now,
          updatedAt: now,
        })),
      );
    }
    await audit(
      tx,
      "import.batch",
      "import_batch",
      batch!.id,
      {
        format,
        rows: result.rowCount,
        created: result.created,
        duplicates: result.duplicateCount,
        invalid: result.invalidCount,
        emails: withEmail.length,
      },
      now,
    );
    result.batch = { ...toDto(batch!), activeCount: result.created, restorableCount: 0 };
    return result;
  };
  // Kontrol (dryRun) yazmaz: yazma kilidi almadan okur. Gerçek içe aktarma okuma + yazmayı tek işlemde yapar.
  return dryRun ? run(db) : db.transaction(run);
}

function toDto(
  b: typeof importBatches.$inferSelect,
): Omit<ImportBatchDto, "activeCount" | "restorableCount"> {
  return {
    id: b.id,
    filename: b.filename,
    format: b.format,
    sourceNote: b.sourceNote,
    usageAckAt: b.usageAckAt,
    mapping: b.mapping,
    rowCount: b.rowCount,
    createdCount: b.createdCount,
    duplicateCount: b.duplicateCount,
    invalidCount: b.invalidCount,
    createdAt: b.createdAt,
  };
}

// Tek tablolu SELECT'te drizzle sütunları nitelemeden yazar; ilişkili alt sorguda dış sütun açıkça nitelenir.
const activeCountSql = sql<number>`(SELECT count(*) FROM "import_batch_leads" ibl INNER JOIN "leads" l ON l."id" = ibl."lead_id" WHERE ibl."batch_id" = "import_batches"."id" AND l."archived_at" IS NULL)`;

const ARCHIVE_ACTION = "import.archive";

/**
 * Partilerin "Geri al" zamanları (denetim kaydından: `import.archive` satırının `at` değeri, arşivlenen lead'lerin
 * `archived_at` değerine eşittir). Şemaya sütun eklemeden geri getirmenin yalnızca geri alma ile arşivlenen lead'leri
 * hedeflemesini sağlar. Tek sorgu.
 */
async function undoTimes(
  tx: DbExecutor,
  batchIds: readonly number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!batchIds.length) return out;
  const rows = await tx
    .select({ id: auditLog.entityId, at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, ARCHIVE_ACTION),
        eq(auditLog.entity, "import_batch"),
        sql`${auditLog.entityId} IN ${jsonList(batchIds.map(String))}`,
      ),
    );
  for (const r of rows) {
    const id = Number(r.id);
    out.set(id, [...(out.get(id) ?? []), r.at]);
  }
  return out;
}

/** Partiler başına geri getirilebilir (geri alma ile arşivlenmiş) lead sayısı: tek gruplu sorgu + bellekte eşleme. */
async function restorableCounts(
  tx: DbExecutor,
  batchIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const times = await undoTimes(tx, batchIds);
  if (!times.size) return out;
  const rows = await tx
    .select({ b: importBatchLeads.batchId, at: leads.archivedAt, n: sql<number>`count(*)` })
    .from(importBatchLeads)
    .innerJoin(leads, eq(leads.id, importBatchLeads.leadId))
    .where(
      and(
        sql`${importBatchLeads.batchId} IN ${jsonList([...times.keys()].map(String))}`,
        isNotNull(leads.archivedAt),
      ),
    )
    .groupBy(importBatchLeads.batchId, leads.archivedAt);
  for (const r of rows)
    if (r.at !== null && times.get(r.b)?.includes(r.at))
      out.set(r.b, (out.get(r.b) ?? 0) + Number(r.n));
  return out;
}

/** Son partiler (yeniden eskiye). Etkin sayı tek sorguda, ilişkili alt sorgu ile (PK önekiyle dizinli). */
export async function listImportBatches(db: Db, limit = 20): Promise<ImportBatchDto[]> {
  const rows = await db
    .select({ b: importBatches, active: activeCountSql })
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(Math.min(Math.max(limit, 1), 50));
  const restorable = await restorableCounts(
    db,
    rows.map((r) => r.b.id),
  );
  return rows.map((r) => ({
    ...toDto(r.b),
    activeCount: Number(r.active),
    restorableCount: restorable.get(r.b.id) ?? 0,
  }));
}

export async function getImportBatch(db: DbExecutor, id: number): Promise<ImportBatchDto | null> {
  const [r] = await db
    .select({ b: importBatches, active: activeCountSql })
    .from(importBatches)
    .where(eq(importBatches.id, id));
  if (!r) return null;
  const restorable = await restorableCounts(db, [id]);
  return { ...toDto(r.b), activeCount: Number(r.active), restorableCount: restorable.get(id) ?? 0 };
}

export class ImportBatchNotFoundError extends Error {
  constructor() {
    super("İçe aktarma bulunamadı.");
    this.name = "ImportBatchNotFoundError";
  }
}

export interface BatchArchiveResult {
  batch: ImportBatchDto;
  /** Bu çağrıda arşivlenen (veya geri getirilen) lead sayısı. */
  changed: number;
  /** Etkin kampanya dizisinde olduğu için arşivlenmeyen lead sayısı (yalnızca geri almada). */
  skippedActive: number;
  /**
   * Geri getirmede: listede artık aynı işletme (aynı web sitesi, e-posta veya ad + ülke + şehir) bulunduğu için
   * arşivde bırakılan lead sayısı (ör. geri alındıktan sonra aynı dosya yeniden içe aktarıldıysa). Geri almada 0.
   */
  skippedDuplicate: number;
}

const batchLeadIds = (batchId: number) =>
  sql`${leads.id} IN (SELECT ${importBatchLeads.leadId} FROM ${importBatchLeads} WHERE ${importBatchLeads.batchId} = ${batchId})`;
const inActiveSequence = sql`EXISTS (SELECT 1 FROM ${campaignLeads} WHERE ${campaignLeads.leadId} = ${leads.id} AND ${inArray(campaignLeads.status, [...ACTIVE_SEQUENCE])})`;

/**
 * Partiyi geri alır: partinin lead'leri ARŞİVLENİR (yumuşak silme, keşif listesinden kalkar; "Geri getir" ile döner).
 * Etkin kampanya dizisindeki lead'ler arşivlenmez (`skippedActive`; toplu arşivle aynı kural). Koşul UPDATE'in
 * içindedir: tekrar çağrı değişiklik yapmaz (idempotent). `archived_at` = denetim satırının `at` değeridir.
 *
 * Geri getirme yalnızca bu partinin GERİ ALMA ile arşivlenmiş lead'lerini döndürür (kullanıcının ayrıca arşivlediği
 * lead'ler arşivde kalır) ve dönmeden önce kopya denetimi yapar: listede artık aynı işletme varsa (ör. geri alındıktan
 * sonra aynı dosya yeniden içe aktarıldı) o lead arşivde kalır (`skippedDuplicate`); aynı işletme iki kez listelenip
 * iki kez iletişime geçilmez. Tekrar çağrı değişiklik yapmaz.
 */
export async function setBatchArchived(
  db: Db,
  batchId: number,
  archived: boolean,
  now: number = Date.now(),
): Promise<BatchArchiveResult> {
  return db.transaction(async (tx) => {
    if (!(await getImportBatch(tx, batchId))) throw new ImportBatchNotFoundError();
    let changed = 0;
    let skippedActive = 0;
    let skippedDuplicate = 0;
    if (archived) {
      const rows = await tx
        .update(leads)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(batchLeadIds(batchId), isNull(leads.archivedAt), sql`NOT ${inActiveSequence}`))
        .returning({ id: leads.id });
      changed = rows.length;
      const [r] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(and(batchLeadIds(batchId), isNull(leads.archivedAt), inActiveSequence));
      skippedActive = Number(r?.n ?? 0);
    } else {
      const r = await restoreBatchLeads(tx, batchId, now);
      changed = r.changed;
      skippedDuplicate = r.skippedDuplicate;
    }
    // Geri almanın `at` değeri, arşivlenen lead'lerin `archived_at` değeridir: geri getirme hedefini buradan bulur.
    await audit(
      tx,
      archived ? ARCHIVE_ACTION : "import.restore",
      "import_batch",
      batchId,
      archived ? { changed, skippedActive } : { changed, skippedDuplicate },
      now,
    );
    const batch = (await getImportBatch(tx, batchId))!;
    return { batch, changed, skippedActive, skippedDuplicate };
  });
}

/** Geri getirme: hedef lead'ler, kopya denetimi (mevcut etkin lead'ler + geri dönenlerin kendi aralarında), tek UPDATE. */
async function restoreBatchLeads(
  tx: DbExecutor,
  batchId: number,
  now: number,
): Promise<{ changed: number; skippedDuplicate: number }> {
  const times = (await undoTimes(tx, [batchId])).get(batchId) ?? [];
  if (!times.length) return { changed: 0, skippedDuplicate: 0 };
  const targets = await tx
    .select({
      id: leads.id,
      name: leads.displayName,
      country: leads.countryCode,
      city: leads.city,
      website: leads.website,
    })
    .from(leads)
    .where(
      and(
        batchLeadIds(batchId),
        sql`${leads.archivedAt} IN (SELECT value FROM json_each(${JSON.stringify(times)}))`,
      ),
    )
    .orderBy(leads.id);
  if (!targets.length) return { changed: 0, skippedDuplicate: 0 };
  const emailsBy = new Map<number, string[]>();
  for (const part of chunk(targets, WRITE_CHUNK)) {
    const rows = await tx
      .select({ leadId: leadEmails.leadId, email: leadEmails.email })
      .from(leadEmails)
      .where(
        inArray(
          leadEmails.leadId,
          part.map((x) => x.id),
        ),
      );
    for (const r of rows) emailsBy.set(r.leadId, [...(emailsBy.get(r.leadId) ?? []), r.email]);
  }
  const keyed = targets.map((x) => ({
    id: x.id,
    site: websiteKey(x.website),
    emails: emailsBy.get(x.id) ?? [],
    name: x.name && x.country ? nameKey(x.name, x.country, x.city) : null,
    country: x.country,
  }));
  // Geri getirilecekler şu an arşivde olduğu için `loadExistingKeys` (yalnızca arşivlenmemişler) onları saymaz.
  const existing = await loadExistingKeys(tx, {
    countries: [...new Set(keyed.flatMap((k) => (k.country ? [k.country] : [])))],
    domains: [...new Set(keyed.flatMap((k) => (k.site ? [k.site] : [])))],
    emails: [...new Set(keyed.flatMap((k) => k.emails))],
  });
  const seen = { domains: new Set<string>(), emails: new Set<string>(), names: new Set<string>() };
  const ok: number[] = [];
  let skippedDuplicate = 0;
  for (const k of keyed) {
    const clash =
      (k.site !== null && (existing.domains.has(k.site) || seen.domains.has(k.site))) ||
      k.emails.some((e) => existing.emails.has(e) || seen.emails.has(e)) ||
      (k.name !== null && (existing.names.has(k.name) || seen.names.has(k.name)));
    if (clash) {
      skippedDuplicate++;
      continue;
    }
    if (k.site) seen.domains.add(k.site);
    for (const e of k.emails) seen.emails.add(e);
    if (k.name) seen.names.add(k.name);
    ok.push(k.id);
  }
  let changed = 0;
  for (const part of chunk(ok, WRITE_CHUNK)) {
    const rows = await tx
      .update(leads)
      .set({ archivedAt: null, updatedAt: now })
      .where(inArray(leads.id, part))
      .returning({ id: leads.id });
    changed += rows.length;
  }
  return { changed, skippedDuplicate };
}
