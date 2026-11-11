import type { CsvImportPreview } from "@/lib/compliance/suppression";
import { ApiError, api } from "./api";

export type { CsvImportPreview };

/**
 * Onay kapılı CSV içe aktarma istemcisi (C13). `dryRun` hiçbir şey yazmaz. Geri alınamaz kayıt içeren dosya yalnızca
 * `confirmIrreversible` ile içe aktarılır; aksi halde sunucu 409 `CONFIRMATION_REQUIRED` ve güncel önizlemeyi döner.
 */
export const suppressionImportApi = {
  preview: (csv: string) =>
    api<CsvImportPreview>("/api/compliance/suppressions/import", {
      method: "POST",
      json: { csv, dryRun: true },
    }),
  run: (csv: string, confirmIrreversible: boolean) =>
    api<CsvImportPreview>("/api/compliance/suppressions/import", {
      method: "POST",
      json: confirmIrreversible ? { csv, confirmIrreversible: true } : { csv },
    }),
};

/** 409 `CONFIRMATION_REQUIRED` yanıtındaki güncel önizleme; başka hata ise null. */
export function confirmationPreview(error: unknown): CsvImportPreview | null {
  if (!(error instanceof ApiError) || error.code !== "CONFIRMATION_REQUIRED") return null;
  const p = error.body?.preview;
  return p && typeof p === "object" ? (p as CsvImportPreview) : null;
}
