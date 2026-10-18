"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/client/api";
import { fmtUsd } from "@/lib/client/format";
import { t } from "@/lib/i18n";

interface Preview {
  places: number;
  estimatedCostUsd: number;
  remainingBudgetUsd: number;
}

/**
 * Google verisini yükleyen düğme + maliyet onay penceresi.
 *  - mode "refresh": ad, adres, konum, durum yeniden yüklenir (Place Details Pro). Google verisi uygulama kapanınca
 *    silindiği için liste bu işlemle yeniden dolar.
 *  - mode "enrich": ayrıca web sitesi, telefon, değerlendirme sayısı (Place Details Enterprise).
 * `target` ya seçili lead'leri ya da bir süzgeç sorgusunu (Google verisi yüklü olmayan kayıtlar için) belirtir.
 */
export function GoogleLoadButton({
  target,
  mode,
  label,
  variant = "outline",
  size = "sm",
}: {
  target: { leadIds: number[] } | { filtersQuery: string };
  mode: "refresh" | "enrich";
  label: string;
  variant?: "outline" | "default";
  size?: "sm" | "md";
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pollUntil, setPollUntil] = useState(0);

  const preview = useMutation({
    mutationFn: () =>
      api<{ preview: Preview }>("/api/leads/enrich", {
        method: "POST",
        json: { ...target, mode, dryRun: true },
      }),
    onSuccess: (r) => {
      if (r.preview.places === 0) toast.message(t("load.nothing"));
      else setOpen(true);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const run = useMutation({
    mutationFn: () => api("/api/leads/enrich", { method: "POST", json: { ...target, mode } }),
    onSuccess: () => {
      setOpen(false);
      setPollUntil(Date.now() + 45_000);
      toast.success(t("load.queued"));
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t("common.error")),
  });

  // Kuyruk işi bitene kadar ilgili görünümleri kısa aralıklarla yenile.
  useEffect(() => {
    if (pollUntil <= Date.now()) return;
    const id = setInterval(() => {
      for (const key of ["lead", "leads", "points", "facets"])
        void qc.invalidateQueries({ queryKey: [key] });
      if (Date.now() > pollUntil) clearInterval(id);
    }, 1500);
    return () => clearInterval(id);
  }, [pollUntil, qc]);

  const data = preview.data?.preview;
  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => preview.mutate()}
        disabled={preview.isPending || run.isPending}
      >
        {preview.isPending ? (
          <Loader2 className="animate-spin" />
        ) : mode === "enrich" ? (
          <Sparkles />
        ) : (
          <Download />
        )}{" "}
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(`load.${mode}.title`)}</DialogTitle>
            <DialogDescription>{t(`load.${mode}.body`)}</DialogDescription>
          </DialogHeader>
          {data && (
            <dl className="rounded-lg bg-muted p-3 text-[13px]">
              <Row label={t("load.places")}>{data.places}</Row>
              <Row label={t("load.cost")}>
                <span className="tabular font-medium">{fmtUsd(data.estimatedCostUsd)}</span>
                {data.estimatedCostUsd === 0 && (
                  <span className="ml-1 text-muted-foreground">({t("load.free")})</span>
                )}
              </Row>
              <Row label={t("load.remaining")}>
                <span className="tabular">{fmtUsd(data.remainingBudgetUsd)}</span>
              </Row>
            </dl>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending && <Loader2 className="animate-spin" />} {t("load.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
