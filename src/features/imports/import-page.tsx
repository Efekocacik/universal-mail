"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  ListChecks,
  RotateCcw,
  Search,
  Undo2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, FieldHint, Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Notice, Stat } from "@/features/campaigns/parts";
import { ScansSubnav } from "@/features/scans/scans-subnav";
import { errorText } from "@/lib/client/api";
import { fmtDate, fmtNumber } from "@/lib/client/format";
import {
  importsApi,
  importsKey,
  reportCsv,
  reportRows,
  type ImportBatchDto,
  type ImportOptions,
  type ImportPreview,
  type ImportResult,
} from "@/lib/client/imports";
import { invalidateLeadViews } from "@/lib/client/leads-bulk";
import { useCategories } from "@/lib/client/queries";
import { countryOptions } from "@/lib/geo/countries";
import { getLocale, t, type TrKey } from "@/lib/i18n";
import {
  blockers,
  columnLabel,
  FIELD_ORDER,
  fieldsByColumn,
  fileProblem,
  takenTwice,
  type FieldName,
  type UiMapping,
} from "./import-model";

/**
 * `/scans/import`: (1) dosya seçimi → durumsuz önizleme, (2) sütun eşleme (öneriyle dolu) + ilk satırlar,
 * (3) varsayılan ülke/kategori, kaynak notu ve zorunlu kullanım onayı → "Kontrol et" (yazmadan sayar) / "İçe aktar",
 * sonuç özeti (atlanan satırlar + CSV raporu + Keşif bağlantısı) ve geçmiş (geri al / geri getir).
 */
