"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/client/api";
import { fmtNumber, fmtUsd } from "@/lib/client/format";
import { qk } from "@/lib/client/queries";
import type { FindEmailsPreview } from "@/lib/client/types";
import { t } from "@/lib/i18n";

type Target = { leadIds: number[] } | { filtersQuery: string };

/**
 * "E-posta bul": seçili lead'ler (veya listedeki süzgeçlere uyanlar) için web sitelerinden e-posta aramayı başlatır.
 * Önce ne olacağını ve (varsa) Google maliyetini gösterir; kullanıcı onaylamadan bir şey kuyruğa alınmaz.
 */
export function FindEmailsButton({
  target,
  label,
  variant = "outline",
  size = "sm",
  initialForce = false,
}: {
  target: Target;
  label?: string;
  variant?: "outline" | "default";
  size?: "sm" | "md";
  initialForce?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [loadGoogle, setLoadGoogle] = useState(false);
  const [useExternal, setUseExternal] = useState(false);
  const [force, setForce] = useState(initialForce);

  const preview = useMutation({
    mutationFn: () =>
      api<{ preview: FindEmailsPreview }>("/api/leads/find-emails", {
        method: "POST",
        json: { ...target, loadGoogle, useExternal, force, dryRun: true },
      }),
    onError: (e: Error) => {
      toast.error(e.message);
      setOpen(false);
    },
  });
  const { mutate: runPreview } = preview;
  useEffect(() => {
    if (open) runPreview();
  }, [open, loadGoogle, useExternal, force, runPreview]);

  const start = useMutation({
    mutationFn: () =>
      api("/api/leads/find-emails", {
        method: "POST",
        json: { ...target, loadGoogle, useExternal, force },
      }),
    onSuccess: () => {
      setOpen(false);
      toast.success(t("findEmails.queued"));
      void qc.invalidateQueries({ queryKey: qk.enrichment });
      for (const key of ["lead", "leads", "facets"]) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t("common.error")),
  });

  const p = preview.data?.preview;
  const onOpenChange = useCallback((v: boolean) => setOpen(v), []);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <Mail /> {label ?? t("findEmails.button")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("findEmails.title")}</DialogTitle>
            <DialogDescription>{t("findEmails.body")}</DialogDescription>
          </DialogHeader>
          {!p ? (
            <div className="space-y-3" role="status" aria-live="polite">
              <Skeleton className="h-[148px] w-full" />
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("common.loading")}
              </p>
            </div>
          ) : (
            <div className="um-enter space-y-3">
              <dl className="divide-y rounded-lg border bg-muted/50 px-3 py-1 text-[13px]">
                <Row label={t("findEmails.leads")}>{fmtNumber(p.leads)}</Row>
                <Row label={t("findEmails.ready")}>{fmtNumber(p.ready)}</Row>
                {p.needsGoogle > 0 && (
                  <Row label={t("findEmails.needsGoogle")}>{fmtNumber(p.needsGoogle)}</Row>
                )}
                {p.noWebsite > 0 && (
                  <Row label={t("findEmails.noWebsite")}>{fmtNumber(p.noWebsite)}</Row>
                )}
                {p.alreadyDone > 0 && (
                  <Row label={t("findEmails.alreadyDone")}>{fmtNumber(p.alreadyDone)}</Row>
                )}
                {p.optedOut > 0 && (
                  <Row label={t("findEmails.optedOut")}>{fmtNumber(p.optedOut)}</Row>
                )}
                <Row label={t("findEmails.willSearch")}>
                  <span className="tabular font-semibold">{fmtNumber(p.willSearch)}</span>
                </Row>
              </dl>
              {p.needsGoogle > 0 && (
                <Option
                  checked={loadGoogle}
                  onChange={setLoadGoogle}
                  id="fe-google"
                  help={t("findEmails.loadGoogle.help")}
                >
                  {t("findEmails.loadGoogle", {
                    cost: fmtUsd(p.google.estimatedCostUsd),
                  })}
                </Option>
              )}
              {p.external.available && (
                <Option
                  checked={useExternal}
                  onChange={setUseExternal}
                  id="fe-external"
                  help={t("findEmails.useExternal.help")}
                >
                  {t("findEmails.useExternal")}
                </Option>
              )}
              {(p.alreadyDone > 0 || force) && (
                <Option
                  checked={force}
                  onChange={setForce}
                  id="fe-force"
                  help={t("findEmails.force.help")}
                >
                  {t("findEmails.force")}
                </Option>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={start.isPending}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="success"
              onClick={() => start.mutate()}
              loading={start.isPending}
              disabled={!p || p.willSearch === 0}
            >
              {t("findEmails.start")}
            </Button>
          </DialogFooter>
          {p && p.willSearch === 0 && (
            <p className="text-[12px] text-muted-foreground">{t("findEmails.nothing")}</p>
          )}
          {p && loadGoogle && p.needsGoogle > 0 && (
            <p className="tabular text-[12px] font-medium">
              {t("findEmails.cost", { cost: fmtUsd(p.google.estimatedCostUsd) })}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr] gap-2 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Option({
  id,
  checked,
  onChange,
  children,
  help,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <div className="flex items-start gap-2 text-[13px]">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div>
        <label htmlFor={id} className="cursor-pointer leading-snug">
          {children}
        </label>
        {help && <p className="mt-0.5 text-[12px] text-muted-foreground">{help}</p>}
      </div>
    </div>
  );
}
