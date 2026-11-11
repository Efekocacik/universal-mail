"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * Tek tip onay penceresi (docs/07-UI-REHBERI.md).
 *  - tone "danger": geri alınamaz eylemler. Onay düğmesi KIRMIZI, varsayılan odak "Vazgeç"te (yanlışlıkla Enter ile silinmez).
 *  - tone "warning": maliyet/bütçe gibi uyarılı ama zararsız başlatmalar. Sarı simge, YEŞİL onay düğmesi, odak "Vazgeç"te.
 *  - tone "success": önemli ama zararsız onaylar (örn. kampanyayı başlat). Onay düğmesi YEŞİL ve varsayılan odakta.
 * Başarısız olursa pencere açık kalır (onConfirm hata fırlatırsa); sonuç bildirimini çağıran yapar.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  onConfirm,
  pending = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "success" | "warning";
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
  children?: React.ReactNode;
}) {
  const danger = tone === "danger";
  const warning = tone === "warning";
  const Icon = danger || warning ? AlertTriangle : CheckCircle2;
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      /* pencere açık kalır; hata iletisini çağıran gösterir */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          if (!danger && !warning) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-cancel]")?.focus();
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ${danger ? "bg-destructive/10 text-destructive" : warning ? "bg-nov-likely/20 text-[#8a6700]" : "bg-success/10 text-success"}`}
              aria-hidden
            >
              <Icon className="size-5" />
            </span>
            <div className="space-y-1.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            variant="outline"
            data-cancel
            onClick={() => onOpenChange(false)}
            disabled={busy || pending}
          >
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={danger ? "destructive" : "success"}
            loading={busy || pending}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
