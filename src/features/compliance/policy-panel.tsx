"use client";

import { Lock, Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { HelpTip } from "@/components/ui/tooltip";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import {
  complianceApi,
  usePolicies,
  xk,
  type CountryPolicyView,
  type PolicyMode,
} from "@/lib/client/compliance";
import { countryLabel } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { filterPolicies, MODE_VARIANT, modeLabel, stricterModes } from "./model";

const INVALIDATE = [xk.all] as const;

function PolicyRow({ row }: { row: CountryPolicyView }) {
  const options = stricterModes(row.mode);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<PolicyMode>(options[0] ?? "blocked");
  const tighten = useSafeMutation(() => complianceApi.tighten(row.countryCode, target), {
    invalidate: INVALIDATE,
    successMessage: t("policy.tightened", { country: countryLabel(row.countryCode) }),
    conflictMessage: t("policy.error.conflict"),
  });
  const canTighten = row.editable && options.length > 0;
  return (
    <li className="grid items-center gap-2 p-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="min-w-0">
        <p className="truncate font-medium">{countryLabel(row.countryCode)}</p>
        <p className="text-[12px] text-muted-foreground">{row.countryCode}</p>
      </div>
      <Badge variant={MODE_VARIANT[row.mode]}>{modeLabel(row.mode)}</Badge>
      {canTighten ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setTarget(options[0]!);
            setOpen(true);
          }}
          aria-label={t("policy.tighten.aria", { country: countryLabel(row.countryCode) })}
        >
          {t("policy.tighten")}
        </Button>
      ) : (
        <span className="text-[12px] text-muted-foreground">
          {row.mode === "blocked" ? t("policy.strictest") : ""}
        </span>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        title={t("policy.tighten.title", { country: countryLabel(row.countryCode) })}
        description={t("policy.tighten.body", { mode: modeLabel(row.mode) })}
        confirmLabel={t("policy.tighten")}
        onConfirm={async () => {
          await tighten.mutateAsync(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`policy-target-${row.countryCode}`}>{t("policy.target")}</Label>
          <Select
            id={`policy-target-${row.countryCode}`}
            value={target}
            onChange={(e) => setTarget(e.target.value as PolicyMode)}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </ConfirmDialog>
    </li>
  );
}

/**
 * Ülke politikası (FR-CMPL-01). Demo politikaları yalnızca SIKILAŞTIRILABİLİR; gerçek gönderim politikaları kilitli ve
 * salt okunurdur. Bu modlar hukuki uygunluğun kanıtı değildir.
 */
export function PolicyPanel() {
  const q = usePolicies();
  const [search, setSearch] = useState("");
  if (q.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const rows = filterPolicies(q.data.demo, search);
  const live = q.data.live;
  return (
    <div className="space-y-4">
      <Notice>
        <span className="inline-flex items-start gap-1.5">
          <span>{t("policy.note")}</span>
          <HelpTip className="mt-0.5 shrink-0">{t("help.policyMode")}</HelpTip>
        </span>
      </Notice>
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label={t("policy.search")}
          placeholder={t("policy.search")}
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState
          className="rounded-xl border border-dashed bg-card p-8"
          icon={ShieldCheck}
          title={t("policy.empty")}
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-xs" aria-label={t("policy.list")}>
          {rows.map((r) => (
            <PolicyRow key={r.countryCode} row={r} />
          ))}
        </ul>
      )}
      <details className="rounded-xl border bg-card p-4 shadow-xs">
        <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold">
          <Lock className="size-4" aria-hidden /> {t("policy.live.title")}
          <Badge variant="danger">
            {q.data.liveSendingEnabled ? t("policy.live.on") : t("policy.live.off")}
          </Badge>
        </summary>
        <p className="mt-2 text-[13px] text-muted-foreground">{t("policy.live.body")}</p>
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t("policy.live.title")}>
          {live.map((r) => (
            <li key={r.countryCode}>
              <Badge variant="outline">
                <Lock className="size-3" aria-hidden /> {countryLabel(r.countryCode)} ·{" "}
                {modeLabel(r.mode)}
              </Badge>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
