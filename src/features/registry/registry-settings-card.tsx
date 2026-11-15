"use client";

import { CheckCircle2, CircleAlert, FlaskConical, Info } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError, Input, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { SecretRow, Section, ToggleRow, useSave } from "@/features/settings/shared";
import { errorText } from "@/lib/client/api";
import { useSettings } from "@/lib/client/queries";
import { codeLabel, useTestRegistry, type RegistrySource } from "@/lib/client/registry";
import type { SecretInfo } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { codesForScheme } from "@/lib/registry/codes";

/**
 * Ayarlar → Resmî siciller: Companies House / INSEE aç-kapa, varsayılan kodlar ve pencere, kod tablosu (NAF 2025 notu),
 * anahtarlar ve "Bağlantıyı sına". Ayarlar `registry.companiesHouse` / `registry.insee`; anahtarlar gizli depoda.
 * Demo kipinde (Places = mock) siciller anahtarsız çalışır; kart bunu söyler.
 */
export function RegistrySettingsCard() {
  const { data } = useSettings();
  if (!data) return <Skeleton className="h-40" />;
  const demo = data.settings["places.provider"] === "mock";
  return (
    <Section title={t("registry.settings.title")} description={t("registry.settings.desc")}>
      {demo && (
        <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("registry.settings.demo")}
        </p>
      )}
      <SourceBlock source="companies_house" secret={data.secrets.companiesHouseKey} demo={demo} />
      <SourceBlock source="insee" secret={data.secrets.inseeKey} demo={demo} />
      <p className="text-[12px] text-muted-foreground">{t("registry.settings.limit")}</p>
      <Link href="/scans/registry" className="text-[13px] font-medium text-primary underline">
        {t("registry.settings.openPage")}
      </Link>
    </Section>
  );
}

type ChSetting = { enabled: boolean; sicCodes: string[]; windowDays: number };
type FrSetting = {
  enabled: boolean;
  nafCodes: string[];
  windowDays: number;
  scheme: "NAFRev2" | "NAF2025";
};

function SourceBlock({
  source,
  secret,
  demo,
}: {
  source: RegistrySource;
  secret: SecretInfo;
  demo: boolean;
}) {
  const { data } = useSettings();
  const save = useSave();
  const test = useTestRegistry();
  const ids = useId();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const isCh = source === "companies_house";
  const key = isCh ? "registry.companiesHouse" : "registry.insee";
  const value = data!.settings[key] as ChSetting | FrSetting;
  const codes = "sicCodes" in value ? value.sicCodes : value.nafCodes;
  const options = codesForScheme(isCh ? "SIC2007" : "NAFRev2");
  const [days, setDays] = useState(String(value.windowDays));
  const daysNum = Number(days);
  const daysOk = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365;

  const patch = (next: Partial<ChSetting & FrSetting>) => {
    const merged = { ...value, ...next };
    if (isCh) delete (merged as Partial<FrSetting>).nafCodes;
    save.mutate({ [key]: merged });
  };
  const setCodes = (list: string[]) => patch(isCh ? { sicCodes: list } : { nafCodes: list });

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid={`registry-settings-${source}`}>
      <ToggleRow
        id={`${ids}-on`}
        label={t(isCh ? "registry.settings.ch.enable" : "registry.settings.insee.enable")}
        hint={t(isCh ? "registry.settings.ch.hint" : "registry.settings.insee.hint")}
        checked={value.enabled}
        onChange={(v) => patch({ enabled: v })}
      />
      <fieldset className="space-y-1">
        <legend className="text-[13px] font-medium">{t("registry.settings.codes")}</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((code) => (
            <label
              key={code}
              htmlFor={`${ids}-${code}`}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-accent"
            >
              <Checkbox
                id={`${ids}-${code}`}
                checked={codes.includes(code)}
                disabled={save.isPending || (codes.length === 1 && codes.includes(code))}
                onCheckedChange={(c) =>
                  setCodes(c ? [...codes, code] : codes.filter((x) => x !== code))
                }
              />
              <span className="min-w-0">{codeLabel(code)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-days`}>{t("registry.settings.window")}</Label>
          <Input
            id={`${ids}-days`}
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            className="w-28"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onBlur={() => {
              if (daysOk && daysNum !== value.windowDays) patch({ windowDays: daysNum });
            }}
            aria-invalid={!daysOk}
            aria-describedby={daysOk ? undefined : `${ids}-days-err`}
          />
        </div>
        {!isCh && (
          <div className="space-y-1">
            <Label htmlFor={`${ids}-scheme`}>{t("registry.settings.scheme")}</Label>
            <Select
              id={`${ids}-scheme`}
              value={(value as FrSetting).scheme}
              onChange={(e) => patch({ scheme: e.target.value as FrSetting["scheme"] })}
              aria-describedby={`${ids}-naf`}
            >
              <option value="NAFRev2">{t("registry.settings.scheme.NAFRev2")}</option>
              <option value="NAF2025" disabled>
                {t("registry.settings.scheme.NAF2025")}
              </option>
            </Select>
          </div>
        )}
      </div>
      {!daysOk && (
        <FieldError id={`${ids}-days-err`}>{t("registry.form.windowInvalid")}</FieldError>
      )}
      {!isCh && (
        <p id={`${ids}-naf`} className="text-[12px] text-muted-foreground">
          {t("registry.settings.naf2025Note")}
        </p>
      )}
      {!demo && (
        <SecretRow
          name={isCh ? "registry.companiesHouseKey" : "registry.inseeKey"}
          label={t(isCh ? "registry.settings.chKey" : "registry.settings.inseeKey")}
          help={t("registry.settings.keyHelp")}
          info={secret}
        />
      )}
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!demo && !secret.set}
          loading={test.isPending}
          onClick={() =>
            test.mutate(source, {
              onSuccess: (r) =>
                setResult({
                  ok: true,
                  message: t(
                    r.demo ? "registry.settings.test.okDemo" : "registry.settings.test.ok",
                  ),
                }),
              onError: (e) => setResult({ ok: false, message: errorText(e) }),
            })
          }
        >
          {!test.isPending && <FlaskConical />} {t("registry.settings.test")}
        </Button>
        {result && (
          <p
            role="status"
            className={`flex items-start gap-1.5 text-[13px] ${result.ok ? "text-success" : "text-destructive"}`}
          >
            {result.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            {result.message}
          </p>
        )}
      </div>
    </div>
  );
}
