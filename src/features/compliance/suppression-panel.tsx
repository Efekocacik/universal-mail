"use client";

import { Ban, Lock, Plus, Search, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldHint, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import {
  complianceApi,
  useSuppressions,
  xk,
  type CsvImportReport,
  type SuppressionFilter,
  type SuppressionListItem,
  type SuppressionReason,
  type SuppressionScope,
  type SuppressionState,
} from "@/lib/client/compliance";
import { fmtDate, fmtNumber } from "@/lib/client/format";
import {
  confirmationPreview,
  suppressionImportApi,
  type CsvImportPreview,
} from "@/lib/client/suppression-import";
import { t } from "@/lib/i18n";
import { importNeedsConfirmation, importWritesAnything, previewReasons } from "./import-model";
import {
  csvErrorName,
  csvFileProblem,
  displayText,
  IRREVERSIBLE_REASONS,
  liftJustificationOk,
  LIFT_MIN_CHARS,
  MANUAL_REASONS,
  reasonName,
  sourceName,
  type ManualReason,
} from "./model";

const INVALIDATE = [xk.all] as const;
const ALL_REASONS: SuppressionReason[] = [
  "unsubscribe",
  "bounce_hard",
  "complaint",
  "manual",
  "negative_reply",
  "erasure",
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/* Elle ekleme ---------------------------------------------------------------------------------------- */

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [kind, setKind] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<ManualReason>("manual");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useSafeMutation(
    () =>
      complianceApi.addSuppression({
        kind,
        value: value.trim(),
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    {
      invalidate: INVALIDATE,
      onSuccess: (r) => {
        setValue("");
        setNote("");
        setError(null);
        onOpenChange(false);
        // `existing`: zaten aynı veya daha güçlü bir kayıt var.
        void r;
      },
      onError: (info) => setError(info.kind === "validation" ? t("sup.add.invalid") : info.message),
    },
  );
  const irreversible = IRREVERSIBLE_REASONS.has(reason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("sup.add.title")}</DialogTitle>
          <DialogDescription>{t("sup.add.body")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) add.mutate(undefined);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sup-kind">{t("sup.add.kind")}</Label>
              <Select
                id="sup-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "email" | "domain")}
              >
                <option value="email">{t("sup.add.kind.email")}</option>
                <option value="domain">{t("sup.add.kind.domain")}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-reason">{t("sup.add.reason")}</Label>
              <Select
                id="sup-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as ManualReason)}
              >
                {MANUAL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {reasonName(r)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-value">
              {kind === "email" ? t("sup.add.value.email") : t("sup.add.value.domain")}
            </Label>
            <Input
              id="sup-value"
              value={value}
              autoComplete="off"
              placeholder={kind === "email" ? "ad@firma.com" : "firma.com"}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
            <FieldHint>
              {kind === "email" ? t("sup.add.value.email.hint") : t("sup.add.value.domain.hint")}
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-note">{t("sup.add.note")}</Label>
            <Textarea
              id="sup-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {irreversible && <Notice tone="warning">{t("sup.add.irreversible")}</Notice>}
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={add.isPending} disabled={!value.trim()}>
              {t("common.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* CSV içe aktarma ------------------------------------------------------------------------------------ */

function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvImportPreview | null>(null);
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Önizleme hiçbir şey yazmaz (sunucuda aynı hesap yapılır ve geri alınır).
  const previewer = useSafeMutation((text: string) => suppressionImportApi.preview(text), {
    onSuccess: (p, text) => {
      // Bu arada başka dosya seçildiyse eski önizleme gösterilmez.
      if (file?.text === text) setPreview(p);
    },
    onError: (info) => setProblem(info.message),
  });
  const importer = useSafeMutation(
    (v: { text: string; confirmIrreversible: boolean }) =>
      suppressionImportApi.run(v.text, v.confirmIrreversible),
    {
      invalidate: INVALIDATE,
      onSuccess: (r) => {
        setConfirmOpen(false);
        setReport(r);
      },
    },
  );
  const runImport = async (confirmIrreversible: boolean) => {
    if (!file) return;
    try {
      await importer.mutateAsync({ text: file.text, confirmIrreversible });
    } catch (e) {
      // Önizlemeden sonra veri değiştiyse sunucu güncel önizlemeyi döner: kırmızı onay penceresi açılır.
      const fresh = confirmationPreview(e);
      if (fresh) {
        setPreview(fresh);
        setConfirmOpen(true);
      }
      if (confirmIrreversible) throw e; // onay penceresi açık kalır
    }
  };

  const reset = () => {
    setFile(null);
    setProblem(null);
    setPreview(null);
    setReport(null);
    setConfirmOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("sup.import.title")}</DialogTitle>
          <DialogDescription>{t("sup.import.body")}</DialogDescription>
        </DialogHeader>
        {report ? (
          <div className="space-y-3 text-[13px]" aria-live="polite">
            <p className="font-medium">
              {t("sup.import.result", {
                added: fmtNumber(report.added),
                strengthened: fmtNumber(report.strengthened),
                duplicates: fmtNumber(report.duplicates),
                invalid: fmtNumber(report.invalid.length),
              })}
            </p>
            {report.invalid.length > 0 && (
              <div>
                <p className="text-muted-foreground">{t("sup.import.invalid")}</p>
                <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-4">
                  {report.invalid.slice(0, 50).map((r) => (
                    <li key={`${r.line}-${r.error}`}>
                      {t("sup.import.line", { line: r.line })}: {csvErrorName(r.error)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sup-file">{t("sup.import.file")}</Label>
              <Input
                id="sup-file"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="h-auto py-1.5"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  setProblem(null);
                  setFile(null);
                  setPreview(null);
                  if (!f) return;
                  const p = csvFileProblem(f);
                  if (p) {
                    setProblem(t(p === "too_large" ? "sup.import.tooLarge" : "sup.import.empty"));
                    return;
                  }
                  const text = await f.text();
                  setFile({ name: f.name, size: f.size, text });
                  previewer.mutate(text);
                }}
              />
              <FieldHint>{t("sup.import.format")}</FieldHint>
            </div>
            {file && (
              <p className="text-[13px]">
                {t("sup.import.chosen", {
                  name: file.name,
                  kb: Math.max(1, Math.round(file.size / 1024)),
                })}
              </p>
            )}
            {file && previewer.isPending && (
              <p className="text-[13px] text-muted-foreground" aria-live="polite">
                {t("sup.import.preview.loading")}
              </p>
            )}
            {file && preview && !previewer.isPending && (
              <div className="space-y-2 text-[13px]" aria-live="polite">
                <p className="font-medium">
                  {t("sup.import.preview", {
                    added: fmtNumber(preview.added),
                    strengthened: fmtNumber(preview.strengthened),
                    duplicates: fmtNumber(preview.duplicates),
                    invalid: fmtNumber(preview.invalid.length),
                  })}
                </p>
                {previewReasons(preview).length > 0 && (
                  <ul
                    className="flex flex-wrap gap-1.5"
                    aria-label={t("sup.import.preview.reasons")}
                  >
                    {previewReasons(preview).map((r) => (
                      <li key={r.reason}>
                        <Badge variant={IRREVERSIBLE_REASONS.has(r.reason) ? "warning" : "outline"}>
                          {reasonName(r.reason)}: {fmtNumber(r.n)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {importNeedsConfirmation(preview) && (
                  <Notice tone="warning">
                    {t("sup.import.preview.irreversible", {
                      n: fmtNumber(preview.irreversible),
                      domains: fmtNumber(preview.irreversibleDomains),
                    })}
                  </Notice>
                )}
                {!importWritesAnything(preview) && (
                  <p className="text-muted-foreground">{t("sup.import.preview.nothing")}</p>
                )}
                {preview.invalid.length > 0 && (
                  <div>
                    <p className="text-muted-foreground">{t("sup.import.invalid")}</p>
                    <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-4">
                      {preview.invalid.slice(0, 50).map((r) => (
                        <li key={`${r.line}-${r.error}`}>
                          {t("sup.import.line", { line: r.line })}: {csvErrorName(r.error)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {problem && <FieldError>{problem}</FieldError>}
          </div>
        )}
        <DialogFooter>
          {report ? (
            <Button
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => {
                  if (!preview) return;
                  if (importNeedsConfirmation(preview)) setConfirmOpen(true);
                  else void runImport(false);
                }}
                disabled={!file || !preview || previewer.isPending}
                loading={importer.isPending && !confirmOpen}
              >
                <Upload /> {t("sup.import.run")}
              </Button>
            </>
          )}
        </DialogFooter>
        {preview && (
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            tone="danger"
            title={t("sup.import.confirm.title")}
            description={t("sup.import.confirm.body", {
              n: fmtNumber(preview.irreversible),
              domains: fmtNumber(preview.irreversibleDomains),
            })}
            confirmLabel={t("sup.import.confirm.run")}
            onConfirm={() => runImport(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* Satır ve kaldırma ---------------------------------------------------------------------------------- */

function SuppressionRow({ item }: { item: SuppressionListItem }) {
  const [open, setOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const [showError, setShowError] = useState(false);
  const lift = useSafeMutation(() => complianceApi.lift(item.id, justification.trim()), {
    invalidate: INVALIDATE,
    successMessage: t("sup.lifted"),
  });
  const text = displayText(item.display);
  return (
    <li className="grid gap-2 p-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{text}</span>
          {item.display.kind === "domain" && (
            <Badge variant="outline">{t("sup.row.wholeDomain")}</Badge>
          )}
          <Badge variant={IRREVERSIBLE_REASONS.has(item.reason) ? "warning" : "default"}>
            {reasonName(item.reason)}
          </Badge>
          {!item.active && <Badge variant="low">{t("sup.row.lifted")}</Badge>}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {t("sup.row.meta", { source: sourceName(item.source), at: fmtDate(item.addedAt) })}
          {item.liftedAt ? ` · ${t("sup.row.liftedAt", { at: fmtDate(item.liftedAt) })}` : ""}
        </p>
      </div>
      {item.active &&
        (item.liftable ? (
          <Button
            size="sm"
            variant="dangerOutline"
            onClick={() => {
              setJustification("");
              setShowError(false);
              setOpen(true);
            }}
            aria-label={t("sup.lift.aria", { who: text })}
          >
            {t("sup.lift")}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
            <Lock className="size-3.5" aria-hidden /> {t("sup.row.protected")}
          </span>
        ))}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        title={t("sup.lift.title")}
        description={t("sup.lift.body")}
        confirmLabel={t("sup.lift")}
        onConfirm={async () => {
          if (!liftJustificationOk(justification)) {
            setShowError(true);
            throw new Error("justification");
          }
          await lift.mutateAsync(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`lift-${item.id}`}>{t("sup.lift.justification")}</Label>
          <Textarea
            id={`lift-${item.id}`}
            rows={3}
            maxLength={500}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            aria-invalid={showError ? true : undefined}
          />
          {showError ? (
            <FieldError>{t("sup.lift.justification.error", { n: LIFT_MIN_CHARS })}</FieldError>
          ) : (
            <FieldHint>{t("sup.lift.justification.hint", { n: LIFT_MIN_CHARS })}</FieldHint>
          )}
        </div>
      </ConfirmDialog>
    </li>
  );
}

/* Panel ---------------------------------------------------------------------------------------------- */

/**
 * Suppression listesi (FR-CMPL-02). Tam adres saklanmadığı için yalnızca maskeli görünüm veya alan adı gösterilir;
 * silme talebi kayıtlarında hiçbir tanımlayıcı yoktur. Çıkış, şikâyet ve silme talebi kayıtları kaldırılamaz.
 */
export function SuppressionPanel() {
  const [state, setState] = useState<SuppressionState>("active");
  const [reason, setReason] = useState<SuppressionReason | "">("");
  const [scope, setScope] = useState<SuppressionScope | "">("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 400);
  const filter: SuppressionFilter = {
    state,
    ...(reason ? { reason } : {}),
    ...(scope ? { scope } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  };
  const list = useSuppressions(filter);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const first = pages[0];

  return (
    <div className="space-y-4">
      <Notice>{t("sup.note")}</Notice>
      {first && (
        <ul className="flex flex-wrap gap-2" aria-label={t("sup.summary")}>
          <li>
            <Badge variant="primary">
              {t("sup.summary.active", { n: fmtNumber(first.summary.active) })}
            </Badge>
          </li>
          {ALL_REASONS.filter((r) => (first.summary.byReason[r] ?? 0) > 0).map((r) => (
            <li key={r}>
              <Badge variant="outline">
                {reasonName(r)}: {fmtNumber(first.summary.byReason[r] ?? 0)}
              </Badge>
            </li>
          ))}
          {first.summary.lifted > 0 && (
            <li>
              <Badge variant="low">
                {t("sup.summary.lifted", { n: fmtNumber(first.summary.lifted) })}
              </Badge>
            </li>
          )}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            aria-label={t("sup.search")}
            placeholder={t("sup.search")}
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          aria-label={t("sup.filter.state")}
          value={state}
          onChange={(e) => setState(e.target.value as SuppressionState)}
          className="h-9 w-auto pr-7 text-[13px]"
        >
          <option value="active">{t("sup.filter.state.active")}</option>
          <option value="lifted">{t("sup.filter.state.lifted")}</option>
          <option value="all">{t("sup.filter.state.all")}</option>
        </Select>
        <Select
          aria-label={t("sup.filter.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value as SuppressionReason | "")}
          className="h-9 w-auto pr-7 text-[13px]"
        >
          <option value="">{t("sup.filter.reason.all")}</option>
          {ALL_REASONS.map((r) => (
            <option key={r} value={r}>
              {reasonName(r)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t("sup.filter.scope")}
          value={scope}
          onChange={(e) => setScope(e.target.value as SuppressionScope | "")}
          className="h-9 w-auto pr-7 text-[13px]"
        >
          <option value="">{t("sup.filter.scope.all")}</option>
          <option value="email">{t("sup.filter.scope.email")}</option>
          <option value="domain">{t("sup.filter.scope.domain")}</option>
        </Select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> {t("sup.import")}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus /> {t("sup.add")}
          </Button>
        </div>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          className="rounded-xl border border-dashed bg-card p-8"
          icon={Ban}
          title={t("sup.empty.title")}
          body={t("sup.empty.body")}
        />
      ) : (
        <>
          <p className="tabular text-[12px] text-muted-foreground" aria-live="polite">
            {t("sup.count", {
              shown: fmtNumber(items.length),
              total: fmtNumber(first?.total ?? 0),
            })}
          </p>
          <ul className="divide-y rounded-xl border bg-card shadow-xs" aria-label={t("sup.list")}>
            {items.map((it) => (
              <SuppressionRow key={it.id} item={it} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                loading={list.isFetchingNextPage}
              >
                {t("sup.more")}
              </Button>
            </div>
          )}
        </>
      )}
      <AddDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
