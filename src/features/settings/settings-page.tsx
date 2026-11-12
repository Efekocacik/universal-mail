"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { LanguageSwitch, ThemeSwitch } from "@/components/appearance-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { HelpTip } from "@/components/ui/tooltip";
import { api, errorText } from "@/lib/client/api";
import { fmtDateTime, fmtNumber, fmtUsd } from "@/lib/client/format";
import {
  qk,
  useBudget,
  useCategories,
  useConfig,
  useCountries,
  useSettings,
} from "@/lib/client/queries";
import type { Category, CompanyProfile, GoogleDataSummary, SecretInfo } from "@/lib/client/types";
import { skuLabel, PRICING_VERIFIED_AT } from "@/lib/places/pricing";
import { MailboxSettingsSection } from "./mailbox-section";
import { UnsubscribeSettingsSection } from "./unsubscribe-section";
import { getLocale, t, type TrKey } from "@/lib/i18n";
import { mapIdProblem } from "@/lib/settings/map-id";

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    for (const key of [qk.settings, qk.config, qk.status, qk.budget, qk.categories])
      void qc.invalidateQueries({ queryKey: key });
  };
}

function useSave() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api("/api/settings", { method: "PUT", json: patch }),
    onSuccess: () => {
      invalidate();
      toast.success(t("common.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
}

function Section({
  title,
  description,
  help,
  children,
}: {
  title: string;
  description?: string;
  /** "Bu nedir?" balonu (yalnızca karmaşık kavramlarda; docs/07 §FR-UI-07). */
  help?: TrKey;
  children: React.ReactNode;
}) {
  return (
    <Card className="um-enter">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          {title}
          {help && <HelpTip>{t(help)}</HelpTip>}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 pt-3">{children}</CardContent>
    </Card>
  );
}

/** Satır içi hata: kırmızı metin + simge (renk tek başına anlam taşımaz). */
function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** Tek tip kaydetme çubuğu: değişiklik yoksa soluk "Değişiklik yok", varsa yeşil Kaydet. */
function SaveBar({
  dirty,
  valid = true,
  pending,
  onSave,
  type = "submit",
}: {
  dirty: boolean;
  valid?: boolean;
  pending: boolean;
  onSave?: () => void;
  type?: "submit" | "button";
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type={type} onClick={onSave} disabled={!dirty || !valid} loading={pending}>
        {t("common.save")}
      </Button>
      <span className="text-[12px] text-muted-foreground" aria-live="polite">
        {dirty ? t("settings.unsaved") : t("settings.noChange")}
      </span>
    </div>
  );
}

/* ----------------------------- Görünüm ve dil ----------------------------- */

/** Masaüstü (Electron) yetenekleri: tarayıcıda yok. İlk çizimde sunucu ile aynı olsun diye etkiden sonra okunur. */
function useDesktop() {
  const [desktop, setDesktop] = useState<{ loginItem: boolean; osNotifications: boolean } | null>(
    null,
  );
  useEffect(() => {
    const um = window.universalMail;
    setDesktop(um ? { loginItem: !!um.loginItem, osNotifications: !!um.osNotifications } : null);
  }, []);
  return desktop;
}

type DesktopSettings = { "app.openAtLogin"?: boolean; "notifications.os"?: boolean };

function AppearanceSection() {
  const { data: config } = useConfig();
  const { data } = useSettings();
  const save = useSave();
  const desktop = useDesktop();
  const s = data?.settings as (NonNullable<typeof data>["settings"] & DesktopSettings) | undefined;
  const openAtLogin = s?.["app.openAtLogin"] ?? false;
  const osNotif = s?.["notifications.os"] ?? true;

  // Masaüstü: kayıtlı "oturum açılınca başlat" tercihini işletim sistemiyle eşitle (ör. yeniden kurulumdan sonra).
  useEffect(() => {
    if (desktop?.loginItem && s)
      void window.universalMail?.setUiPrefs?.({ openAtLogin }).catch(() => undefined);
  }, [desktop?.loginItem, openAtLogin, s]);

  const toggle = (key: keyof DesktopSettings, value: boolean) =>
    save.mutate(
      { [key]: value },
      {
        onSuccess: () => {
          if (key === "app.openAtLogin")
            void window.universalMail?.setUiPrefs?.({ openAtLogin: value }).catch(() => undefined);
        },
      },
    );

  return (
    <Section title={t("settings.appearance.title")} description={t("settings.appearance.desc")}>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("settings.language")}</p>
        <LanguageSwitch value={config?.language ?? getLocale()} />
        <p className="text-[12px] text-muted-foreground">{t("settings.language.hint")}</p>
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("settings.theme")}</p>
        <ThemeSwitch />
        <p className="text-[12px] text-muted-foreground">{t("settings.theme.hint")}</p>
      </div>
      <div className="space-y-3 border-t pt-3">
        <p className="text-sm font-medium">{t("settings.desktop.title")}</p>
        {desktop ? (
          <>
            {desktop.loginItem && (
              <ToggleRow
                id="open-at-login"
                label={t("settings.openAtLogin.label")}
                hint={t("settings.openAtLogin.hint")}
                checked={openAtLogin}
                disabled={!s || save.isPending}
                onChange={(v) => toggle("app.openAtLogin", v)}
              />
            )}
            {desktop.osNotifications && (
              <ToggleRow
                id="os-notifications"
                label={t("settings.notificationsOs.label")}
                hint={t("settings.notificationsOs.hint")}
                checked={osNotif}
                disabled={!s || save.isPending}
                onChange={(v) => toggle("notifications.os", v)}
              />
            )}
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t("settings.desktop.browserOnly")}</p>
        )}
      </div>
    </Section>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

/* ----------------------------- Google bağlantısı ----------------------------- */

function SecretRow({
  name,
  label,
  help,
  info,
  testable,
}: {
  name: "google.placesKey" | "google.mapsKey" | "hunter.apiKey";
  label: string;
  help: string;
  info: SecretInfo;
  testable?: boolean;
}) {
  const invalidate = useInvalidateAll();
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const save = useMutation({
    mutationFn: () => api("/api/secrets", { method: "POST", json: { name, value } }),
    onSuccess: () => {
      setValue("");
      setShown(false);
      setResult(null);
      invalidate();
      toast.success(t("settings.key.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/secrets?name=${name}`, { method: "DELETE" }),
    onSuccess: () => {
      setResult(null);
      invalidate();
      toast.success(t("settings.key.removed"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>("/api/setup/test-places", { method: "POST" }),
    onSuccess: setResult,
    onError: (e: Error) => setResult({ ok: false, message: errorText(e) }),
  });

  const trimmed = value.trim();
  const tooShort = value.length > 0 && trimmed.length < 8;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={name} className="flex items-center gap-1.5">
          <KeyRound className="size-3.5" aria-hidden /> {label}
        </Label>
        {info.set ? (
          <Badge variant="success">
            <Check className="size-3" aria-hidden />
            {t("settings.key.set")} · {info.masked}
            {info.source === "env" ? ` · ${t("settings.key.fromEnv")}` : ""}
          </Badge>
        ) : (
          <Badge variant="warning">
            <CircleAlert className="size-3" aria-hidden />
            {t("settings.key.missing")}
          </Badge>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">{help}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length >= 8 && !save.isPending) save.mutate();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Input
            id={name}
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={info.set ? t("settings.key.replace") : t("settings.key.paste")}
            aria-invalid={tooShort}
            aria-describedby={tooShort ? `${name}-err` : undefined}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-0.5 right-0.5 size-8"
            aria-label={shown ? t("settings.key.hide") : t("settings.key.show")}
            aria-pressed={shown}
            onClick={() => setShown((v) => !v)}
          >
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <Button type="submit" disabled={trimmed.length < 8} loading={save.isPending}>
          {t("common.save")}
        </Button>
        {info.set && info.source === "store" && (
          <Button
            type="button"
            variant="dangerGhost"
            size="icon"
            aria-label={`${t("common.delete")}: ${label}`}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 />
          </Button>
        )}
      </form>
      {tooShort && <FieldError id={`${name}-err`}>{t("settings.key.tooShort")}</FieldError>}
      {testable && (
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            disabled={!info.set}
            loading={test.isPending}
          >
            {!test.isPending && <FlaskConical />} {t("settings.key.test")}
          </Button>
          {result && (
            <p
              className={`flex items-start gap-1.5 text-[13px] ${result.ok ? "text-success" : "text-destructive"}`}
              role="status"
            >
              {result.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}{" "}
              {result.message}
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        tone="danger"
        title={t("settings.key.remove.title")}
        description={t("settings.key.remove.body")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </div>
  );
}

function GoogleSection() {
  const { data } = useSettings();
  const save = useSave();
  const [mapId, setMapId] = useState("");
  useEffect(() => setMapId(data?.settings["maps.mapId"] ?? ""), [data?.settings]);
  if (!data) return <Skeleton className="h-64" />;
  const provider = data.settings["places.provider"];
  const savedMapId = data.settings["maps.mapId"] ?? "";
  const mapIdDirty = mapId.trim() !== savedMapId.trim();
  // Satır içi doğrulama: sunucuyla aynı kural (src/lib/settings/map-id.ts); geçersizken Kaydet kapalı.
  const mapIdErr = mapIdProblem(mapId);

  return (
    <Section title={t("settings.google.title")} description={t("settings.google.desc")}>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("settings.provider")}>
        {(["google", "mock"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            tabIndex={provider === p ? 0 : -1}
            onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              const other = p === "google" ? "mock" : "google";
              if (!save.isPending) save.mutate({ "places.provider": other });
            }}
            disabled={save.isPending}
            onClick={() => provider !== p && save.mutate({ "places.provider": p })}
            className={`rounded-lg border p-3 text-left transition-colors duration-150 ${provider === p ? "border-primary bg-accent" : "hover:bg-accent/50"}`}
          >
            <p className="flex items-center justify-between gap-2 text-sm font-semibold">
              {t(`settings.provider.${p}`)}
              {provider === p && <Check className="size-4 text-primary" aria-hidden />}
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {t(`settings.provider.${p}.desc`)}
            </p>
          </button>
        ))}
      </div>
      {provider === "google" && (
        <>
          <SecretRow
            name="google.placesKey"
            label={t("settings.placesKey")}
            help={t("settings.placesKey.help")}
            info={data.secrets.placesKey}
            testable
          />
          <SecretRow
            name="google.mapsKey"
            label={t("settings.mapsKey")}
            help={t("settings.mapsKey.help")}
            info={data.secrets.mapsKey}
          />
        </>
      )}
      {provider === "mock" && (
        <>
          <SecretRow
            name="google.mapsKey"
            label={t("settings.mapsKey.optional")}
            help={t("settings.mapsKey.optional.help")}
            info={data.secrets.mapsKey}
          />
          <DemoTools epoch={data.settings["mock.epoch"]} />
        </>
      )}
      <details className="group rounded-lg border">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-[13px] font-medium hover:bg-accent/50">
          {t("settings.advanced")}: {t("settings.mapId")}
          <ChevronDown
            className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <form
          className="space-y-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (mapIdDirty && !mapIdErr) save.mutate({ "maps.mapId": mapId.trim() });
          }}
        >
          <Label htmlFor="mapId" className="flex items-center gap-1.5">
            {t("settings.mapId")}
            <HelpTip>{t("help.mapId")}</HelpTip>
          </Label>
          <Input
            id="mapId"
            value={mapId}
            onChange={(e) => setMapId(e.target.value)}
            placeholder={t("settings.mapId.placeholder")}
            spellCheck={false}
            className="max-w-sm"
            aria-invalid={!!mapIdErr}
            aria-describedby={mapIdErr ? "mapId-err" : undefined}
          />
          {mapIdErr && (
            <FieldError id="mapId-err">{t(`settings.mapId.err.${mapIdErr}`)}</FieldError>
          )}
          <p className="text-[12px] text-muted-foreground">{t("settings.mapId.help")}</p>
          <SaveBar dirty={mapIdDirty} valid={!mapIdErr} pending={save.isPending} />
        </form>
      </details>
    </Section>
  );
}

function DemoTools({ epoch }: { epoch: number }) {
  const invalidate = useInvalidateAll();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"purge" | "reset" | null>(null);
  const act = useMutation({
    mutationFn: (action: "advance" | "reset" | "purge") =>
      api<{ epoch?: number; places?: number }>("/api/dev/mock", {
        method: "POST",
        json: { action },
      }),
    onSuccess: (r, action) => {
      invalidate();
      void qc.invalidateQueries();
      toast.success(
        action === "purge"
          ? t("settings.demo.purged", { n: r.places ?? 0 })
          : t("settings.demo.epoch", { n: r.epoch ?? 0 }),
      );
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-nov-future/50 bg-nov-future/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-nov-future">
        <FlaskConical className="size-4" aria-hidden /> {t("settings.demo.title")}
      </p>
      <p className="text-[13px] text-muted-foreground">{t("settings.demo.body")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => act.mutate("advance")}
          loading={act.isPending && act.variables === "advance"}
          disabled={act.isPending}
        >
          {t("settings.demo.advance")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirm("reset")}
          disabled={act.isPending || epoch === 0}
        >
          {t("settings.demo.reset")}
        </Button>
        <span className="tabular text-[12px] text-muted-foreground">
          {t("settings.demo.current", { n: epoch })}
        </span>
        <Button
          size="sm"
          variant="dangerOutline"
          className="ml-auto"
          onClick={() => setConfirm("purge")}
          disabled={act.isPending}
        >
          <Trash2 /> {t("settings.demo.purge")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm === "purge"}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="danger"
        title={t("settings.demo.purge.title")}
        description={t("settings.demo.purge.body")}
        confirmLabel={t("settings.demo.purge.confirm")}
        onConfirm={async () => {
          await act.mutateAsync("purge");
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="success"
        title={t("settings.demo.reset.title")}
        description={t("settings.demo.reset.body")}
        confirmLabel={t("settings.demo.reset.confirm")}
        onConfirm={async () => {
          await act.mutateAsync("reset");
        }}
      />
    </div>
  );
}

/* --------------------------------- Bütçe ---------------------------------- */

function BudgetSection() {
  const { data } = useSettings();
  const { data: budget } = useBudget();
  const save = useSave();
  const [value, setValue] = useState("30");
  useEffect(() => {
    if (data) setValue(String(data.settings["budget.monthlyUsd"]));
  }, [data]);
  const num = Number(value.replace(",", "."));
  const valid = Number.isFinite(num) && value.trim() !== "" && num >= 0 && num <= 100000;
  const dirty = !!data && valid && num !== data.settings["budget.monthlyUsd"];

  return (
    <Section
      title={t("settings.budget.title")}
      description={t("settings.budget.desc")}
      help="help.budget"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty) save.mutate({ "budget.monthlyUsd": num });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="budget">{t("settings.budget.monthly")}</Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground" aria-hidden>
              $
            </span>
            <Input
              id="budget"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-28"
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : "budget-err"}
            />
          </div>
          {!valid && <FieldError id="budget-err">{t("settings.budget.invalid")}</FieldError>}
        </div>
        <SaveBar dirty={dirty} valid={valid} pending={save.isPending} />
      </form>
      {budget && (
        <div className="space-y-3 rounded-lg bg-muted/60 p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[13px] font-medium">
              {t("settings.budget.thisMonth", { month: budget.month })}
            </p>
            <p className="tabular text-sm font-semibold">
              {fmtUsd(budget.spentUsd)}{" "}
              <span className="font-normal text-muted-foreground">
                / {fmtUsd(budget.monthlyUsd)}
              </span>
            </p>
          </div>
          <Progress
            label={t("settings.budget.title")}
            value={budget.pct}
            tone={
              budget.level === "blocked"
                ? "danger"
                : budget.level === "warning"
                  ? "warning"
                  : "primary"
            }
          />
          {budget.level !== "ok" && (
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-[#6b5200]">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              {budget.level === "blocked"
                ? t("settings.budget.blocked")
                : t("settings.budget.warning")}
            </p>
          )}
          {budget.bySku.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-1 font-medium">
                      {t("settings.budget.sku")}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {t("settings.budget.calls")}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {t("settings.budget.cost")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {budget.bySku.map((r) => (
                    <tr key={r.sku} className="border-t">
                      <td className="py-1.5">{skuLabel(r.sku)}</td>
                      <td className="tabular py-1.5 text-right">{fmtNumber(r.calls)}</td>
                      <td className="tabular py-1.5 text-right">{fmtUsd(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{t("settings.budget.none")}</p>
          )}
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {t("settings.budget.disclaimer", { date: PRICING_VERIFIED_AT })}{" "}
        {t("settings.budget.quotaTip")}
      </p>
    </Section>
  );
}

/* ----------------------------- Hedef pazarlar ----------------------------- */

function MarketsSection() {
  const { data } = useSettings();
  const { data: countries } = useCountries();
  const save = useSave();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  useEffect(() => setSelected(data?.settings["targets.countries"] ?? []), [data?.settings]);
  const list = useMemo(
    () =>
      (countries?.countries ?? []).filter(
        (c) =>
          c.name.toLowerCase().includes(filter.toLowerCase()) ||
          c.code.toLowerCase() === filter.toLowerCase(),
      ),
    [countries, filter],
  );
  const dirty =
    !!data &&
    JSON.stringify([...selected].sort()) !==
      JSON.stringify([...(data?.settings["targets.countries"] ?? [])].sort());

  return (
    <Section title={t("settings.markets.title")} description={t("settings.markets.desc")}>
      <div className="flex flex-wrap items-center gap-2">
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
      <ul className="um-scroll grid max-h-72 grid-cols-2 gap-x-4 sm:grid-cols-3">
        {list.map((c) => (
          <li key={c.code}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent/60">
              <Checkbox
                checked={selected.includes(c.code)}
                onCheckedChange={(v) =>
                  setSelected(
                    v === true ? [...selected, c.code] : selected.filter((x) => x !== c.code),
                  )
                }
              />
              {c.name}
              {c.code === "TR" && <Badge variant="outline">{t("settings.markets.trNote")}</Badge>}
            </label>
          </li>
        ))}
      </ul>
      {countries && list.length === 0 && (
        <p className="text-[13px] text-muted-foreground">{t("settings.markets.empty")}</p>
      )}
      {selected.length === 0 && <FieldError>{t("settings.markets.none")}</FieldError>}
      <p className="text-[12px] text-muted-foreground">{t("settings.markets.note")}</p>
      <SaveBar
        type="button"
        dirty={dirty}
        valid={selected.length > 0}
        pending={save.isPending}
        onSave={() => save.mutate({ "targets.countries": selected })}
      />
    </Section>
  );
}

/* ------------------------------ Firma profili ------------------------------ */

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

function CompanySection() {
  const { data } = useSettings();
  const save = useSave();
  const [form, setForm] = useState<CompanyProfile>(EMPTY_COMPANY);
  useEffect(
    () => setForm({ ...EMPTY_COMPANY, ...(data?.settings["company.profile"] ?? {}) }),
    [data?.settings],
  );
  const [touched, setTouched] = useState<Set<keyof CompanyProfile>>(new Set());
  const set = (k: keyof CompanyProfile, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const rules: [keyof CompanyProfile, number][] = [
    ["legalName", 2],
    ["address", 5],
    ["taxId", 2],
    ["phone", 5],
    ["contactName", 2],
  ];
  const errors: Partial<Record<keyof CompanyProfile, string>> = {};
  for (const [k, min] of rules) {
    if (!touched.has(k)) continue;
    const len = (form[k] ?? "").trim().length;
    if (len === 0) errors[k] = t("settings.field.required");
    else if (len < min) errors[k] = t("settings.field.short");
  }
  const payload = {
    "company.profile": {
      ...form,
      contactTitle: form.contactTitle || undefined,
      website: form.website || undefined,
      mersisNo: form.mersisNo?.trim() || undefined,
      tradeRegistryNo: form.tradeRegistryNo?.trim() || undefined,
    },
  };
  const saved = { ...EMPTY_COMPANY, ...(data?.settings["company.profile"] ?? {}) };
  const dirty = !!data && JSON.stringify(form) !== JSON.stringify(saved);
  const valid =
    form.legalName.trim().length >= 2 &&
    form.address.trim().length >= 5 &&
    form.taxId.trim().length >= 2 &&
    form.phone.trim().length >= 5 &&
    form.contactName.trim().length >= 2;

  return (
    <Section title={t("settings.company.title")} description={t("settings.company.desc")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty) save.mutate(payload);
        }}
      >
        <CompanyFields
          form={form}
          set={set}
          errors={errors}
          onFieldBlur={(k) => setTouched((s) => new Set(s).add(k))}
        />
        <SaveBar dirty={dirty} valid={valid} pending={save.isPending} />
      </form>
    </Section>
  );
}

export function CompanyFields({
  form,
  set,
  errors = {},
  onFieldBlur,
}: {
  form: CompanyProfile;
  set: (k: keyof CompanyProfile, v: string) => void;
  errors?: Partial<Record<keyof CompanyProfile, string>>;
  onFieldBlur?: (k: keyof CompanyProfile) => void;
}) {
  const field = (
    k: keyof CompanyProfile,
    label: string,
    props: { placeholder?: string; autoComplete?: string } = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`c-${k}`}>{label}</Label>
      <Input
        id={`c-${k}`}
        value={form[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        onBlur={() => onFieldBlur?.(k)}
        aria-invalid={errors[k] ? true : undefined}
        aria-describedby={errors[k] ? `c-${k}-err` : undefined}
        {...props}
      />
      {errors[k] && <FieldError id={`c-${k}-err`}>{errors[k]}</FieldError>}
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        {field("legalName", t("company.legalName"), { autoComplete: "organization" })}
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="c-address">{t("company.address")}</Label>
        <Textarea
          id="c-address"
          value={form.address}
          onChange={(e) => set("address", e.target.value)}
          onBlur={() => onFieldBlur?.("address")}
          aria-invalid={errors.address ? true : undefined}
          aria-describedby={errors.address ? "c-address-err" : undefined}
          className="min-h-16"
          autoComplete="street-address"
        />
        {errors.address && <FieldError id="c-address-err">{errors.address}</FieldError>}
      </div>
      {field("taxId", t("company.taxId"))}
      {field("phone", t("company.phone"), { autoComplete: "tel" })}
      {field("contactName", t("company.contactName"), { autoComplete: "name" })}
      {field("contactTitle", t("company.contactTitle"))}
      <div className="sm:col-span-2">
        {field("website", t("company.website"), { placeholder: "https://" })}
      </div>
      {field("mersisNo", t("company.mersisNo"))}
      {field("tradeRegistryNo", t("company.tradeRegistryNo"))}
      <p className="text-[12px] text-muted-foreground sm:col-span-2">{t("company.trHint")}</p>
    </div>
  );
}

/* ------------------------------- E-posta bulma ------------------------------- */

function EmailSection() {
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
  if (!data) return <Skeleton className="h-48" />;
  const ext = data.settings["enrichment.external"];
  return (
    <Section title={t("settings.email.title")} description={t("settings.email.desc")}>
      <div className="space-y-1.5">
        <Label htmlFor="email-concurrency">{t("settings.email.concurrency")}</Label>
        <Select
          id="email-concurrency"
          value={String(data.settings["enrichment.concurrency"])}
          onChange={(e) => save.mutate({ "enrichment.concurrency": Number(e.target.value) })}
          disabled={save.isPending}
          className="w-28"
        >
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <p className="text-[12px] text-muted-foreground">{t("settings.email.concurrency.help")}</p>
      </div>

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
    </Section>
  );
}

/* ------------------------------ Yenilik eşikleri ------------------------------ */

function NoveltySection() {
  const { data } = useSettings();
  const save = useSave();
  const [v, setV] = useState({ highAt: 60, likelyAt: 30, newWindowDays: 60 });
  useEffect(() => data && setV(data.settings["novelty.thresholds"]), [data]);
  const valid =
    v.likelyAt < v.highAt &&
    v.highAt <= 100 &&
    v.likelyAt >= 1 &&
    v.newWindowDays >= 1 &&
    v.newWindowDays <= 365;
  const saved = data?.settings["novelty.thresholds"];
  const dirty = !!saved && JSON.stringify(v) !== JSON.stringify(saved);
  const num = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: Number(e.target.value) });
  return (
    <Section
      title={t("settings.novelty.title")}
      description={t("settings.novelty.desc")}
      help="help.noveltyThresholds"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty) save.mutate({ "novelty.thresholds": v });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="n-high">{t("settings.novelty.high")}</Label>
            <Input
              id="n-high"
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : "novelty-err"}
              type="number"
              min={2}
              max={100}
              value={v.highAt}
              onChange={num("highAt")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="n-likely">{t("settings.novelty.likely")}</Label>
            <Input
              id="n-likely"
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : "novelty-err"}
              type="number"
              min={1}
              max={99}
              value={v.likelyAt}
              onChange={num("likelyAt")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="n-window">{t("settings.novelty.window")}</Label>
            <Input
              id="n-window"
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : "novelty-err"}
              type="number"
              min={1}
              max={30}
              value={v.newWindowDays}
              onChange={num("newWindowDays")}
            />
          </div>
        </div>
        {!valid && <FieldError id="novelty-err">{t("settings.novelty.invalid")}</FieldError>}
        <SaveBar dirty={dirty} valid={valid} pending={save.isPending} />
      </form>
    </Section>
  );
}

/* ------------------------------- Kategoriler ------------------------------- */

type ChipKind = "placeTypes" | "keywords";

function CategoryEditor({ c }: { c: Category }) {
  const invalidate = useInvalidateAll();
  const [type, setType] = useState("");
  const [kw, setKw] = useState("");
  const [pendingChip, setPendingChip] = useState<{ kind: ChipKind; tag: string } | null>(null);
  const patch = useMutation({
    mutationFn: (p: Partial<Pick<Category, "enabled" | "keywords" | "placeTypes">>) =>
      api(`/api/categories/${c.id}`, { method: "PATCH", json: p }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(errorText(e)),
  });
  /** Hazır kategoride onay ister; özel kategoride hemen kaldırır ve "Geri al" sunar. */
  const removeChip = async (kind: ChipKind, tag: string) => {
    const before = c[kind];
    await patch.mutateAsync({ [kind]: before.filter((y) => y !== tag) });
    toast(t("settings.chip.removed", { tag }), {
      action: {
        label: t("settings.chip.undo"),
        onClick: () => {
          api(`/api/categories/${c.id}`, { method: "PATCH", json: { [kind]: before } })
            .then(invalidate)
            .catch((e: Error) => toast.error(errorText(e)));
        },
      },
    });
  };
  const askRemove = (kind: ChipKind, tag: string) => {
    if (c.builtIn) setPendingChip({ kind, tag });
    else void removeChip(kind, tag).catch(() => undefined);
  };
  return (
    <li
      className={`space-y-2 rounded-lg border p-3 transition-opacity duration-150 ${c.enabled ? "" : "opacity-75"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={c.enabled}
            onCheckedChange={(v) => patch.mutate({ enabled: v })}
            aria-label={c.name}
          />
          {c.name}
        </label>
        <Badge variant="outline">
          {t("settings.categories.queries", { n: c.placeTypes.length + c.keywords.length })}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {c.placeTypes.map((x) => (
          <Badge key={x} variant="default" className="gap-1 pr-1 font-mono text-[11px]">
            {x}
            <button
              type="button"
              aria-label={t("detail.removeTag", { tag: x })}
              onClick={() => askRemove("placeTypes", x)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {c.keywords.map((x) => (
          <Badge key={x} variant="info" className="gap-1 pr-1">
            “{x}”
            <button
              type="button"
              aria-label={t("detail.removeTag", { tag: x })}
              onClick={() => askRemove("keywords", x)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = type.trim().toLowerCase();
            if (v && !c.placeTypes.includes(v)) patch.mutate({ placeTypes: [...c.placeTypes, v] });
            setType("");
          }}
        >
          <Input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder={t("settings.categories.addType")}
            aria-label={t("settings.categories.addType")}
            className="h-8 font-mono text-[12px]"
          />
          <Button type="submit" size="icon" variant="outline" aria-label={t("common.add")}>
            <Plus />
          </Button>
        </form>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = kw.trim();
            if (v && !c.keywords.includes(v)) patch.mutate({ keywords: [...c.keywords, v] });
            setKw("");
          }}
        >
          <Input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder={t("settings.categories.addKeyword")}
            aria-label={t("settings.categories.addKeyword")}
            className="h-8 text-[13px]"
          />
          <Button type="submit" size="icon" variant="outline" aria-label={t("common.add")}>
            <Plus />
          </Button>
        </form>
      </div>
      <ConfirmDialog
        open={pendingChip !== null}
        onOpenChange={(o) => !o && setPendingChip(null)}
        tone="danger"
        title={t("settings.chip.builtin.title", { tag: pendingChip?.tag ?? "" })}
        description={t("settings.chip.builtin.body")}
        confirmLabel={t("settings.chip.remove")}
        onConfirm={async () => {
          if (pendingChip) await removeChip(pendingChip.kind, pendingChip.tag);
        }}
      />
    </li>
  );
}

function CategoriesSection() {
  const { data } = useCategories();
  return (
    <Section title={t("settings.categories.title")} description={t("settings.categories.desc")}>
      {!data ? (
        <Skeleton className="h-32" />
      ) : (
        <ul className="space-y-2">
          {data.map((c) => (
            <CategoryEditor key={c.id} c={c} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ---------------------------- Veri ve hakkında ---------------------------- */

function GoogleDataBox() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["google-data"],
    queryFn: () => api<GoogleDataSummary>("/api/google-data"),
  });
  const clear = useMutation({
    mutationFn: () => api("/api/google-data", { method: "DELETE" }),
    onSuccess: () => {
      for (const key of ["google-data", "lead", "leads", "points", "facets"])
        void qc.invalidateQueries({ queryKey: [key] });
      toast.success(t("settings.data.google.cleared"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-[13px] font-medium">{t("settings.data.google.title")}</p>
      <p className="text-[12px] text-muted-foreground">
        {data
          ? t("settings.data.google.summary", {
              cached: fmtNumber(data.cachedPlaces),
              coords: fmtNumber(data.storedCoordinates),
            })
          : t("common.loading")}
      </p>
      <Button variant="dangerOutline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 /> {t("settings.data.google.clear")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        title={t("settings.data.google.confirmTitle")}
        description={t("settings.data.google.confirm")}
        confirmLabel={t("settings.data.google.clear")}
        onConfirm={async () => {
          await clear.mutateAsync();
        }}
      />
    </div>
  );
}

function DataSection() {
  const { data } = useSettings();
  const save = useSave();
  const [days, setDays] = useState(30);
  useEffect(() => data && setDays(data.settings["google.cacheDays"]), [data]);
  if (!data) return <Skeleton className="h-40" />;
  const consent = data.settings.consent;
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 30;
  const daysDirty = days !== data.settings["google.cacheDays"];
  return (
    <Section title={t("settings.data.title")} description={t("settings.data.desc")}>
      <dl className="space-y-1.5 text-[13px]">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t("settings.data.folder")}</dt>
          <dd className="break-all text-right font-mono text-[12px]">{data.app.dataDir}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t("settings.data.version")}</dt>
          <dd>{data.app.version}</dd>
        </div>
        {consent && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("settings.data.consent")}</dt>
            <dd className="text-right">
              {consent.name}
              {consent.title ? `, ${consent.title}` : ""} · {fmtDateTime(consent.acceptedAt)} · v
              {consent.version}
            </dd>
          </div>
        )}
      </dl>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (daysValid && daysDirty) save.mutate({ "google.cacheDays": days });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="cache-days" className="flex items-center gap-1">
            {t("settings.data.cacheDays")}
          </Label>
          <Input
            id="cache-days"
            type="number"
            min={1}
            max={30}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-28"
            aria-invalid={!daysValid}
            aria-describedby={daysValid ? undefined : "cache-days-err"}
          />
          {!daysValid && <FieldError id="cache-days-err">{t("settings.cache.invalid")}</FieldError>}
        </div>
        <SaveBar dirty={daysDirty} valid={daysValid} pending={save.isPending} />
      </form>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {t("settings.data.googleNote")}
      </p>
      <GoogleDataBox />
      <details className="rounded-lg bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          {t("settings.about.title")}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>{t("settings.about.geonames")}</li>
          <li>{t("settings.about.google")}</li>
          <li>{t("settings.about.local")}</li>
        </ul>
      </details>
    </Section>
  );
}

const SECTIONS = [
  { id: "appearance", key: "settings.nav.appearance" },
  { id: "google", key: "settings.nav.google" },
  { id: "budget", key: "settings.nav.budget" },
  { id: "markets", key: "settings.nav.markets" },
  { id: "company", key: "settings.nav.company" },
  { id: "categories", key: "settings.nav.categories" },
  { id: "email", key: "settings.nav.email" },
  { id: "mailbox", key: "settings.nav.mailbox" },
  { id: "unsubscribe", key: "settings.nav.unsubscribe" },
  { id: "data", key: "settings.nav.data" },
  { id: "novelty", key: "settings.nav.novelty" },
] as const;

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Görünen bölümü izler; gezinmede geçerli konum her zaman belli olsun. */
function useActiveSection() {
  const [active, setActive] = useState<string>(SECTION_IDS[0]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return [active, setActive] as const;
}

function SectionNav({
  active,
  onGo,
  variant,
}: {
  active: string;
  onGo: (id: string) => void;
  variant: "side" | "top";
}) {
  const side = variant === "side";
  return (
    <nav
      aria-label={t("settings.nav.label")}
      className={
        side
          ? "sticky top-6 hidden h-fit w-44 shrink-0 space-y-0.5 lg:block"
          : "um-scroll sticky top-0 z-10 -mx-4 mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden"
      }
    >
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? "location" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onGo(s.id);
          }}
          className={`${side ? "block" : "shrink-0"} whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 ${active === s.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
        >
          {t(s.key)}
        </a>
      ))}
    </nav>
  );
}

export function SettingsPage() {
  const { data, isError, refetch, isFetching } = useSettings();
  const [active, setActive] = useActiveSection();
  const [advOpen, setAdvOpen] = useState(false);

  const go = (id: string) => {
    if (id === "novelty") setAdvOpen(true);
    setActive(id);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      try {
        history.replaceState(null, "", `#${id}`);
      } catch {
        /* adres çubuğu güncellenemese de gezinme çalışır */
      }
    });
  };

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && SECTION_IDS.some((s) => s === id)) {
      if (id === "novelty") setAdvOpen(true);
      const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 120);
      return () => window.clearTimeout(timer);
    }
  }, []);

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto flex max-w-5xl gap-8 p-4 sm:p-6">
        <SectionNav active={active} onGo={go} variant="side" />
        <div className="min-w-0 flex-1">
          <SectionNav active={active} onGo={go} variant="top" />
          <div className="space-y-5">
            <PageHeader title={t("settings.title")} description={t("settings.subtitle")} />
            {isError && !data ? (
              <Card>
                <EmptyState
                  icon={CircleAlert}
                  title={t("common.error")}
                  body={t("settings.loadError")}
                  action={
                    <Button variant="outline" loading={isFetching} onClick={() => void refetch()}>
                      {!isFetching && <RefreshCw />} {t("scans.refresh")}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <>
                <div id="appearance" className="scroll-mt-16 lg:scroll-mt-6">
                  <AppearanceSection />
                </div>
                <div id="google" className="scroll-mt-16 lg:scroll-mt-6">
                  <GoogleSection />
                </div>
                <div id="budget" className="scroll-mt-16 lg:scroll-mt-6">
                  <BudgetSection />
                </div>
                <div id="markets" className="scroll-mt-16 lg:scroll-mt-6">
                  <MarketsSection />
                </div>
                <div id="company" className="scroll-mt-16 lg:scroll-mt-6">
                  <CompanySection />
                </div>
                <div id="categories" className="scroll-mt-16 lg:scroll-mt-6">
                  <CategoriesSection />
                </div>
                <div id="email" className="scroll-mt-16 lg:scroll-mt-6">
                  <EmailSection />
                </div>
                <div id="mailbox" className="scroll-mt-16 lg:scroll-mt-6">
                  <MailboxSettingsSection />
                </div>
                <div id="unsubscribe" className="scroll-mt-16 lg:scroll-mt-6">
                  <UnsubscribeSettingsSection />
                </div>
                <div id="data" className="scroll-mt-16 lg:scroll-mt-6">
                  <DataSection />
                </div>
                <details
                  className="group space-y-3"
                  open={advOpen}
                  onToggle={(e) => setAdvOpen(e.currentTarget.open)}
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl border bg-card px-4 text-sm font-semibold shadow-xs transition-colors duration-150 hover:bg-accent/50">
                    <span>
                      {t("settings.advanced")}
                      <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                        {t("settings.advanced.hint")}
                      </span>
                    </span>
                    <ChevronDown
                      className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <div id="novelty" className="scroll-mt-16 lg:scroll-mt-6">
                    <NoveltySection />
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