export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mapping, setMapping] = useState<UiMapping | null>(null);
  const [defaultCountry, setDefaultCountry] = useState<string | null>(null);
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [sourceNote, setSourceNote] = useState("");
  const [usageAck, setUsageAck] = useState(false);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const qc = useQueryClient();
  const resultRef = useRef<HTMLHeadingElement>(null);
  // En son seçilen dosya: geç gelen eski önizleme/kontrol yanıtları (dosya A yavaş, sonra B seçildi) yok sayılır;
  // aksi hâlde ekranda B görünürken A'nın önizlemesi ve eşlemesi kurulur, "İçe aktar" A'yı yükler.
  const latestFile = useRef<File | null>(null);

  const reset = () => {
    latestFile.current = null;
    setFile(null);
    setPreview(null);
    setProblem(null);
    setMapping(null);
    setCheck(null);
    setResult(null);
    setUsageAck(false);
    setSourceNote("");
    setInputKey((k) => k + 1);
  };

  const previewer = useMutation({
    mutationFn: (f: File) => importsApi.preview(f),
    retry: false,
    onSuccess: (p, f) => {
      if (f !== latestFile.current) return;
      setPreview(p);
      setMapping({ ...p.suggestedMapping });
      setFile(f);
    },
    onError: (e, f) => {
      if (f === latestFile.current) setProblem(errorText(e));
    },
  });

  const options: ImportOptions | null = mapping
    ? { mapping, defaultCountry, categoryKey, sourceNote, usageAck }
    : null;

  const checker = useMutation({
    mutationFn: (v: { file: File; o: ImportOptions }) => importsApi.check(v.file, v.o),
    retry: false,
    onSuccess: (r, v) => {
      if (v.file === latestFile.current) setCheck(r);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const importer = useMutation({
    mutationFn: (v: { file: File; o: ImportOptions }) => importsApi.run(v.file, v.o),
    retry: false,
    onSuccess: (r) => {
      setResult(r);
      invalidateLeadViews(qc);
      void qc.invalidateQueries({ queryKey: importsKey });
    },
    // Belirsiz sonuçta (ağ/503) yeniden denemek güvenlidir: kopya denetimi ikinci kez lead oluşturmaz.
    onError: (e) => toast.error(errorText(e)),
  });

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  // Eşleme veya varsayılanlar değişince eski kontrol sonucu geçersizdir.
  const setMap = (f: FieldName, v: number | null) => {
    setMapping((m) => (m ? { ...m, [f]: v } : m));
    setCheck(null);
  };

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <ScansSubnav />
        <PageHeader title={t("imports.title")} description={t("imports.subtitle")} />

        {result ? (
          <ResultCard
            result={result}
            headingRef={resultRef}
            fileName={file?.name ?? ""}
            onAgain={reset}
          />
        ) : (
          <>
            <FileSection
              inputKey={inputKey}
              file={file}
              preview={preview}
              problem={problem}
              pending={previewer.isPending}
              onChoose={(f) => {
                setProblem(null);
                setPreview(null);
                setMapping(null);
                setCheck(null);
                setFile(null);
                latestFile.current = f;
                if (!f) return;
                const p = fileProblem(f);
                if (p) return setProblem(t(p));
                previewer.mutate(f);
              }}
            />
            {preview && mapping && file && options && (
              <>
                <MappingSection preview={preview} mapping={mapping} onChange={setMap} />
                <DetailsSection
                  defaultCountry={defaultCountry}
                  categoryKey={categoryKey}
                  sourceNote={sourceNote}
                  usageAck={usageAck}
                  onCountry={(v) => {
                    setDefaultCountry(v);
                    setCheck(null);
                  }}
                  onCategory={(v) => {
                    setCategoryKey(v);
                    setCheck(null);
                  }}
                  onNote={setSourceNote}
                  onAck={setUsageAck}
                />
                <ActionBar
                  options={options}
                  check={check}
                  checking={checker.isPending}
                  importing={importer.isPending}
                  onCheck={() => checker.mutate({ file, o: options })}
                  onImport={() => importer.mutate({ file, o: options })}
                />
              </>
            )}
          </>
        )}
        <HistorySection />
      </div>
    </div>
  );
}

/* 1. Dosya ------------------------------------------------------------------------------------------------ */

function FileSection({
  inputKey,
  file,
  preview,
  problem,
  pending,
  onChoose,
}: {
  inputKey: number;
  file: File | null;
  preview: ImportPreview | null;
  problem: string | null;
  pending: boolean;
  onChoose: (f: File | null) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id={`${id}-h`} className="text-sm font-semibold">
        {t("imports.file.title")}
      </h2>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-file`}>{t("imports.file.label")}</Label>
        <Input
          key={inputKey}
          id={`${id}-file`}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="h-auto py-1.5"
          aria-describedby={`${id}-hint${problem ? ` ${id}-err` : ""}`}
          aria-invalid={problem ? true : undefined}
          data-testid="import-file"
          onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
        />
        <FieldHint id={`${id}-hint`}>{t("imports.file.hint")}</FieldHint>
        {problem && <FieldError id={`${id}-err`}>{problem}</FieldError>}
      </div>
      <div aria-live="polite" className="text-[13px]">
        {pending && <p className="text-muted-foreground">{t("imports.file.reading")}</p>}
        {preview && file && !pending && (
          <p data-testid="import-summary">
            {t("imports.file.summary", {
              name: file.name,
              format: preview.format.toUpperCase(),
              rows: fmtNumber(preview.totalRows),
              cols: fmtNumber(preview.headers.length),
            })}
          </p>
        )}
      </div>
      {preview && preview.warnings.length > 0 && (
        <Notice tone="warning">
          <ul className="space-y-0.5">
            {preview.warnings.map((w) => (
              <li key={w}>{t(`imports.warning.${w}` as TrKey)}</li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}

/* 2. Eşleme + önizleme ------------------------------------------------------------------------------------ */

function MappingSection({
  preview,
  mapping,
  onChange,
}: {
  preview: ImportPreview;
  mapping: UiMapping;
  onChange: (f: FieldName, v: number | null) => void;
}) {
  const id = useId();
  const twice = takenTwice(mapping);
  const byCol = fieldsByColumn(mapping);
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <h2 id={`${id}-h`} className="text-sm font-semibold">
          {t("imports.map.title")}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{t("imports.map.desc")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELD_ORDER.map((f) => {
          const value = mapping[f];
          const clash = value !== null && twice.has(value);
          return (
            <div key={f} className="space-y-1.5">
              <Label htmlFor={`${id}-${f}`}>
                {t(`imports.field.${f}`)}
                {f === "name" && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({t("imports.map.required")})
                  </span>
                )}
              </Label>
              <Select
                id={`${id}-${f}`}
                value={value === null ? "" : String(value)}
                aria-required={f === "name" ? true : undefined}
                aria-invalid={clash ? true : undefined}
                aria-describedby={clash ? `${id}-${f}-err` : undefined}
                data-testid={`import-map-${f}`}
                onChange={(e) => onChange(f, e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">{t("imports.map.none")}</option>
                {preview.headers.map((_, i) => (
                  <option key={i} value={i}>
                    {columnLabel(preview.headers, i)}
                  </option>
                ))}
              </Select>
              {clash && <FieldError id={`${id}-${f}-err`}>{t("imports.map.taken")}</FieldError>}
            </div>
          );
        })}
      </div>
      <div className="space-y-1.5">
        <h3 className="text-[13px] font-medium">{t("imports.preview.title")}</h3>
        <div
          role="region"
          aria-label={t("imports.preview.title")}
          tabIndex={0}
          className="um-scroll max-h-80 overflow-auto rounded-md border"
        >
          <table className="w-full min-w-max border-collapse text-left text-[12px]">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium text-muted-foreground">
                  #
                </th>
                {preview.headers.map((h, i) => {
                  const f = byCol.get(i);
                  return (
                    <th key={i} scope="col" className="px-2 py-1.5 align-bottom font-medium">
                      {f && (
                        <Badge variant="info" className="mb-1 block w-fit">
                          {t(`imports.field.${f}`)}
                        </Badge>
                      )}
                      <span className={f ? "" : "text-muted-foreground"}>
                        {columnLabel(preview.headers, i)}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.sampleRows.map((row, r) => (
                <tr key={r} className="border-t">
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">{r + 1}</td>
                  {row.map((cell, c) => (
                    <td key={c} className="max-w-56 truncate px-2 py-1" title={cell}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview.totalRows > preview.sampleRows.length && (
          <FieldHint>{t("imports.preview.more")}</FieldHint>
        )}
      </div>
    </section>
  );
}

/* 3. Varsayılanlar, kaynak ve onay ----------------------------------------------------------------------- */

function DetailsSection(p: {
  defaultCountry: string | null;
  categoryKey: string | null;
  sourceNote: string;
  usageAck: boolean;
  onCountry: (v: string | null) => void;
  onCategory: (v: string | null) => void;
  onNote: (v: string) => void;
  onAck: (v: boolean) => void;
}) {
  const id = useId();
  const locale = getLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const categories = useCategories();
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4 rounded-xl border bg-card p-4">
      <h2 id={`${id}-h`} className="text-sm font-semibold">
        {t("imports.details.title")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-country`}>{t("imports.defaultCountry")}</Label>
          <Select
            id={`${id}-country`}
            value={p.defaultCountry ?? ""}
            aria-describedby={`${id}-country-hint`}
            data-testid="import-default-country"
            onChange={(e) => p.onCountry(e.target.value || null)}
          >
            <option value="">{t("imports.defaultCountry.none")}</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
          <FieldHint id={`${id}-country-hint`}>{t("imports.defaultCountry.hint")}</FieldHint>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-cat`}>{t("imports.defaultCategory")}</Label>
          <Select
            id={`${id}-cat`}
            value={p.categoryKey ?? ""}
            aria-describedby={`${id}-cat-hint`}
            onChange={(e) => p.onCategory(e.target.value || null)}
          >
            <option value="">{t("imports.defaultCategory.none")}</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </Select>
          <FieldHint id={`${id}-cat-hint`}>{t("imports.defaultCategory.hint")}</FieldHint>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-note`}>{t("imports.sourceNote")}</Label>
        <Input
          id={`${id}-note`}
          value={p.sourceNote}
          maxLength={200}
          placeholder={t("imports.sourceNote.placeholder")}
          aria-describedby={`${id}-note-hint`}
          aria-required
          data-testid="import-source-note"
          onChange={(e) => p.onNote(e.target.value)}
        />
        <FieldHint id={`${id}-note-hint`}>{t("imports.sourceNote.hint")}</FieldHint>
      </div>
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={`${id}-ack`}
          checked={p.usageAck}
          aria-describedby={`${id}-ack-hint`}
          aria-required
          data-testid="import-ack"
          onCheckedChange={(v) => p.onAck(v === true)}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor={`${id}-ack`} className="font-medium">
            {t("imports.ack")}
          </Label>
          <FieldHint id={`${id}-ack-hint`}>{t("imports.ack.hint")}</FieldHint>
        </div>
      </div>
    </section>
  );
}

