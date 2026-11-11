"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

export function ExportLeadsButton({ filterQuery }: { filterQuery: string }) {
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
        <Download aria-hidden /> {t("export.leads")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="success"
        title={t("export.leads.title")}
        description={t("export.leads.body")}
        confirmLabel={t("export.leads.confirm")}
        onConfirm={() => {
          window.location.assign(exportLeadsUrl(filterQuery, google));
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
