"use client";

import { Archive, ArchiveRestore, Ban, Mail, MoreHorizontal, Send, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/tooltip";
import { errorText } from "@/lib/client/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtNumber } from "@/lib/client/format";
import {
  bulkResultMessage,
  leadsBulkApi,
  useBulkAction,
  type BulkAction,
  type BulkResult,
} from "@/lib/client/leads-bulk";
import { shortcutHint } from "@/lib/client/shortcuts";
import { t } from "@/lib/i18n";
import { ExportLeadsButton } from "./export-leads-button";
import { hiddenCount, selectionCount, selectionTarget } from "./selection";
import { useExplore } from "./state";

const CONFIRM: Record<
  BulkAction,
  {
    title: "bulk.archive.title" | "bulk.unarchive.title" | "bulk.dnc.title";
    body: "bulk.archive.body" | "bulk.unarchive.body" | "bulk.dnc.body";
    confirm: "bulk.archive.confirm" | "bulk.unarchive.confirm" | "bulk.dnc.confirm";
    tone: "danger" | "success" | "warning";
  }
> = {
  archive: {
    title: "bulk.archive.title",
    body: "bulk.archive.body",
    confirm: "bulk.archive.confirm",
    tone: "danger",
  },
  unarchive: {
    title: "bulk.unarchive.title",
    body: "bulk.unarchive.body",
    confirm: "bulk.unarchive.confirm",
    tone: "success",
  },
  do_not_contact: {
    title: "bulk.dnc.title",
    body: "bulk.dnc.body",
    confirm: "bulk.dnc.confirm",
    tone: "danger",
  },
};

/**
 * Onaylı toplu işlem: pencere açılınca sunucudan `dryRun` ile kaç işletmenin etkileneceği alınır ("N işletme
 * değişecek, M atlanacak"); kullanıcı ancak bu sayıları gördükten sonra onaylar. Arşivlemeden sonra bildirimdeki
 * "Geri al" yalnızca GERÇEKTEN arşivlenen kimlikleri geri çıkarır.
 */
function BulkConfirm({ action, onClose }: { action: BulkAction | null; onClose: () => void }) {
  const ex = useExplore();
  const run = useBulkAction();
  const target = selectionTarget(ex.selection);
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = selectionCount(ex.selection);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!action || !target) return;
    let live = true;
    leadsBulkApi
      .run(action, target, true)
      .then((r) => live && setPreview(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // Seçim değişirse pencere zaten kapanır; hedefin kimliği (dizisi) her çizimde yenidir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  if (!action) return null;
  const c = CONFIRM[action];
  return (
    <ConfirmDialog
      open
      onOpenChange={(v) => !v && onClose()}
      tone={c.tone}
      title={t(c.title, { n: fmtNumber(count) })}
      description={t(c.body)}
      confirmLabel={t(c.confirm)}
      pending={!preview && !error}
      onConfirm={async () => {
        if (!target || !preview || preview.changed === 0) {
          onClose();
          return;
        }
        try {
          const r = await run.mutateAsync({ action, selection: target });
          const msg = bulkResultMessage(r);
          ex.clearSelection();
          toast.success(msg.done, {
            description: msg.skipped ?? undefined,
            action:
              action === "archive" && r.changedIds.length > 0
                ? {
                    label: t("bulk.undo"),
                    onClick: () =>
                      void run
                        .mutateAsync({
                          action: "unarchive",
                          selection: { leadIds: r.changedIds },
                        })
                        .then(() => toast.success(t("bulk.undone")))
                        .catch((e: Error) => toast.error(errorText(e))),
                  }
                : undefined,
          });
        } catch (e) {
          toast.error(errorText(e));
          throw e;
        }
      }}
    >
      <div aria-live="polite">
        {error ? (
          <p className="text-[13px] text-destructive">{error}</p>
        ) : !preview ? (
          <div className="space-y-2" role="status">
            <Skeleton className="h-16 w-full" />
            <p className="text-[12px] text-muted-foreground">{t("bulk.preview.loading")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {preview.capped && (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
                {t("bulk.preview.capped", {
                  total: fmtNumber(preview.matchedTotal),
                  max: fmtNumber(preview.matched),
                })}
              </p>
            )}
            <dl className="divide-y rounded-lg border bg-muted/50 px-3 py-1 text-[13px]">
              <Row label={t("bulk.preview.changed")} strong>
                {fmtNumber(preview.changed)}
              </Row>
              {preview.skipped.unchanged > 0 && (
                <Row label={t("bulk.preview.unchanged")}>
                  {fmtNumber(preview.skipped.unchanged)}
                </Row>
              )}
              {preview.skipped.activeCampaign > 0 && (
                <Row label={t("bulk.preview.activeCampaign")}>
                  {fmtNumber(preview.skipped.activeCampaign)}
                </Row>
              )}
              {preview.skipped.notFound > 0 && (
                <Row label={t("bulk.preview.notFound")}>{fmtNumber(preview.skipped.notFound)}</Row>
              )}
            </dl>
            {preview.changed === 0 && (
              <p className="text-[12px] text-muted-foreground">{t("bulk.preview.nothing")}</p>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function Row({
  label,
  children,
  strong,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "tabular font-semibold" : "tabular"}>{children}</dd>
    </div>
  );
}

/**
 * Seçim çubuğu: bir veya daha çok işletme seçiliyken listenin üst satırının yerini alır. E-posta bul ve Kampanyaya ekle
 * sayfa düzeyindeki pencereleri açar (klavye kısayolları E ve C ile aynı pencereler).
 */
export function BulkBar({ visibleIds }: { visibleIds: ReadonlySet<number> }) {
  const ex = useExplore();
  const [action, setAction] = useState<BulkAction | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const n = selectionCount(ex.selection);
  const hidden = useMemo(() => hiddenCount(ex.selection, visibleIds), [ex.selection, visibleIds]);
  const target = selectionTarget(ex.selection);
  const archivedView = ex.filters.archived;

  const label =
    ex.selection.mode === "query"
      ? ex.selection.source === "view"
        ? t("selection.view", { n: fmtNumber(n) })
        : t("selection.allMatching", { n: fmtNumber(n) })
      : t("selection.count", { n: fmtNumber(n) });

  return (
    <div
      role="toolbar"
      aria-label={t("bulk.toolbar")}
      className="space-y-2 border-b bg-accent/60 py-2 pl-3 pr-4"
      data-testid="bulk-bar"
    >
      <div className="flex min-h-8 items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px]" aria-live="polite">
          <span className="tabular font-semibold">{label}</span>
          {hidden > 0 && (
            <span className="block text-[12px] text-muted-foreground">
              {t("selection.hidden", { n: fmtNumber(hidden) })}
            </span>
          )}
        </p>
        {/* Canlı bölgenin DIŞINDA: balonun kendi duyurusu seçim sayısıyla karışmaz. */}
        <HelpTip>{t("help.bulk")}</HelpTip>
        <Button
          size="sm"
          variant="ghost"
          onClick={ex.clearSelection}
          aria-label={`${t("selection.clear")} (Esc)`}
          title={`${t("selection.clear")} (Esc)`}
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => ex.openDialog("findEmails")}
          title={`${t("findEmails.button")} (${shortcutHint("findEmails")})`}
        >
          <Mail /> {t("findEmails.button")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => ex.openDialog("campaign")}
          title={`${t("addToCampaign.button")} (${shortcutHint("addToCampaign")})`}
        >
          <Send /> {t("addToCampaign.button")}
        </Button>
        {target && <ExportLeadsButton selection={target} count={n} />}
        {archivedView ? (
          <Button size="sm" variant="outline" onClick={() => setAction("unarchive")}>
            <ArchiveRestore /> {t("bulk.unarchive")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAction("archive")}
            className="text-destructive hover:text-destructive"
          >
            <Archive /> {t("bulk.archive")}
          </Button>
        )}
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={t("bulk.more")} title={t("bulk.more")}>
              <MoreHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1.5">
            <button
              type="button"
              className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
              onClick={() => {
                setMoreOpen(false);
                setAction("do_not_contact");
              }}
            >
              <Ban className="size-4" aria-hidden /> {t("bulk.dnc")}
            </button>
          </PopoverContent>
        </Popover>
      </div>
      <BulkConfirm action={action} onClose={() => setAction(null)} />
    </div>
  );
}
