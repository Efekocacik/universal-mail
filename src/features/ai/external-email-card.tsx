"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FlaskConical } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { SecretRow, useSave } from "@/features/settings/shared";
import { api, errorText } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import { t } from "@/lib/i18n";

/**
 * Harici e-posta bulma (Hunter; Faz 5'te Snov eklenecek). Faz 5 P0'da Ayarlar → E-posta bulma bölümündeki satır içi
 * Hunter bloğundan DAVRANIŞ DEĞİŞMEDEN taşındı (aynı kimlikler ve metinler). Sahibi: paket A.
 */
export function ExternalEmailCard() {
  const { data } = useSettings();
  const save = useSave();
  const [quota, setQuota] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; remaining: number | null }>("/api/enrichment/external/test", {
        method: "POST",
      }),
    onSuccess: (r) =>
      setQuota({
        ok: true,
        message:
          r.remaining === null
            ? t("settings.email.quotaUnknown")
            : t("settings.email.quota", { n: fmtNumber(r.remaining) }),
      }),
    onError: (e: Error) => setQuota({ ok: false, message: errorText(e) }),
  });
  if (!data) return <Skeleton className="h-24" />;
  const ext = data.settings["enrichment.external"];
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="email-external">{t("settings.email.external")}</Label>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t("settings.email.external.help")}
          </p>
        </div>
        <Switch
          id="email-external"
          checked={ext.enabled}
          onCheckedChange={(v) =>
            save.mutate({ "enrichment.external": { ...ext, enabled: v === true } })
          }
        />
      </div>
      {ext.enabled && (
        <>
          <SecretRow
            name="hunter.apiKey"
            label={t("settings.email.hunterKey")}
            help={t("settings.email.hunterKey.help")}
            info={data.secrets.hunterKey}
          />
          {data.secrets.hunterKey.set && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => test.mutate()}
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
