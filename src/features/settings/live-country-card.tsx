"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { errorText } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import {
  LIVE_COUNTRY_QUERY_KEY,
  liveCountryApi,
  useLiveCountryState,
  type ActivationFormInput,
  type ActivationPlanResponse,
} from "@/lib/client/live-country";
import { t, type TrKey } from "@/lib/i18n";

/**
 * Ayarlar > Gönderim hesabı: CANLI ÜLKE AKTİVASYONU. Bir ülkenin gerçek gönderim kilidi yalnızca burada, hukuki
 * yetkilendirme KAYDI ve masaüstü uygulamasının YEREL onay penceresiyle açılır (sunucuda zorunlu; bu kart yalnızca
 * arayüzdür). Kayıt, hukuki yetkinin doğrulandığı anlamına gelmez; bu açıkça yazılır. Geri alma ülkeyi yeniden
 * kilitler ve çalışan canlı kampanyaları duraklatır.
 */

const EMPTY: ActivationFormInput = {
  countries: [],
  mode: "generic_only",
  representativeName: "",
  representativeTitle: "",
  operatorName: "",
  documentRef: "",
  documentDate: "",
  documentSha256: null,
  scopeAttested: false,
};

export function LiveCountryCard() {
  const qc = useQueryClient();
  const q = useLiveCountryState();
  const [form, setForm] = useState<ActivationFormInput>(EMPTY);
  const [plan, setPlan] = useState<ActivationPlanResponse | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const set = <K extends keyof ActivationFormInput>(k: K, v: ActivationFormInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPlan(null);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: LIVE_COUNTRY_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["campaigns"] });
  };

  const check = useMutation({
    mutationFn: () => liveCountryApi.plan(form),
    onSuccess: setPlan,
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const activate = useMutation({
    mutationFn: () => liveCountryApi.activate(form),
    onSuccess: () => {
      toast.success(t("countryActivation.form.activated"));
      setForm(EMPTY);
      setPlan(null);
      refresh();
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (code: string) => liveCountryApi.revoke([code]),
    onSuccess: (r) => {
      toast.success(t("countryActivation.revoked"));
      if (r.pausedCampaigns.length > 0)
        toast.warning(
          t("countryActivation.revoked.paused", { n: fmtNumber(r.pausedCampaigns.length) }),
        );
      setRevoking(null);
      refresh();
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });

  const data = q.data;
  const lockedCodes = useMemo(
    () => (data?.countries ?? []).filter((c) => c.mode === "blocked" && c.locked),
    [data],
  );
  const openRows = useMemo(
    () => (data?.countries ?? []).filter((c) => c.mode !== "blocked" || !c.locked),
    [data],
  );

  const toggleCountry = (code: string, on: boolean) =>
    set("countries", on ? [...form.countries, code] : form.countries.filter((c) => c !== code));

  const canSubmit =
    !!data?.nativeConfirmAvailable &&
    form.countries.length > 0 &&
    form.scopeAttested &&
    form.representativeName.trim() !== "" &&
    form.representativeTitle.trim() !== "" &&
    form.operatorName.trim() !== "" &&
    form.documentRef.trim() !== "" &&
    form.documentDate.trim() !== "";

  return (
    <Card className="um-enter" data-testid="live-country-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="size-4" aria-hidden /> {t("countryActivation.title")}
        </CardTitle>
        <CardDescription>{t("countryActivation.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-3">
        {q.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : q.isError || !data ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <Notice tone="warning">{t("countryActivation.disclaimer")}</Notice>
            {!data.nativeConfirmAvailable && (
              <Notice tone="danger">{t("countryActivation.noChannel")}</Notice>
            )}

            <section className="space-y-2" aria-label={t("countryActivation.checks.title")}>
              <h3 className="text-sm font-semibold">{t("countryActivation.checks.title")}</h3>
              <ul className="space-y-1 text-[13px]" data-testid="activation-checks">
                {data.prerequisites.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    <span
                      className={c.ok ? "text-success" : "text-destructive"}
                      aria-label={t(
                        c.ok ? "countryActivation.check.ok" : "countryActivation.check.missing",
                      )}
                    >
                      {c.ok ? "✓" : "✗"}
                    </span>
                    <span>{t(`countryActivation.check.${c.key}` as TrKey)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("countryActivation.active.title")}</h3>
              {openRows.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  {t("countryActivation.active.none")}
                </p>
              ) : (
                <ul className="space-y-2" data-testid="activation-open">
                  {openRows.map((r) => (
                    <li
                      key={r.countryCode}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-[13px]"
                    >
                      <span>
                        {t("countryActivation.active.row", {
                          code: r.countryCode,
                          mode: r.mode,
                          by: r.approvedBy ?? "-",
                          ref: r.approvalRef ?? "-",
                        })}
                      </span>
                      <Button
                        size="sm"
                        variant="dangerOutline"
                        onClick={() => setRevoking(r.countryCode)}
                      >
                        {t("countryActivation.revoke")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t("countryActivation.form.title")}</h3>
              <div className="space-y-1.5">
                <Label>{t("countryActivation.form.countries")}</Label>
                <div
                  className="grid max-h-40 grid-cols-3 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-5"
                  data-testid="activation-countries"
                >
                  {lockedCodes.map((c) => (
                    <label key={c.countryCode} className="flex items-center gap-1.5 text-[13px]">
                      <Checkbox
                        checked={form.countries.includes(c.countryCode)}
                        onCheckedChange={(v) => toggleCountry(c.countryCode, v === true)}
                      />
                      {c.countryCode}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="act-mode">{t("countryActivation.form.mode")}</Label>
                <Select
                  id="act-mode"
                  value={form.mode}
                  onChange={(e) => set("mode", e.target.value as ActivationFormInput["mode"])}
                >
                  <option value="generic_only">
                    {t("countryActivation.form.mode.generic_only")}
                  </option>
                  <option value="allowed">{t("countryActivation.form.mode.allowed")}</option>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id="act-rep"
                  label="countryActivation.form.rep"
                  value={form.representativeName}
                  onChange={(v) => set("representativeName", v)}
                />
                <Field
                  id="act-rep-title"
                  label="countryActivation.form.repTitle"
                  value={form.representativeTitle}
                  onChange={(v) => set("representativeTitle", v)}
                />
                <Field
                  id="act-operator"
                  label="countryActivation.form.operator"
                  value={form.operatorName}
                  onChange={(v) => set("operatorName", v)}
                />
                <Field
                  id="act-doc-ref"
                  label="countryActivation.form.docRef"
                  value={form.documentRef}
                  onChange={(v) => set("documentRef", v)}
                />
                <Field
                  id="act-doc-date"
                  label="countryActivation.form.docDate"
                  value={form.documentDate}
                  placeholder="2026-11-18"
                  onChange={(v) => set("documentDate", v)}
                />
                <Field
                  id="act-doc-sha"
                  label="countryActivation.form.docSha"
                  value={form.documentSha256 ?? ""}
                  onChange={(v) => set("documentSha256", v.trim() === "" ? null : v)}
                />
              </div>
              <label className="flex items-start gap-2 text-[13px]">
                <Checkbox
                  className="mt-0.5"
                  checked={form.scopeAttested}
                  onCheckedChange={(v) => set("scopeAttested", v === true)}
                  data-testid="activation-attest"
                />
                {t("countryActivation.form.attest")}
              </label>
              <FieldHint>{t("countryActivation.disclaimer")}</FieldHint>

              {plan && (
                <div className="space-y-1" data-testid="activation-plan">
                  <Notice tone={plan.ready ? "info" : "warning"}>
                    {t(
                      plan.ready
                        ? "countryActivation.plan.ready"
                        : "countryActivation.plan.notReady",
                    )}
                  </Notice>
                  {plan.warnings.map((w) => (
                    <Notice key={w} tone="warning">
                      {t(`countryActivation.warn.${w}` as TrKey)}
                    </Notice>
                  ))}
                </div>
              )}
              {activate.isPending && <Notice>{t("countryActivation.form.waiting")}</Notice>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  loading={check.isPending}
                  disabled={!canSubmit || activate.isPending}
                  onClick={() => check.mutate()}
                  data-testid="activation-check"
                >
                  {t("countryActivation.form.check")}
                </Button>
                <Button
                  size="sm"
                  loading={activate.isPending}
                  disabled={!canSubmit || check.isPending}
                  onClick={() => activate.mutate()}
                  data-testid="activation-activate"
                >
                  {t("countryActivation.form.activate")}
                </Button>
              </div>
            </section>

            <ConfirmDialog
              open={revoking !== null}
              onOpenChange={(o) => !o && setRevoking(null)}
              tone="danger"
              title={t("countryActivation.revoke.title")}
              description={t("countryActivation.revoke.body", { code: revoking ?? "" })}
              confirmLabel={t("countryActivation.revoke.confirm")}
              pending={revoke.isPending}
              onConfirm={async () => {
                if (revoking) await revoke.mutateAsync(revoking).catch(() => undefined);
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: TrKey;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t(label)}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
