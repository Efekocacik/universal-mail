"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  FlaskConical,
  Info,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { api } from "@/lib/client/api";
import { qk, useCountries, useSettings } from "@/lib/client/queries";
import type { CompanyProfile } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import {
  companyPayload,
  isCompanyStepValid,
  isValidTrIdentifier,
  TR_IDENTIFIER_KEYS,
  type TrIdentifierKey,
} from "./company-step";

const STEPS = ["welcome", "company", "markets", "google", "budget", "finish"] as const;
type Step = (typeof STEPS)[number];

const EMPTY_COMPANY: CompanyProfile = {
  legalName: "",
  address: "",
  taxId: "",
  phone: "",
  contactName: "",
  contactTitle: "",
  website: "",
  mersisNo: "",
  tradeRegistryNo: "",
};

function Stepper({ index }: { index: number }) {
  return (
    <div className="space-y-2">
      <ol className="flex items-center gap-1.5" aria-label={t("setup.steps")}>
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <span
              aria-current={i === index ? "step" : undefined}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-colors duration-150",
                i < index
                  ? "bg-success text-success-foreground"
                  : i === index
                    ? "bg-accent text-accent-foreground ring-2 ring-primary"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {i < index ? <Check className="size-4" strokeWidth={3} aria-hidden /> : i + 1}
              <span className="sr-only">
                {" "}
                {t(`setup.step.${s}`)}
                {i < index ? ` (${t("setup.stepDone")})` : ""}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "hidden truncate text-[12px] font-medium sm:inline",
                i === index ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {t(`setup.step.${s}`)}
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={cn(
                  "h-px min-w-2 flex-1 transition-colors duration-150",
                  i < index ? "bg-success" : "bg-border",
                )}
              />
            )}
          </li>
        ))}
      </ol>
      <p className="text-[12px] text-muted-foreground">
        {t("setup.progress", { n: index + 1, total: STEPS.length })}
      </p>
    </div>
  );
}

/** Alan altı hata: yalnızca kullanıcı alana dokunduktan sonra görünür; yer her zaman ayrılır (zıplama yok). */
function FieldError({ id, message }: { id: string; message?: string | null }) {
  return (
    <p
      id={id}
      className="min-h-4 text-[12px] text-destructive"
      role={message ? "alert" : undefined}
    >
      {message ?? ""}
    </p>
  );
}

/** "Neden soruyoruz?" tek cümlelik açıklama. */
function Why({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-info/10 px-3 py-2 text-[13px] text-foreground">
      <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <span>
        <span className="font-medium">{t("setup.why.label")}</span> {children}
      </span>
    </p>
  );
}

