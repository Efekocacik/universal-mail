"use client";

import { Eraser } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { HelpTip } from "@/components/ui/tooltip";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import {
  ek,
  erasureApi,
  useErasureState,
  type ErasurePreview,
  type ErasureResult,
} from "@/lib/client/erasure";
import { fmtDate, fmtDateTime } from "@/lib/client/format";
import { t } from "@/lib/i18n";

const todayInput = () => new Date().toISOString().slice(0, 10);
/** `YYYY-MM-DD` → gün başı (yerel saat, ms); geçersizse null. */
function dayToMs(day: string): number | null {
  const ms = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Kişisel veri silme talebi (FR-CMPL-03). Önce yalnızca SAYILARI gösteren önizleme; sonra geri alınamaz uygulama.
 * Gerçek gönderim kayıtları ve engel özeti için hukuki değerlendirme bekleyen durumlar açıkça gösterilir.
 */
export function ErasurePanel() {
  const state = useErasureState();
  const [email, setEmail] = useState("");
  const [day, setDay] = useState(todayInput());
  const [why, setWhy] = useState("");
  const [clearNotes, setClearNotes] = useState(false);
  const [preview, setPreview] = useState<ErasurePreview | null>(null);
  const [result, setResult] = useState<ErasureResult | null>(null);
  const [confirm, setConfirm] = useState(false);

  const previewMut = useSafeMutation(() => erasureApi.preview(email.trim()), {
    onSuccess: (p) => {
      setResult(null);
      setPreview(p);
    },
  });
  const run = useSafeMutation(
    () =>
      erasureApi.execute({
        email: email.trim(),
        requestedAt: dayToMs(day) ?? Date.now(),
        justification: why.trim(),
        confirm: true,
        clearNotes,
      }),
    {
      invalidate: [ek.all],
      successMessage: t("erasure.done"),
      onSuccess: (r) => {
        setResult(r);
        setPreview(null);
        setEmail("");
        setWhy("");
      },
    },
  );

  const formOk = email.trim().length >= 3 && why.trim().length >= 10 && dayToMs(day) !== null;

  return (
    <div className="space-y-4">
      <section aria-labelledby="er-title" className="space-y-3 rounded-xl border bg-card p-4">
        <h2 id="er-title" className="flex items-center gap-1.5 text-sm font-semibold">
          {t("erasure.title")}
          <HelpTip>{t("help.erasure")}</HelpTip>
        </h2>
        <p className="text-[13px] text-muted-foreground">{t("erasure.help")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="er-email">{t("erasure.email")}</Label>
            <Input
              id="er-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="er-day">{t("erasure.requestedAt")}</Label>
            <Input
              id="er-day"
              type="date"
              max={todayInput()}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="er-why">{t("erasure.justification")}</Label>
            <Textarea id="er-why" value={why} onChange={(e) => setWhy(e.target.value)} />
            <FieldHint>{t("erasure.justification.hint")}</FieldHint>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={clearNotes}
            onChange={(e) => setClearNotes(e.target.checked)}
          />
          {t("erasure.clearNotes")}
        </label>
        <Button
          variant="outline"
          loading={previewMut.isPending}
          disabled={!formOk}
          onClick={() => previewMut.mutate(undefined)}
        >
          {t("erasure.preview")}
        </Button>

        {preview && (
          <div className="space-y-3" data-testid="erasure-preview">
            {preview.suppressionExists && <Notice>{t("erasure.exists")}</Notice>}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3 text-[13px]">
                <p className="mb-1 font-medium">{t("erasure.preview.safe")}</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>{t("erasure.count.leadEmails", { n: preview.safe.leadEmails })}</li>
                  <li>{t("erasure.count.sequences", { n: preview.safe.sequences })}</li>
                  <li>{t("erasure.count.messages", { n: preview.safe.messages })}</li>
                  <li>{t("erasure.count.notes", { n: preview.safe.notesMentions })}</li>
                </ul>
              </div>
              <div className="rounded-lg border p-3 text-[13px]">
                <p className="mb-1 flex items-center gap-2 font-medium">
                  {t("erasure.preview.pending")}
                  <Badge variant="warning">
                    {preview.pending.messages + preview.pending.sequences}
                  </Badge>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>{t("erasure.count.sequences", { n: preview.pending.sequences })}</li>
                  <li>{t("erasure.count.messages", { n: preview.pending.messages })}</li>
                </ul>
              </div>
            </div>
            {(preview.pending.messages > 0 || preview.pending.sequences > 0) && (
              <Notice tone="warning">
                {t("erasure.pending.body", {
                  messages: preview.pending.messages,
                  sequences: preview.pending.sequences,
                })}
              </Notice>
            )}
            <Notice tone="warning">{t("erasure.legal.suppression")}</Notice>
            <Notice>{t("erasure.backup")}</Notice>
            <Button
              variant="dangerOutline"
              disabled={preview.inFlight > 0}
              onClick={() => setConfirm(true)}
            >
              <Eraser /> {t("erasure.apply")}
            </Button>
          </div>
        )}
        {result && (
          <div className="space-y-2" data-testid="erasure-result">
            <Notice>
              {t("erasure.cleared", {
                leadEmails: result.cleared.leadEmails,
                sequences: result.cleared.sequences,
                messages: result.cleared.messages,
              })}
            </Notice>
            {(result.pending.messages > 0 || result.pending.sequences > 0) && (
              <Notice tone="warning">
                {t("erasure.cleared.pending", {
                  messages: result.pending.messages,
                  sequences: result.pending.sequences,
                })}
              </Notice>
            )}
            {result.overdue && <Notice tone="danger">{t("erasure.overdue")}</Notice>}
            <Notice tone="warning">{t("erasure.legal.suppression")}</Notice>
          </div>
        )}
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          tone="danger"
          title={t("erasure.confirm.title")}
          description={t("erasure.confirm.body")}
          confirmLabel={t("erasure.apply")}
          onConfirm={async () => {
            try {
              await run.mutateAsync(undefined);
            } catch {
              /* useSafeMutation kullanıcıya bildirir */
            }
          }}
        />
      </section>

      <section aria-labelledby="er-hist" className="space-y-3 rounded-xl border bg-card p-4">
        <h2 id="er-hist" className="text-sm font-semibold">
          {t("erasure.history")}
        </h2>
        {state.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : state.isError || !state.data ? (
          <LoadError error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <>
            {(state.data.pending.messages > 0 || state.data.pending.sequences > 0) && (
              <Notice tone="warning">
                {t("erasure.pendingTotal", {
                  messages: state.data.pending.messages,
                  sequences: state.data.pending.sequences,
                })}
              </Notice>
            )}
            {state.data.history.length === 0 ? (
              <EmptyState
                title={t("erasure.history.empty")}
                body={t("erasure.history.empty.body")}
                className="rounded-lg border border-dashed"
              />
            ) : (
              <ul className="divide-y rounded-lg border" aria-label={t("erasure.history")}>
                {state.data.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
                    <span className="flex-1">
                      {t("erasure.history.row", {
                        requested: fmtDate(h.requestedAt),
                        executed: fmtDateTime(h.executedAt),
                      })}
                    </span>
                    {h.overdue && <Badge variant="danger">{t("erasure.overdue")}</Badge>}
                    {h.pending > 0 && <Badge variant="warning">{h.pending}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
