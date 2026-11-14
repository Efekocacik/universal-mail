"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FlaskConical } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { SecretRow, useSave } from "@/features/settings/shared";
import { api, errorText } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import type { ExternalEmailProviderId } from "@/lib/client/types";
import { t } from "@/lib/i18n";

/**
 * Harici e-posta bulma (Faz 5 paket A): Hunter.io veya Snov.io. Açık/kapalı, servis seçimi, seçili servisin
 * anahtar(lar)ı ve "anahtarı dene ve kotayı göster". Kimlikler (`email-external`, `hunter.apiKey`) P0'daki taşınmış
 * Hunter bloğuyla aynıdır. Demo kipinde servis ağa çıkmaz.
 */
interface TestResponse {
  ok: boolean;
  provider: ExternalEmailProviderId;
  remaining: number | null;
  resetDate: string | null;
  demo: boolean;
}

export function ExternalEmailCard() {
  const { data } = useSettings();
  const save = useSave();
  const [quota, setQuota] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useMutation({
    mutationFn: (provider: ExternalEmailProviderId) =>
      api<TestResponse>("/api/enrichment/external/test", { method: "POST", json: { provider } }),
    onSuccess: (r) => {
      const base = r.demo
        ? t("ai.external.demoQuota", { n: fmtNumber(r.remaining ?? 0) })
        : r.remaining === null
          ? t("settings.email.quotaUnknown")
          : t("settings.email.quota", { n: fmtNumber(r.remaining) });
      setQuota({
        ok: true,
        message: r.resetDate
          ? `${base} ${t("ai.external.resetDate", { date: r.resetDate })}`
          : base,
      });
    },
    onError: (e: Error) => setQuota({ ok: false, message: errorText(e) }),
  });
  if (!data) return <Skeleton className="h-24" />;
  const ext = data.settings["enrichment.external"];
  const demo = data.settings["places.provider"] === "mock";
  const configured =
    ext.provider === "snov"
      ? data.secrets.snovClientId.set && data.secrets.snovClientSecret.set
      : data.secrets.hunterKey.set;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="email-external">{t("ai.external.title")}</Label>
          <p id="email-external-help" className="mt-1 text-[12px] text-muted-foreground">
            {t("ai.external.help")}
          </p>
        </div>
        <Switch
          id="email-external"
          checked={ext.enabled}
          aria-describedby="email-external-help"
          disabled={save.isPending}
          onCheckedChange={(v) =>
            save.mutate({ "enrichment.external": { ...ext, enabled: v === true } })
          }
        />
      </div>
      {ext.enabled && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="email-external-provider">{t("ai.external.provider")}</Label>
            <Select
              id="email-external-provider"
              value={ext.provider}
              disabled={save.isPending}
              className="max-w-xs"
              onChange={(e) => {
                setQuota(null);
                save.mutate({
                  "enrichment.external": {
                    ...ext,
                    provider: e.target.value as ExternalEmailProviderId,
                  },
                });
              }}
            >
              <option value="hunter">{t("ai.external.provider.hunter")}</option>
              <option value="snov">{t("ai.external.provider.snov")}</option>
            </Select>
          </div>
          {demo && (
            <p className="flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
              <Badge variant="info">{t("faz5.demoBadge")}</Badge>
              <span>{t("ai.external.demoNote")}</span>
            </p>
          )}
          {ext.provider === "hunter" ? (
            <SecretRow
              name="hunter.apiKey"
              label={t("settings.email.hunterKey")}
              help={t("settings.email.hunterKey.help")}
              info={data.secrets.hunterKey}
            />
          ) : (
            <>
              <SecretRow
                name="snov.clientId"
                label={t("secret.snov.clientId")}
                help={t("ai.external.snovId.help")}
                info={data.secrets.snovClientId}
              />
              <SecretRow
                name="snov.clientSecret"
                label={t("secret.snov.clientSecret")}
                help={t("ai.external.snovSecret.help")}
                info={data.secrets.snovClientSecret}
              />
            </>
          )}
          {(configured || demo) && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => test.mutate(ext.provider)}
                loading={test.isPending}
              >
                {!test.isPending && <FlaskConical />} {t("settings.email.test")}
              </Button>
              {quota && (
                <p
                  className={`flex items-start gap-1.5 text-[13px] ${quota.ok ? "text-success" : "text-destructive"}`}
                  role="status"
                >
                  {quota.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                  ) : (
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  )}{" "}
                  {quota.message}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
