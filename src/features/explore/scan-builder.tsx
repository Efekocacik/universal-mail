"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Loader2,
  MapPinned,
  PenLine,
  Play,
  Search,
  Square,
  Circle as CircleIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Input, Label, Select } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/client/api";
import { countryLabel, fmtNumber, fmtUsd } from "@/lib/client/format";
import { qk, useCategories, useCitySearch, useConfig, useCountries } from "@/lib/client/queries";
import type { CityResult, ScanEstimate } from "@/lib/client/types";
import { bboxAreaKm2, bboxFromCenter } from "@/lib/geo/bbox";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useExplore, type DraftRegion } from "./state";

interface EstimateResponse {
  estimate: ScanEstimate;
  budget: { monthlyUsd: number; spentUsd: number; remainingUsd: number; level: string };
  exceedsBudget: boolean;
  country: { countryCode: string | null; blocked: boolean; message?: string };
  disclaimer: string;
}

export function ScanBuilder() {
  const ex = useExplore();
  const qc = useQueryClient();
  const { data: config } = useConfig();
  const { data: categories } = useCategories();
  const { data: countryData } = useCountries();

  const [mode, setMode] = useState<"city" | "draw">("city");
  const [country, setCountry] = useState<string>("");
  const [cityQuery, setCityQuery] = useState("");
  const [picked, setPicked] = useState<CityResult | null>(null);
  const [radiusKm, setRadiusKm] = useState(8);
  const [catIds, setCatIds] = useState<number[] | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kw, setKw] = useState("");
  const [strategy, setStrategy] = useState<"text" | "nearby">("text");
  const [enrich, setEnrich] = useState(false);
  const [ack, setAck] = useState<string | null>(null);

  const targets = config?.targetCountries ?? [];
  const searchCountries = country ? [country] : targets;
  const { data: cities, isFetching: searching } = useCitySearch(cityQuery, searchCountries);

  // Varsayılan seçili kategoriler: etkin olanlar (ilk açılışta kafe ve pub).
  const selectedCats = catIds ?? (categories ?? []).filter((c) => c.enabled).map((c) => c.id);

  const pickCity = (c: CityResult) => {
    setPicked(c);
    setCityQuery(c.name);
    setRadiusKm(c.radiusKm);
    const bbox = bboxFromCenter(c.lat, c.lng, c.radiusKm);
    ex.setDraft({
      kind: "city",
      name: c.name,
      countryCode: c.cc,
      bbox,
      cityId: c.id,
      radiusKm: c.radiusKm,
    });
    ex.requestFocus({ fit: bbox });
  };

  const changeRadius = (km: number) => {
    setRadiusKm(km);
    if (picked) {
      const bbox = bboxFromCenter(picked.lat, picked.lng, km);
      ex.setDraft({
        kind: "city",
        name: picked.name,
        countryCode: picked.cc,
        bbox,
        cityId: picked.id,
        radiusKm: km,
      });
    }
  };

  const switchMode = (m: "city" | "draw") => {
    setMode(m);
    ex.setDrawMode(null);
    if (m === "draw" && ex.draft?.kind === "city") ex.setDraft(null);
    if (m === "city" && ex.draft && ex.draft.kind !== "city") ex.setDraft(null);
  };

  // Sekmeden çıkınca çizim modunu kapat.
  useEffect(() => () => ex.setDrawMode(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = ex.draft;
  const request = useMemo(
    () =>
      draft && (selectedCats.length > 0 || keywords.length > 0)
        ? {
            region: {
              kind: draft.kind,
              name: draft.name,
              countryCode: draft.countryCode ?? null,
              bbox: draft.bbox,
              circle: draft.circle,
              cityId: draft.cityId,
            },
            categoryIds: selectedCats,
            customKeywords: keywords,
            strategy,
            fieldProfile: enrich ? "enrich" : "discovery",
          }
        : null,
    [draft, selectedCats, keywords, strategy, enrich],
  );

  const estimate = useQuery({
    queryKey: ["estimate", request],
    enabled: request !== null,
    queryFn: () => api<EstimateResponse>("/api/scans/estimate", { method: "POST", json: request }),
    retry: false,
    staleTime: 10_000,
  });

  const start = useMutation({
    mutationFn: (acknowledgeRisk: boolean) =>
      api<{ scanId: number }>("/api/scans", {
        method: "POST",
        json: { ...request, acknowledgeRisk },
      }),
    onSuccess: (res) => {
      toast.success(t("builder.started", { id: res.scanId }));
      void qc.invalidateQueries({ queryKey: qk.status });
      void qc.invalidateQueries({ queryKey: qk.scans });
      ex.setDrawMode(null);
      ex.setFilters({ scanId: res.scanId });
      ex.setTab("list");
      setAck(null);
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === "NEEDS_ACK") setAck(e.message);
      else toast.error(e.message);
    },
  });

  const toggleCat = (id: number, on: boolean) =>
    setCatIds(on ? [...selectedCats, id] : selectedCats.filter((x) => x !== id));
  const addKeyword = () => {
    const v = kw.trim();
    if (v && !keywords.includes(v) && keywords.length < 10) setKeywords([...keywords, v]);
    setKw("");
  };

  const areaKm2 = draft ? bboxAreaKm2(draft.bbox) : 0;
  const est = estimate.data;
  const planError = estimate.error instanceof ApiError ? estimate.error.message : null;
  const canStart = !!request && !!est && !est.country.blocked && !planError && !start.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-5 p-4">
        <div>
          <h2 className="text-base font-semibold">{t("builder.title")}</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t("builder.subtitle")}</p>
        </div>

        {/* 1. Bölge */}
        <section className="space-y-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("builder.region")}
          </h3>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(["city", "draw"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={cn(
                  "flex h-8 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors",
                  mode === m ? "bg-card shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "city" ? <MapPinned className="size-4" /> : <PenLine className="size-4" />}
                {t(`builder.mode.${m}`)}
              </button>
            ))}
          </div>

          {mode === "city" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="b-country">{t("builder.country")}</Label>
                  <Select
                    id="b-country"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  >
                    <option value="">{t("builder.allTargets")}</option>
                    {(countryData?.countries ?? [])
                      .filter((c) => targets.length === 0 || targets.includes(c.code))
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                  </Select>
                </div>
                <div className="relative space-y-1.5">
                  <Label htmlFor="b-city">{t("builder.city")}</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="b-city"
                      value={cityQuery}
                      onChange={(e) => {
                        setCityQuery(e.target.value);
                        setPicked(null);
                      }}
                      placeholder={t("builder.cityPlaceholder")}
                      className="pl-8"
                      autoComplete="off"
                      role="combobox"
                      aria-expanded={!!cities?.length && !picked}
                    />
                    {searching && (
                      <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {cities && cities.length > 0 && !picked && (
                    <ul
                      role="listbox"
                      className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
                    >
                      {cities.map((c) => (
                        <li key={c.id} role="option" aria-selected={false}>
                          <button
                            type="button"
                            onClick={() => pickCity(c)}
                            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                          >
                            <span className="truncate font-medium">{c.name}</span>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {countryLabel(c.cc)} · {fmtNumber(c.pop)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {cityQuery.trim().length >= 2 &&
                    !searching &&
                    cities?.length === 0 &&
                    !picked && (
                      <p className="text-[12px] text-muted-foreground">{t("builder.noCity")}</p>
                    )}
                </div>
              </div>
              {picked && (
                <div className="space-y-2 rounded-lg bg-muted/60 p-3">
                  <div className="flex items-center justify-between text-[13px]">
                    <Label htmlFor="b-radius" className="flex items-center gap-1">
                      {t("builder.radius")} <HelpTip>{t("builder.radius.help")}</HelpTip>
                    </Label>
                    <span className="tabular font-medium">{radiusKm} km</span>
                  </div>
                  <Slider
                    id="b-radius"
                    min={1}
                    max={50}
                    step={0.5}
                    value={[radiusKm]}
                    onValueChange={([v]) => changeRadius(v!)}
                    aria-label={t("builder.radius")}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={ex.drawMode === "rect" ? "default" : "outline"}
                  size="sm"
                  onClick={() => ex.setDrawMode(ex.drawMode === "rect" ? null : "rect")}
                >
                  <Square /> {t("builder.draw.rect")}
                </Button>
                <Button
                  variant={ex.drawMode === "circle" ? "default" : "outline"}
                  size="sm"
                  onClick={() => ex.setDrawMode(ex.drawMode === "circle" ? null : "circle")}
                >
                  <CircleIcon /> {t("builder.draw.circle")}
                </Button>
              </div>
              {draft && draft.kind !== "city" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="b-name">{t("builder.draw.name")}</Label>
                  <Input
                    id="b-name"
                    value={draft.name}
                    maxLength={120}
                    onChange={(e) => ex.setDraft({ ...draft, name: e.target.value } as DraftRegion)}
                  />
                  <p className="text-[12px] text-muted-foreground">{t("builder.draw.edit")}</p>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed p-3 text-[13px] text-muted-foreground">
                  {t("builder.draw.hint")}
                </p>
              )}
            </div>
          )}

          {draft && (
            <p className="tabular text-[12px] text-muted-foreground">
              {draft.name} · {fmtNumber(Math.round(areaKm2))} km²
            </p>
          )}
        </section>

        {/* 2. Kategoriler */}
        <section className="space-y-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("builder.categories")}
          </h3>
          <ul className="space-y-0.5">
            {(categories ?? []).map((c) => {
              const on = selectedCats.includes(c.id);
              return (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent/60">
                    <Checkbox checked={on} onCheckedChange={(v) => toggleCat(c.id, v === true)} />
                    <span className="flex-1">{c.name}</span>
                    <span className="tabular text-[12px] text-muted-foreground">
                      {c.placeTypes.length + c.keywords.length} {t("builder.queries")}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="space-y-1.5 pt-1">
            <Label htmlFor="b-kw" className="flex items-center gap-1">
              {t("builder.keywords")} <HelpTip>{t("builder.keywords.help")}</HelpTip>
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((k) => (
                <Badge key={k} variant="default" className="gap-1 pr-1">
                  {k}
                  <button
                    type="button"
                    aria-label={t("detail.removeTag", { tag: k })}
                    onClick={() => setKeywords(keywords.filter((x) => x !== k))}
                    className="rounded-full p-0.5 hover:bg-black/10"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <Input
              id="b-kw"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              placeholder={t("builder.keywordsPlaceholder")}
              maxLength={60}
            />
          </div>
        </section>

        {/* 3. Gelişmiş */}
        <details className="group rounded-lg border bg-card">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-[13px] font-medium">
            {t("builder.advanced")}
          </summary>
          <div className="space-y-4 border-t p-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-strategy" className="flex items-center gap-1">
                {t("builder.strategy")} <HelpTip>{t("builder.strategy.help")}</HelpTip>
              </Label>
              <Select
                id="b-strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as typeof strategy)}
              >
                <option value="text">{t("builder.strategy.text")}</option>
                <option value="nearby">{t("builder.strategy.nearby")}</option>
              </Select>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Label htmlFor="b-enrich" className="flex items-center gap-1">
                  {t("builder.enrich")} <HelpTip>{t("builder.enrich.help")}</HelpTip>
                </Label>
                <p className="mt-1 text-[12px] text-muted-foreground">{t("builder.enrich.note")}</p>
              </div>
              <Switch id="b-enrich" checked={enrich} onCheckedChange={setEnrich} />
            </div>
          </div>
        </details>

        {/* 4. Tahmin */}
        <section aria-live="polite" className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            {t("builder.estimate")} <HelpTip>{t("builder.estimate.help")}</HelpTip>
          </h3>
          {!request && (
            <p className="text-[13px] text-muted-foreground">{t("builder.estimate.empty")}</p>
          )}
          {request && estimate.isLoading && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("common.loading")}
            </p>
          )}
          {planError && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {planError}
            </p>
          )}
          {est && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[12px] text-muted-foreground">{t("builder.estimate.calls")}</p>
                  <p className="tabular text-xl font-semibold">
                    ≈ {fmtNumber(est.estimate.calls.expected)}
                  </p>
                  <p className="tabular text-[12px] text-muted-foreground">
                    {fmtNumber(est.estimate.calls.low)} – {fmtNumber(est.estimate.calls.high)}
                  </p>
                </div>
                <div>
                  <p className="text-[12px] text-muted-foreground">{t("builder.estimate.cost")}</p>
                  <p className="tabular text-xl font-semibold">
                    ≈ {fmtUsd(est.estimate.costUsd.expected)}
                  </p>
                  <p className="tabular text-[12px] text-muted-foreground">
                    {t("builder.estimate.worst", { v: fmtUsd(est.estimate.costUsd.high) })}
                  </p>
                </div>
              </div>
              <dl className="space-y-1 text-[12px] text-muted-foreground">
                <div className="flex justify-between">
                  <dt>{t("builder.estimate.cells")}</dt>
                  <dd className="tabular">
                    {fmtNumber(est.estimate.cells)} {t("builder.estimate.cellsUnit")} ×{" "}
                    {est.estimate.queries} {t("builder.queries")}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>{t("builder.estimate.free")}</dt>
                  <dd className="tabular">
                    {fmtNumber(est.estimate.freeCallsLeft)} {t("builder.estimate.callsUnit")}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>{t("builder.estimate.budget")}</dt>
                  <dd className="tabular">
                    {fmtUsd(est.budget.spentUsd)} / {fmtUsd(est.budget.monthlyUsd)}
                  </dd>
                </div>
              </dl>
              <Progress
                value={
                  est.budget.monthlyUsd > 0
                    ? (est.budget.spentUsd / est.budget.monthlyUsd) * 100
                    : 0
                }
                tone={
                  est.budget.level === "ok"
                    ? "primary"
                    : est.budget.level === "warning"
                      ? "warning"
                      : "danger"
                }
              />
              {est.estimate.notes.map((n) => (
                <p key={n} className="text-[12px] text-muted-foreground">
                  • {n}
                </p>
              ))}
              {est.country.blocked && (
                <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> {est.country.message}
                </p>
              )}
              <p className="text-[11px] leading-snug text-muted-foreground">{est.disclaimer}</p>
            </>
          )}
          <Button
            className="w-full"
            size="lg"
            disabled={!canStart}
            onClick={() => start.mutate(false)}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} {t("builder.start")}
          </Button>
        </section>
      </div>

      <Dialog open={ack !== null} onOpenChange={(o) => !o && setAck(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("builder.ack.title")}</DialogTitle>
            <DialogDescription>{ack}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAck(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => start.mutate(true)}>{t("builder.ack.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
