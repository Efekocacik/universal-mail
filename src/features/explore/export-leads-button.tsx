"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import { fmtNumber } from "@/lib/client/format";
import { downloadSelectionCsv, type SelectionTarget } from "@/lib/client/leads-bulk";
import { t } from "@/lib/i18n";

/**
 * Lead listesini CSV olarak dışa aktarır (`/api/export/leads`, geçerli süzgeçlerle). Google kaynaklı alanlar (ad, adres,
 * web sitesi...) yalnızca kullanıcı onay kutusunu BİLİNÇLİ olarak işaretlerse dahil edilir (SRS 8.1; varsayılan kapalı).
 */
export function exportLeadsUrl(filterQuery: string, includeGoogleFields: boolean): string {
  const sp = new URLSearchParams(filterQuery);
  sp.delete("google");
  if (includeGoogleFields) sp.set("google", "1");
  const q = sp.toString();
  return `/api/export/leads${q ? `?${q}` : ""}`;
}

/**
 * `selection` verilirse (toplu seçim) yalnızca seçilenler POST ile indirilir (2000 kimlik adrese sığmaz); aksi halde
 * listedeki süzgeçle GET.
 */
export function ExportLeadsButton({
  filterQuery,
  selection,
  count,
  label,
}: {
  filterQuery?: string;
  selection?: SelectionTarget;
  /** Seçimle dışa aktarmada başlıkta gösterilen sayı. */
  count?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [google, setGoogle] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setGoogle(false);
          setOpen(true);
        }}
      >
        <Download aria-hidden /> {label ?? t("export.leads")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="success"
        title={
          selection ? t("bulk.export.title", { n: fmtNumber(count ?? 0) }) : t("export.leads.title")
        }
        description={t("export.leads.body")}
        confirmLabel={t("export.leads.confirm")}
        onConfirm={async () => {
          if (!selection) {
            window.location.assign(exportLeadsUrl(filterQuery ?? "", google));
            return;
          }
          try {
            await downloadSelectionCsv(selection, google);
            toast.success(t("bulk.export.started"));
          } catch (e) {
            toast.error((e as Error).message || t("bulk.export.failed"));
            throw e;
          }
        }}
      >
        <label
          htmlFor="export-google-fields"
          className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-[13px]"
        >
          <Checkbox
            id="export-google-fields"
            className="mt-0.5"
            checked={google}
            onCheckedChange={(c) => setGoogle(c === true)}
          />
          <span>
            <span className="font-medium">{t("export.leads.google")}</span>
            <span className="block text-[12px] text-muted-foreground">
              {t("export.leads.google.hint")}
            </span>
          </span>
        </label>
      </ConfirmDialog>
    </>
  );
}