function ActionBar({
  options,
  check,
  checking,
  importing,
  onCheck,
  onImport,
}: {
  options: ImportOptions;
  check: ImportResult | null;
  checking: boolean;
  importing: boolean;
  onCheck: () => void;
  onImport: () => void;
}) {
  const id = useId();
  const forCheck = blockers(options, true);
  const forImport = blockers(options);
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={onCheck}
          disabled={forCheck.length > 0 || importing}
          loading={checking}
          title={t("imports.check.hint")}
          data-testid="import-check"
        >
          <ListChecks /> {t("imports.check")}
        </Button>
        <Button
          onClick={onImport}
          disabled={forImport.length > 0 || checking}
          loading={importing}
          aria-describedby={forImport.length ? `${id}-blockers` : undefined}
          data-testid="import-run"
        >
          <Upload /> {t("imports.run")}
        </Button>
      </div>
      <div aria-live="polite" className="text-[13px]">
        {check && (
          <p data-testid="import-check-result">
            {t("imports.check.result", {
              created: fmtNumber(check.created),
              duplicates: fmtNumber(check.duplicateCount),
              invalid: fmtNumber(check.invalidCount),
            })}
          </p>
        )}
        {forImport.length > 0 && (
          <ul id={`${id}-blockers`} className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {forImport.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* Sonuç --------------------------------------------------------------------------------------------------- */

const reasonKey = (r: string) => `imports.reason.${r}` as TrKey;

function downloadReport(result: ImportResult) {
  const csv = reportCsv(
    reportRows(result),
    (r) => [t(`imports.report.kind.${r.kind}`), t(reasonKey(r.reason))],
    [t("imports.report.row"), t("imports.report.kind"), t("imports.report.reason")],
  );
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${t("imports.report.filename")}-${result.batch?.id ?? "kontrol"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ResultCard({
  result,
  headingRef,
  fileName,
  onAgain,
}: {
  result: ImportResult;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  fileName: string;
  onAgain: () => void;
}) {
  const rows = reportRows(result);
  return (
    <section
      aria-labelledby="import-result-h"
      className="space-y-4 rounded-xl border bg-card p-4"
      data-testid="import-result"
    >
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden />
        <div className="min-w-0">
          <h2
            id="import-result-h"
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold outline-none"
          >
            {t("imports.result.title")}
          </h2>
          <p className="truncate text-[13px] text-muted-foreground">{fileName}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("imports.result.created")} value={fmtNumber(result.created)} />
        <Stat label={t("imports.result.duplicates")} value={fmtNumber(result.duplicateCount)} />
        <Stat label={t("imports.result.invalid")} value={fmtNumber(result.invalidCount)} />
      </div>
      {result.created === 0 && <Notice>{t("imports.result.noneCreated")}</Notice>}
      <div className="flex flex-wrap gap-2">
        {result.created > 0 && (
          <Link href="/?source=import" className={buttonVariants()} data-testid="import-explore">
            <Search /> {t("imports.result.explore")}
          </Link>
        )}
        {rows.length > 0 && (
          <Button variant="outline" onClick={() => downloadReport(result)}>
            <Download /> {t("imports.result.download")}
          </Button>
        )}
        <Button variant="ghost" onClick={onAgain}>
          <RotateCcw /> {t("imports.result.again")}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-[13px] font-medium">{t("imports.report.title")}</h3>
          <div
            role="region"
            aria-label={t("imports.report.title")}
            tabIndex={0}
            className="um-scroll max-h-64 overflow-auto rounded-md border"
          >
            <table className="w-full text-left text-[12px]" data-testid="import-report">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    {t("imports.report.row")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    {t("imports.report.kind")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    {t("imports.report.reason")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.row}`} className="border-t">
                    <td className="px-2 py-1 tabular-nums">{r.row}</td>
                    <td className="px-2 py-1">
                      <Badge variant={r.kind === "invalid" ? "danger" : "outline"}>
                        {t(`imports.report.kind.${r.kind}`)}
                      </Badge>
                    </td>
                    <td className="px-2 py-1">{t(reasonKey(r.reason))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.truncated && <FieldHint>{t("imports.result.truncated")}</FieldHint>}
        </div>
      )}
    </section>
  );
}

/* Geçmiş -------------------------------------------------------------------------------------------------- */

function HistorySection() {
  const id = useId();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: importsKey, queryFn: importsApi.list });
  const [undoing, setUndoing] = useState<ImportBatchDto | null>(null);
  const after = () => {
    invalidateLeadViews(qc);
    void qc.invalidateQueries({ queryKey: importsKey });
  };
  const restore = useMutation({
    mutationFn: (bid: number) => importsApi.restore(bid),
    retry: false,
    onSuccess: (r) => {
      after();
      toast.success(t("imports.restore.done", { changed: fmtNumber(r.changed) }), {
        description:
          r.skippedDuplicate > 0
            ? t("imports.restore.skippedDuplicate", { skipped: fmtNumber(r.skippedDuplicate) })
            : undefined,
      });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const archive = useMutation({
    mutationFn: (bid: number) => importsApi.archive(bid),
    retry: false,
    onSuccess: (r) => {
      after();
      setUndoing(null);
      toast.success(t("imports.undo.done", { changed: fmtNumber(r.changed) }), {
        description:
          r.skippedActive > 0
            ? t("imports.undo.skipped", { skipped: fmtNumber(r.skippedActive) })
            : undefined,
        action: {
          label: t("imports.history.restore"),
          onClick: () => restore.mutate(r.batch.id),
        },
      });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const batches = list.data ?? [];
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id={`${id}-h`} className="text-sm font-semibold">
        {t("imports.history.title")}
      </h2>
      {list.isPending ? (
        <Skeleton className="h-16" />
      ) : list.isError ? (
        <Notice tone="danger">{errorText(list.error)}</Notice>
      ) : batches.length === 0 ? (
        <EmptyState compact icon={FileSpreadsheet} body={t("imports.history.empty")} />
      ) : (
        <ul className="divide-y" data-testid="import-history">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {b.filename}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {fmtDate(b.createdAt)}
                  </span>
                </p>
                <p className="truncate text-[12px] text-muted-foreground">{b.sourceNote}</p>
                <p className="text-[12px] tabular-nums text-muted-foreground">
                  {t("imports.history.counts", {
                    created: fmtNumber(b.createdCount),
                    duplicates: fmtNumber(b.duplicateCount),
                    invalid: fmtNumber(b.invalidCount),
                  })}{" "}
                  ·{" "}
                  {t("imports.history.active", {
                    active: fmtNumber(b.activeCount),
                    created: fmtNumber(b.createdCount),
                  })}
                </p>
              </div>
              <div className="flex gap-1.5">
                {b.activeCount > 0 && (
                  <Button
                    size="sm"
                    variant="dangerOutline"
                    onClick={() => setUndoing(b)}
                    aria-label={`${t("imports.history.undo")}: ${b.filename}`}
                  >
                    <Undo2 /> {t("imports.history.undo")}
                  </Button>
                )}
                {b.restorableCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={restore.isPending && restore.variables === b.id}
                    onClick={() => restore.mutate(b.id)}
                    aria-label={`${t("imports.history.restore")}: ${b.filename}`}
                  >
                    <RotateCcw /> {t("imports.history.restore")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {undoing && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setUndoing(null)}
          tone="warning"
          title={t("imports.undo.title")}
          description={t("imports.undo.body", { n: fmtNumber(undoing.activeCount) })}
          confirmLabel={t("imports.undo.confirm")}
          pending={archive.isPending}
          onConfirm={() => archive.mutateAsync(undoing.id).then(() => undefined)}
        />
      )}
    </section>
  );
}