export function SetupWizard() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useSettings();
  const { data: countries } = useCountries();
  const [index, setIndex] = useState<number | null>(null);

  // Form durumları
  const [accepted, setAccepted] = useState(false);
  const [signer, setSigner] = useState({ name: "", title: "" });
  const [company, setCompany] = useState<CompanyProfile>(EMPTY_COMPANY);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState<"google" | "mock">("google");
  const [placesKey, setPlacesKey] = useState("");
  const [mapsKey, setMapsKey] = useState("");
  const [mapId, setMapId] = useState("");
  const [keyTest, setKeyTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [budget, setBudget] = useState("30");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((o) => (o[k] ? o : { ...o, [k]: true }));

  // Kaldığı yerden devam: ilk eksik adımı bul.
  useEffect(() => {
    if (!data || index !== null) return;
    const s = data.settings;
    setSigner({ name: s.consent?.name ?? "", title: s.consent?.title ?? "" });
    setAccepted(!!s.consent);
    setCompany({ ...EMPTY_COMPANY, ...(s["company.profile"] ?? {}) });
    setSelected(s["targets.countries"]);
    setProvider(s["places.provider"]);
    setMapId(s["maps.mapId"]);
    setBudget(String(s["budget.monthlyUsd"]));
    const first = !s.consent
      ? 0
      : !s["company.profile"]
        ? 1
        : s["targets.countries"].length === 0
          ? 2
          : s["places.provider"] === "google" && !data.secrets.placesKey.set
            ? 3
            : 5;
    setIndex(first);
  }, [data, index]);

  const refresh = () => {
    for (const k of [qk.settings, qk.config, qk.status]) void qc.invalidateQueries({ queryKey: k });
  };

  const saveConsent = useMutation({
    mutationFn: () =>
      api("/api/setup/consent", {
        method: "POST",
        json: { name: signer.name.trim(), title: signer.title.trim() || undefined, accept: true },
      }),
  });
  const saveSettings = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api("/api/settings", { method: "PUT", json: patch }),
  });
  const saveSecret = useMutation({
    mutationFn: (v: { name: string; value: string }) =>
      api("/api/secrets", { method: "POST", json: v }),
  });
  const testKey = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>("/api/setup/test-places", { method: "POST" }),
    onSuccess: (r) =>
      setKeyTest(r.ok ? r : { ok: false, message: `${r.message} ${t("setup.keyTest.fail")}` }),
  });
  const complete = useMutation({
    mutationFn: () => api("/api/setup/complete", { method: "POST" }),
    onSuccess: () => {
      refresh();
      router.replace("/");
      router.refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const countryList = useMemo(
    () =>
      (countries?.countries ?? []).filter((c) =>
        c.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [countries, filter],
  );
  const keyStored = data?.secrets.placesKey.set ?? false;

  if (isLoading || index === null || !data) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const step: Step = STEPS[index]!;
  const budgetNum = Number(budget.replace(",", "."));
  const budgetValid = Number.isFinite(budgetNum) && budgetNum >= 0 && budgetNum <= 100000;
  const companyValid = isCompanyStepValid(company);

  const minErr = (v: string, n: number) =>
    v.trim().length === 0
      ? t("setup.err.required")
      : v.trim().length < n
        ? t("setup.err.min", { n })
        : null;
  const err = (k: string, v: string, n: number) => (touched[k] ? minErr(v, n) : null);
  const keyShort = placesKey.trim().length > 0 && placesKey.trim().length < 8;

  const next = async () => {
    try {
      if (step === "welcome") {
        await saveConsent.mutateAsync();
      } else if (step === "company") {
        await saveSettings.mutateAsync({ "company.profile": companyPayload(company) });
      } else if (step === "markets") {
        await saveSettings.mutateAsync({ "targets.countries": selected });
      } else if (step === "google") {
        await saveSettings.mutateAsync({ "places.provider": provider, "maps.mapId": mapId.trim() });
        if (provider === "google") {
          if (placesKey.trim())
            await saveSecret.mutateAsync({ name: "google.placesKey", value: placesKey.trim() });
          if (mapsKey.trim())
            await saveSecret.mutateAsync({ name: "google.mapsKey", value: mapsKey.trim() });
        }
      } else if (step === "budget") {
        await saveSettings.mutateAsync({ "budget.monthlyUsd": budgetNum });
      }
      refresh();
      setIndex(index + 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const busy = saveConsent.isPending || saveSettings.isPending || saveSecret.isPending;
  const canNext =
    step === "welcome"
      ? accepted && signer.name.trim().length >= 2
      : step === "company"
        ? companyValid
        : step === "markets"
          ? selected.length > 0
          : step === "google"
            ? provider === "mock" || keyStored || placesKey.trim().length >= 8
            : step === "budget"
              ? budgetValid
              : true;

  const blocked = !canNext && step !== "finish";
  const finishBlocked = step === "finish" && data.setup.missing.length > 0;

  const companyField = (
    k:
      | "legalName"
      | "taxId"
      | "phone"
      | "contactName"
      | "contactTitle"
      | "website"
      | TrIdentifierKey,
    label: string,
    min: number,
    props: { placeholder?: string; autoComplete?: string } = {},
  ) => {
    // İsteğe bağlı TR tanımlayıcıları: biçim hatası yazarken hemen gösterilir (boş bırakmak her zaman geçerli).
    const e =
      min > 0
        ? err(k, company[k] ?? "", min)
        : (TR_IDENTIFIER_KEYS as readonly string[]).includes(k) && !isValidTrIdentifier(company[k])
          ? t("setup.err.identifier")
          : null;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`c-${k}`}>{label}</Label>
        <Input
          id={`c-${k}`}
          value={company[k] ?? ""}
          onChange={(ev) => setCompany((c) => ({ ...c, [k]: ev.target.value }))}
          onBlur={() => touch(k)}
          aria-required={min > 0 || undefined}
          aria-invalid={!!e}
          aria-describedby={`c-${k}-err`}
          {...props}
        />
        <FieldError id={`c-${k}-err`} message={e} />
      </div>
    );
  };
  const addressErr = err("address", company.address, 5);

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-5 py-8">
        <header className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground">
            U
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">Universal Mail</h1>
            <p className="text-[12px] text-muted-foreground">{t("setup.tagline")}</p>
          </div>
        </header>

        <Stepper index={index} />

        <main
          key={step}
          className="um-enter min-h-[26rem] flex-1 space-y-5 rounded-2xl border bg-card p-6 shadow-xs"
        >
          {step === "welcome" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.welcome.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">
                  {t("setup.welcome.body")}
                </p>
              </div>
              <ul className="space-y-2 rounded-xl bg-muted/60 p-4 text-[13px]">
                {(["1", "2", "3", "4", "5", "6"] as const).map((n) => (
                  <li key={n} className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>{t(`consent.${n}`)}</span>
                  </li>
                ))}
              </ul>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="s-name">{t("setup.consent.name")}</Label>
                  <Input
                    id="s-name"
                    value={signer.name}
                    onChange={(e) => setSigner({ ...signer, name: e.target.value })}
                    onBlur={() => touch("signer")}
                    autoComplete="name"
                    aria-required
                    aria-invalid={!!(touched.signer && minErr(signer.name, 2))}
                    aria-describedby="s-name-err"
                  />
                  <FieldError
                    id="s-name-err"
                    message={touched.signer ? minErr(signer.name, 2) : null}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s-title">{t("setup.consent.title")}</Label>
                  <Input
                    id="s-title"
                    value={signer.title}
                    onChange={(e) => setSigner({ ...signer, title: e.target.value })}
                    autoComplete="organization-title"
                  />
                  <FieldError id="s-title-err" />
                </div>
              </div>
              <div>
                <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                  <Checkbox
                    checked={accepted}
                    onCheckedChange={(v) => {
                      setAccepted(v === true);
                      touch("accept");
                    }}
                    className="mt-0.5"
                  />
                  <span>{t("setup.consent.accept")}</span>
                </label>
                <FieldError
                  id="s-accept-err"
                  message={touched.accept && !accepted ? t("setup.err.consent") : null}
                />
              </div>
              <p className="text-[12px] text-muted-foreground">{t("setup.consent.note")}</p>
              <Why>{t("setup.why.welcome")}</Why>
            </>
          )}

          {step === "company" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.company.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">
                  {t("setup.company.body")}
                </p>
              </div>
              <div className="grid gap-x-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  {companyField("legalName", t("company.legalName"), 2, {
                    autoComplete: "organization",
                  })}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="c-address">{t("company.address")}</Label>
                  <Textarea
                    id="c-address"
                    value={company.address}
                    onChange={(e) => setCompany((c) => ({ ...c, address: e.target.value }))}
                    onBlur={() => touch("address")}
                    className="min-h-16"
                    autoComplete="street-address"
                    aria-required
                    aria-invalid={!!addressErr}
                    aria-describedby="c-address-err"
                  />
                  <FieldError id="c-address-err" message={addressErr} />
                </div>
                {companyField("taxId", t("company.taxId"), 2)}
                {companyField("phone", t("company.phone"), 5, { autoComplete: "tel" })}
                {companyField("contactName", t("company.contactName"), 2, {
                  autoComplete: "name",
                })}
                {companyField("contactTitle", t("company.contactTitle"), 0)}
                <div className="sm:col-span-2">
                  {companyField("website", t("company.website"), 0, { placeholder: "https://" })}
                </div>
                {companyField("mersisNo", t("company.mersisNo"), 0)}
                {companyField("tradeRegistryNo", t("company.tradeRegistryNo"), 0)}
                <p className="text-[12px] text-muted-foreground sm:col-span-2">
                  {t("company.trHint")}
                </p>
              </div>
              <Why>{t("setup.why.company")}</Why>
            </>
          )}

          {step === "markets" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.markets.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">
                  {t("setup.markets.body")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("settings.markets.filter")}
                  aria-label={t("settings.markets.filter")}
                  className="max-w-64"
                />
                <span className="tabular text-[13px] text-muted-foreground">
                  {t("settings.markets.count", { n: selected.length })}
                </span>
              </div>
              <div className="min-h-9" aria-label={t("setup.markets.chosen")}>
                {selected.length === 0 ? (
                  <p className="py-1.5 text-[13px] text-muted-foreground">
                    {t("setup.markets.none")}
                  </p>
                ) : (
                  <ul className="um-scroll flex max-h-20 flex-wrap gap-1.5">
                    {selected.map((code) => {
                      const name = countries?.countries.find((c) => c.code === code)?.name ?? code;
                      return (
                        <li key={code}>
                          <span className="inline-flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-accent-foreground">
                            <Check className="size-3" strokeWidth={3} aria-hidden />
                            {name}
                            <button
                              type="button"
                              aria-label={t("setup.markets.remove", { name })}
                              onClick={() => setSelected(selected.filter((x) => x !== code))}
                              className="flex size-5 items-center justify-center rounded-full hover:bg-foreground/10"
                            >
                              <X className="size-3" aria-hidden />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <ul className="um-scroll grid h-64 grid-cols-2 content-start gap-x-4 sm:grid-cols-3">
                {countryList.map((c) => (
                  <li key={c.code}>
                    <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-accent/60">
                      <Checkbox
                        checked={selected.includes(c.code)}
                        onCheckedChange={(v) =>
                          setSelected(
                            v === true
                              ? [...selected, c.code]
                              : selected.filter((x) => x !== c.code),
                          )
                        }
                      />
                      {c.name}
                      {c.code === "TR" && (
                        <Badge variant="outline">{t("settings.markets.trNote")}</Badge>
                      )}
                    </label>
                  </li>
                ))}
                {countryList.length === 0 && (
                  <li className="col-span-full py-4 text-[13px] text-muted-foreground">
                    {t("setup.markets.empty")}
                  </li>
                )}
              </ul>
              <p className="text-[12px] text-muted-foreground">{t("setup.markets.trWhy")}</p>
              <Why>{t("setup.why.markets")}</Why>
              <p className="text-[12px] text-muted-foreground">{t("setup.markets.note")}</p>
            </>
          )}

          {step === "google" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.google.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">{t("setup.google.body")}</p>
              </div>
              <div
                className="grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label={t("settings.provider")}
              >
                {(["google", "mock"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={provider === p}
                    onClick={() => setProvider(p)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      provider === p ? "border-primary bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      {p === "mock" && <FlaskConical className="size-4 text-nov-future" />}
                      {t(`settings.provider.${p}`)}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {t(`settings.provider.${p}.desc`)}
                    </p>
                  </button>
                ))}
              </div>
              {provider === "google" ? (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="s-places">{t("settings.placesKey")}</Label>
                    <Input
                      id="s-places"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={placesKey}
                      onChange={(e) => setPlacesKey(e.target.value)}
                      onBlur={() => touch("placesKey")}
                      aria-invalid={touched.placesKey && keyShort}
                      aria-describedby="s-places-err"
                      placeholder={
                        keyStored
                          ? `${data.secrets.placesKey.masked} · ${t("settings.key.replace")}`
                          : t("settings.key.paste")
                      }
                    />
                    <p className="text-[12px] text-muted-foreground">
                      {t("settings.placesKey.help")}
                    </p>
                    <FieldError
                      id="s-places-err"
                      message={touched.placesKey && keyShort ? t("setup.err.key") : null}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={testKey.isPending}
                      disabled={!keyStored && placesKey.trim().length < 8}
                      onClick={async () => {
                        try {
                          if (placesKey.trim()) {
                            await saveSecret.mutateAsync({
                              name: "google.placesKey",
                              value: placesKey.trim(),
                            });
                            setPlacesKey("");
                            await qc.invalidateQueries({ queryKey: qk.settings });
                          }
                          await saveSettings.mutateAsync({ "places.provider": "google" });
                          testKey.mutate();
                        } catch (e) {
                          setKeyTest({
                            ok: false,
                            message: `${(e as Error).message} ${t("setup.keyTest.fail")}`,
                          });
                        }
                      }}
                    >
                      {!testKey.isPending && <FlaskConical />} {t("settings.key.test")}
                    </Button>
                    {keyTest && (
                      <p
                        className={cn(
                          "um-enter flex items-start gap-1.5 text-[13px]",
                          keyTest.ok ? "text-success" : "text-destructive",
                        )}
                        role="status"
                      >
                        {keyTest.ok ? (
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                        ) : (
                          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                        )}{" "}
                        {keyTest.message}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s-maps">{t("settings.mapsKey")}</Label>
                    <Input
                      id="s-maps"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={mapsKey}
                      onChange={(e) => setMapsKey(e.target.value)}
                      placeholder={
                        data.secrets.mapsKey.set
                          ? `${data.secrets.mapsKey.masked} · ${t("settings.key.replace")}`
                          : t("settings.key.paste")
                      }
                    />
                    <p className="text-[12px] text-muted-foreground">
                      {t("settings.mapsKey.help")}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s-mapid">{t("settings.mapId")}</Label>
                    <Input
                      id="s-mapid"
                      value={mapId}
                      onChange={(e) => setMapId(e.target.value)}
                      placeholder={t("settings.mapId.placeholder")}
                      spellCheck={false}
                    />
                  </div>
                  <p className="whitespace-pre-line text-[12px] text-muted-foreground">
                    {t("setup.google.guide")}
                  </p>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-nov-future/50 bg-nov-future/5 p-3 text-[13px] text-muted-foreground">
                  {t("setup.google.demoNote")}
                </p>
              )}
              <Why>{t("setup.why.google")}</Why>
            </>
          )}

          {step === "budget" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.budget.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">{t("setup.budget.body")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-budget">{t("settings.budget.monthly")}</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="s-budget"
                    inputMode="decimal"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={() => touch("budget")}
                    className="w-32"
                    aria-invalid={touched.budget && !budgetValid}
                    aria-describedby="s-budget-err"
                  />
                </div>
                <FieldError
                  id="s-budget-err"
                  message={touched.budget && !budgetValid ? t("setup.err.budget") : null}
                />
              </div>
              <ul className="list-disc space-y-1.5 rounded-xl bg-muted/60 py-3 pl-8 pr-4 text-[13px] text-muted-foreground">
                <li>{t("setup.budget.tip1")}</li>
                <li>{t("setup.budget.tip2")}</li>
                <li>{t("setup.budget.tip3")}</li>
              </ul>
              <Why>{t("setup.why.budget")}</Why>
            </>
          )}

          {step === "finish" && (
            <>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("setup.finish.title")}</h2>
                <p className="mt-1.5 text-[14px] text-muted-foreground">{t("setup.finish.body")}</p>
              </div>
              <dl className="divide-y rounded-xl border text-[13px]">
                {[
                  [
                    t("setup.summary.signer"),
                    `${data.settings.consent?.name ?? signer.name}${data.settings.consent?.title ? `, ${data.settings.consent.title}` : ""}`,
                  ],
                  [t("setup.summary.company"), data.settings["company.profile"]?.legalName ?? "—"],
                  [
                    t("setup.summary.markets"),
                    t("settings.markets.count", { n: data.settings["targets.countries"].length }),
                  ],
                  [
                    t("setup.summary.provider"),
                    t(`settings.provider.${data.settings["places.provider"]}`),
                  ],
                  [t("setup.summary.budget"), `$${data.settings["budget.monthlyUsd"]}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              {data.setup.missing.length > 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{" "}
                  {t("setup.finish.missing", { list: data.setup.missing.join(", ") })}
                </p>
              )}
              <Why>{t("setup.why.finish")}</Why>
            </>
          )}
        </main>

        <footer className="space-y-2">
          <p
            className="min-h-5 text-right text-[13px] text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {blocked || finishBlocked ? t(`setup.blocked.${step}`) : ""}
          </p>
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => setIndex(Math.max(0, index - 1))}
              disabled={index === 0 || busy || complete.isPending}
            >
              <ArrowLeft aria-hidden /> {t("setup.back")}
            </Button>
            {step === "finish" ? (
              <Button
                size="lg"
                onClick={() => complete.mutate()}
                loading={complete.isPending}
                disabled={finishBlocked}
              >
                {!complete.isPending && <CheckCircle2 aria-hidden />} {t("setup.finish.cta")}
              </Button>
            ) : (
              <Button onClick={next} loading={busy} disabled={!canNext}>
                {t("setup.next")} <ArrowRight aria-hidden />
              </Button>
            )}
          </div>
        </footer>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
