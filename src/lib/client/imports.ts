import type {
  BatchArchiveResult,
  DuplicateReason,
  ImportBatchDto,
  ImportPreview,
  ImportResult,
  InvalidReason,
} from "@/lib/import/service";
import type { ImportMapping } from "@/lib/import/types";
import { api } from "./api";

/**
 * CSV/XLSX içe aktarma istemcisi (Faz 5, paket I). Tipler sunucu modülünden YALNIZCA tip olarak alınır. Dosya her
 * çağrıda yeniden gönderilir (önizleme durumsuzdur; sunucuda satır saklanmaz). Değişiklik yapan çağrılar tek denemedir:
 * içe aktarma kopya denetimi sayesinde güvenle yeniden denenebilir (ikinci deneme yeni lead oluşturmaz).
 */
export type {
  BatchArchiveResult,
  DuplicateReason,
  ImportBatchDto,
  ImportMapping,
  ImportPreview,
  ImportResult,
  InvalidReason,
};

export interface ImportOptions {
  mapping: Omit<ImportMapping, "name"> & { name: number | null };
  defaultCountry: string | null;
  categoryKey: string | null;
  sourceNote: string;
  usageAck: boolean;
}

export const importsKey = ["imports"] as const;

function form(file: File, meta?: unknown): FormData {
  const fd = new FormData();
  fd.set("file", file, file.name);
  if (meta !== undefined) fd.set("meta", JSON.stringify(meta));
  return fd;
}

export const importsApi = {
  preview: (file: File) =>
    api<ImportPreview>("/api/imports/preview", { method: "POST", body: form(file) }),
  check: (file: File, o: ImportOptions) =>
    api<ImportResult>("/api/imports", { method: "POST", body: form(file, { ...o, dryRun: true }) }),
  run: (file: File, o: ImportOptions) =>
    api<ImportResult>("/api/imports", { method: "POST", body: form(file, o) }),
  list: () => api<{ batches: ImportBatchDto[] }>("/api/imports?limit=20").then((r) => r.batches),
  archive: (id: number) =>
    api<BatchArchiveResult>(`/api/imports/${id}/archive`, { method: "POST" }),
  restore: (id: number) =>
    api<BatchArchiveResult>(`/api/imports/${id}/restore`, { method: "POST" }),
};

export interface ReportRow {
  row: number;
  kind: "duplicate" | "invalid";
  reason: DuplicateReason | InvalidReason;
}

/** Rapor satırları, satır numarasına göre sıralı (geçersizler ve kopyalar birlikte). */
export function reportRows(result: Pick<ImportResult, "duplicates" | "invalid">): ReportRow[] {
  return [
    ...result.invalid.map((r) => ({ row: r.row, kind: "invalid" as const, reason: r.reason })),
    ...result.duplicates.map((r) => ({ row: r.row, kind: "duplicate" as const, reason: r.reason })),
  ].sort((a, b) => a.row - b.row || a.kind.localeCompare(b.kind));
}

/**
 * Satır raporunu CSV metnine çevirir: yalnızca satır numarası, tür ve neden (hücre içeriği YOK, kişisel veri
 * taşımaz). Excel'in Türkçe karakterleri doğru açması için UTF-8 BOM ile başlar.
 */
export function reportCsv(
  rows: readonly ReportRow[],
  text: (r: ReportRow) => [string, string],
  header: readonly [string, string, string],
): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [header.map(q).join(",")];
  for (const r of rows) {
    const [kind, reason] = text(r);
    lines.push([String(r.row), q(kind), q(reason)].join(","));
  }
  return `\ufeff${lines.join("\r\n")}\r\n`;
}
