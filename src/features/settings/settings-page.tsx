"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  FlaskConical,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/client/api";
import { fmtDateTime, fmtNumber, fmtUsd } from "@/lib/client/format";
import { qk, useBudget, useCategories, useCountries, useSettings } from "@/lib/client/queries";
import type { Category, CompanyProfile, SecretInfo } from "@/lib/client/types";
import { skuLabel, PRICING_VERIFIED_AT } from "@/lib/places/pricing";
import { t } from "@/lib/i18n";

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
    onError: (e: Error) => toast.error(e.message),
  });
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 pt-3">{children}</CardContent>
    </Card>
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
  name: "google.placesKey" | "google.mapsKey";
  label: string;
  help: string;
  info: SecretInfo;
  testable?: boolean;
}) {
  const invalidate = useInvalidateAll();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const save = useMutation({
    mutationFn: () => api("/api/secrets", { method: "POST", json: { name, value } }),
    onSuccess: () => {
      setValue("");
      setResult(null);
      invalidate();
      toast.success(t("settings.key.saved"));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/secrets?name=${name}`, { method: "DELETE" }),
    onSuccess: () => {
      setResult(null);
      invalidate();
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>("/api/setup/test-places", { method: "POST" }),
    onSuccess: setResult,
    onError: (e: Error) => setResult({ ok: false, message: e.message }),
  });

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={name} className="flex items-center gap-1.5">
          <KeyRound className="size-3.5" /> {label}
        </Label>
        {info.set ? (
          <Badge variant="high">
            {t("settings.key.set")} · {info.masked}
            {info.source === "env" ? ` · ${t("settings.key.fromEnv")}` : ""}
          </Badge>
        ) : (
          <Badge variant="warning">{t("settings.key.missing")}</Badge>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">{help}</p>
      <div className="flex gap-2">
        <Input
          id={name}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={info.set ? t("settings.key.replace") : t("settings.key.paste")}
        />
        <Button onClick={() => save.mutate()} disabled={value.trim().length < 8 || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null} {t("common.save")}
        </Button>
        {info.set && info.source === "store" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.delete")}
            onClick={() => remove.mutate()}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {testable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            disabled={!info.set || test.isPending}
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}{" "}
            {t("settings.key.test")}
          </Button>
          {result && (
            <p
              className={`flex items-start gap-1.5 text-[13px] ${result.ok ? "text-primary" : "text-destructive"}`}
              role="status"
            >
              {result.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              )}{" "}
              {result.message}
            </p>
          )}
        </div>
      )}
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

  return (
    <Section id="google" title={t("settings.google.title")} description={t("settings.google.desc")}>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("settings.provider")}>
        {(["google", "mock"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            onClick={() => save.mutate({ "places.provider": p })}
            className={`rounded-lg border p-3 text-left transition-colors ${provider === p ? "border-primary bg-accent" : "hover:bg-accent/50"}`}
          >
            <p className="text-sm font-semibold">{t(`settings.provider.${p}`)}</p>
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
      <div className="space-y-1.5">
        <Label htmlFor="mapId">{t("settings.mapId")}</Label>
        <div className="flex gap-2">
          <Input
            id="mapId"
            value={mapId}
            onChange={(e) => setMapId(e.target.value)}
            placeholder="DEMO_MAP_ID"
            spellCheck={false}
          />
          <Button variant="outline" onClick={() => save.mutate({ "maps.mapId": mapId.trim() })}>
            {t("common.save")}
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">{t("settings.mapId.help")}</p>
      </div>
    </Section>
  );
}

function DemoTools({ epoch }: { epoch: number }) {
  const invalidate = useInvalidateAll();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
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
      setConfirm(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-nov-future/50 bg-nov-future/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-nov-future">
        <FlaskConical className="size-4" /> {t("settings.demo.title")}
      </p>
      <p className="text-[13px] text-muted-foreground">{t("settings.demo.body")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => act.mutate("advance")}
          disabled={act.isPending}
        >
          {t("settings.demo.advance")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => act.mutate("reset")}
          disabled={act.isPending || epoch === 0}
        >
          {t("settings.demo.reset")}
        </Button>
        <span className="tabular text-[12px] text-muted-foreground">
          {t("settings.demo.current", { n: epoch })}
        </span>
        <Button
          size="sm"
          variant="destructive"
          className="ml-auto"
          onClick={() => setConfirm(true)}
        >
          <Trash2 /> {t("settings.demo.purge")}
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.demo.purge.title")}</DialogTitle>
            <DialogDescription>{t("settings.demo.purge.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => act.mutate("purge")}
              disabled={act.isPending}
            >
              {t("settings.demo.purge.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const valid = Number.isFinite(num) && num >= 0 && num <= 100000;

  return (
    <Section id="budget" title={t("settings.budget.title")} description={t("settings.budget.desc")}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="budget">{t("settings.budget.monthly")}</Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              id="budget"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-28"
              aria-invalid={!valid}
            />
          </div>
        </div>
        <Button
          onClick={() => save.mutate({ "budget.monthlyUsd": num })}
          disabled={!valid || save.isPending}
        >
          {t("common.save")}
        </Button>
      </div>
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
            <p className="text-[13px] font-medium text-[#6b5200]">
              {budget.level === "blocked"
                ? t("settings.budget.blocked")
                : t("settings.budget.warning")}
            </p>
          )}
          {budget.bySku.length > 0 ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 font-medium">{t("settings.budget.sku")}</th>
                  <th className="py-1 text-right font-medium">{t("settings.budget.calls")}</th>
                  <th className="py-1 text-right font-medium">{t("settings.budget.cost")}</th>
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
    JSON.stringify([...selected].sort()) !==
    JSON.stringify([...(data?.settings["targets.countries"] ?? [])].sort());

  return (
    <Section
      id="markets"
      title={t("settings.markets.title")}
      description={t("settings.markets.desc")}
    >
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
        <Button
          className="ml-auto"
          onClick={() => save.mutate({ "targets.countries": selected })}
          disabled={!dirty || selected.length === 0 || save.isPending}
        >
          {t("common.save")}
        </Button>
      </div>
      <ul className="grid max-h-72 grid-cols-2 gap-x-4 overflow-y-auto sm:grid-cols-3">
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
      <p className="text-[12px] text-muted-foreground">{t("settings.markets.note")}</p>
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
};

function CompanySection() {
  const { data } = useSettings();
  const save = useSave();
  const [form, setForm] = useState<CompanyProfile>(EMPTY_COMPANY);
  useEffect(
    () => setForm({ ...EMPTY_COMPANY, ...(data?.settings["company.profile"] ?? {}) }),
    [data?.settings],
  );
  const set = (k: keyof CompanyProfile, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid =
    form.legalName.trim().length >= 2 &&
    form.address.trim().length >= 5 &&
    form.taxId.trim().length >= 2 &&
    form.phone.trim().length >= 5 &&
    form.contactName.trim().length >= 2;

  return (
    <Section
      id="company"
      title={t("settings.company.title")}
      description={t("settings.company.desc")}
    >
      <CompanyFields form={form} set={set} />
      <Button
        onClick={() =>
          save.mutate({
            "company.profile": {
              ...form,
              contactTitle: form.contactTitle || undefined,
              website: form.website || undefined,
            },
          })
        }
        disabled={!valid || save.isPending}
      >
        {t("common.save")}
      </Button>
    </Section>
  );
}

export function CompanyFields({
  form,
  set,
}: {
  form: CompanyProfile;
  set: (k: keyof CompanyProfile, v: string) => void;
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
        {...props}
      />
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
          className="min-h-16"
          autoComplete="street-address"
        />
      </div>
      {field("taxId", t("company.taxId"))}
      {field("phone", t("company.phone"), { autoComplete: "tel" })}
      {field("contactName", t("company.contactName"), { autoComplete: "name" })}
      {field("contactTitle", t("company.contactTitle"))}
      <div className="sm:col-span-2">
        {field("website", t("company.website"), { placeholder: "https://" })}
      </div>
    </div>
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
  const num = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: Number(e.target.value) });
  return (
    <Section
      id="novelty"
      title={t("settings.novelty.title")}
      description={t("settings.novelty.desc")}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="n-high">{t("settings.novelty.high")}</Label>
          <Input
            id="n-high"
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
            type="number"
            min={1}
            max={365}
            value={v.newWindowDays}
            onChange={num("newWindowDays")}
          />
        </div>
      </div>
      {!valid && <p className="text-[13px] text-destructive">{t("settings.novelty.invalid")}</p>}
      <Button
        onClick={() => save.mutate({ "novelty.thresholds": v })}
        disabled={!valid || save.isPending}
      >
        {t("common.save")}
      </Button>
    </Section>
  );
}

/* ------------------------------- Kategoriler ------------------------------- */

function CategoryEditor({ c }: { c: Category }) {
  const invalidate = useInvalidateAll();
  const [type, setType] = useState("");
  const [kw, setKw] = useState("");
  const patch = useMutation({
    mutationFn: (p: Partial<Pick<Category, "enabled" | "keywords" | "placeTypes">>) =>
      api(`/api/categories/${c.id}`, { method: "PATCH", json: p }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <li className="space-y-2 rounded-lg border p-3">
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
              onClick={() => patch.mutate({ placeTypes: c.placeTypes.filter((y) => y !== x) })}
              className="rounded-full p-0.5 hover:bg-black/10"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {c.keywords.map((x) => (
          <Badge key={x} variant="primary" className="gap-1 pr-1">
            “{x}”
            <button
              type="button"
              aria-label={t("detail.removeTag", { tag: x })}
              onClick={() => patch.mutate({ keywords: c.keywords.filter((y) => y !== x) })}
              className="rounded-full p-0.5 hover:bg-white/20"
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
    </li>
  );
}

function CategoriesSection() {
  const { data } = useCategories();
  return (
    <Section
      id="categories"
      title={t("settings.categories.title")}
      description={t("settings.categories.desc")}
    >
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

function DataSection() {
  const { data } = useSettings();
  const save = useSave();
  const [days, setDays] = useState(30);
  useEffect(() => data && setDays(data.settings["google.cacheDays"]), [data]);
  if (!data) return <Skeleton className="h-40" />;
  const consent = data.settings.consent;
  return (
    <Section id="data" title={t("settings.data.title")} description={t("settings.data.desc")}>
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
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cache-days" className="flex items-center gap-1">
            {t("settings.data.cacheDays")}
          </Label>
          <Input
            id="cache-days"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-28"
          />
        </div>
        <Button variant="outline" onClick={() => save.mutate({ "google.cacheDays": days })}>
          {t("common.save")}
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {t("settings.data.googleNote")}
      </p>
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
  { id: "google", key: "settings.nav.google" },
  { id: "budget", key: "settings.nav.budget" },
  { id: "markets", key: "settings.nav.markets" },
  { id: "company", key: "settings.nav.company" },
  { id: "categories", key: "settings.nav.categories" },
  { id: "novelty", key: "settings.nav.novelty" },
  { id: "data", key: "settings.nav.data" },
] as const;

export function SettingsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl gap-8 p-6">
        <nav
          aria-label={t("settings.nav.label")}
          className="sticky top-6 hidden h-fit w-44 shrink-0 space-y-0.5 lg:block"
        >
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="block rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t(s.key)}
            </a>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("settings.title")}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">{t("settings.subtitle")}</p>
          </div>
          <GoogleSection />
          <BudgetSection />
          <MarketsSection />
          <CompanySection />
          <CategoriesSection />
          <NoveltySection />
          <DataSection />
        </div>
      </div>
    </div>
  );
}
