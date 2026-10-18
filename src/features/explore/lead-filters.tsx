"use client";

import { ChevronDown, Search, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { countryLabel, fmtNumber, NOVELTY_ORDER } from "@/lib/client/format";
import { useCategories, useFacets } from "@/lib/client/queries";
import { t } from "@/lib/i18n";
import { useExplore, type UiFilters } from "./state";

interface Option {
  value: string;
  label: string;
  count?: number;
}

function FilterButton({
  label,
  active,
  summary,
  children,
}: {
  label: string;
  active: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors hover:bg-accent",
            active
              ? "border-primary/40 bg-accent text-accent-foreground"
              : "bg-card text-muted-foreground",
          )}
        >
          {label}
          {summary && <span className="max-w-24 truncate text-foreground">{summary}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-2">{children}</PopoverContent>
    </Popover>
  );
}

function MultiList({
  options,
  selected,
  onChange,
  empty,
}: {
  options: Option[];
  selected: string[];
  onChange: (v: string[]) => void;
  empty?: string;
}) {
  if (options.length === 0)
    return (
      <p className="px-2 py-3 text-[13px] text-muted-foreground">
        {empty ?? t("filters.noOptions")}
      </p>
    );
  return (
    <ul className="max-h-64 overflow-y-auto">
      {options.map((o) => {
        const checked = selected.includes(o.value);
        const id = `f-${o.value}`;
        return (
          <li key={o.value}>
            <label
              htmlFor={id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(c) =>
                  onChange(c ? [...selected, o.value] : selected.filter((x) => x !== o.value))
                }
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.count !== undefined && (
                <span className="tabular text-[12px] text-muted-foreground">
                  {fmtNumber(o.count)}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

const BUSINESS_STATUSES = [
  "OPERATIONAL",
  "FUTURE_OPENING",
  "CLOSED_TEMPORARILY",
  "CLOSED_PERMANENTLY",
] as const;
const LEAD_STATUSES = [
  "new",
  "enriched",
  "queued",
  "sent",
  "replied",
  "not_interested",
  "customer",
  "do_not_contact",
] as const;

function summaryOf(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}

export function LeadFilters() {
  const ex = useExplore();
  const { filters, setFilters } = ex;
  const facetFilters = {
    ...ex.apiFilters,
    novelty: undefined,
    status: undefined,
    businessStatus: undefined,
  };
  const { data: facets } = useFacets(facetFilters);
  const { data: categories } = useCategories();
  const [cityQuery, setCityQuery] = useState("");

  const set = <K extends keyof UiFilters>(k: K, v: UiFilters[K]) =>
    setFilters({ [k]: v } as Partial<UiFilters>);

  const cityOptions = (facets?.cities ?? [])
    .filter((c) => c.name.toLowerCase().includes(cityQuery.toLowerCase()))
    .slice(0, 60);

  return (
    <div className="space-y-2 border-b px-4 py-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder={t("filters.search")}
          aria-label={t("filters.search")}
          className="pl-8 pr-8"
        />
        {filters.q && (
          <button
            type="button"
            aria-label={t("filters.clear")}
            onClick={() => set("q", "")}
            className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterButton
          label={t("filters.novelty")}
          active={filters.novelty.length > 0}
          summary={summaryOf(filters.novelty.length)}
        >
          <MultiList
            options={NOVELTY_ORDER.map((n) => ({
              value: n,
              label: t(`novelty.${n}`),
              count: facets?.novelty[n] ?? 0,
            }))}
            selected={filters.novelty}
            onChange={(v) => set("novelty", v as UiFilters["novelty"])}
          />
        </FilterButton>

        <FilterButton
          label={t("filters.country")}
          active={filters.countries.length > 0}
          summary={summaryOf(filters.countries.length)}
        >
          <MultiList
            options={(facets?.countries ?? []).map((c) => ({
              value: c.code,
              label: countryLabel(c.code),
              count: c.count,
            }))}
            selected={filters.countries}
            onChange={(v) => setFilters({ countries: v, city: "" })}
            empty={t("filters.noData")}
          />
        </FilterButton>

        <FilterButton
          label={t("filters.city")}
          active={!!filters.city}
          summary={filters.city || undefined}
        >
          <Input
            value={cityQuery}
            onChange={(e) => setCityQuery(e.target.value)}
            placeholder={t("filters.cityPlaceholder")}
            className="mb-1 h-8"
            aria-label={t("filters.city")}
          />
          <ul className="max-h-56 overflow-y-auto">
            {filters.city && (
              <li>
                <button
                  type="button"
                  onClick={() => set("city", "")}
                  className="w-full rounded-md px-2 py-1.5 text-left text-[13px] text-primary hover:bg-accent"
                >
                  {t("filters.allCities")}
                </button>
              </li>
            )}
            {cityOptions.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => set("city", c.name)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent",
                    filters.city === c.name && "bg-accent font-medium",
                  )}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="tabular text-[12px] text-muted-foreground">
                    {fmtNumber(c.count)}
                  </span>
                </button>
              </li>
            ))}
            {cityOptions.length === 0 && (
              <li className="px-2 py-3 text-[13px] text-muted-foreground">{t("filters.noData")}</li>
            )}
          </ul>
        </FilterButton>

        <FilterButton
          label={t("filters.category")}
          active={filters.categories.length > 0}
          summary={summaryOf(filters.categories.length)}
        >
          <MultiList
            options={(categories ?? []).map((c) => ({ value: c.key, label: c.name }))}
            selected={filters.categories}
            onChange={(v) => set("categories", v)}
          />
        </FilterButton>

        <FilterButton
          label={t("filters.businessStatus")}
          active={filters.businessStatus.length > 0}
          summary={summaryOf(filters.businessStatus.length)}
        >
          <MultiList
            options={BUSINESS_STATUSES.map((s) => ({
              value: s,
              label: t(`businessStatus.${s}`),
              count: facets?.businessStatus[s] ?? 0,
            }))}
            selected={filters.businessStatus}
            onChange={(v) => set("businessStatus", v)}
          />
        </FilterButton>

        <FilterButton
          label={t("filters.leadStatus")}
          active={filters.leadStatus.length > 0}
          summary={summaryOf(filters.leadStatus.length)}
        >
          <MultiList
            options={LEAD_STATUSES.map((s) => ({
              value: s,
              label: t(`leadStatus.${s}`),
              count: facets?.leadStatus[s] ?? 0,
            }))}
            selected={filters.leadStatus}
            onChange={(v) => set("leadStatus", v as UiFilters["leadStatus"])}
          />
        </FilterButton>

        <FilterButton
          label={t("filters.more")}
          active={filters.hasWebsite !== "any" || filters.hideNotFound}
        >
          <div className="space-y-3 p-1">
            <fieldset>
              <legend className="mb-1 text-[12px] font-medium text-muted-foreground">
                {t("filters.website")}
              </legend>
              {(["any", "yes", "no"] as const).map((v) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 py-1 text-[13px]">
                  <input
                    type="radio"
                    name="hasWebsite"
                    checked={filters.hasWebsite === v}
                    onChange={() => set("hasWebsite", v)}
                    className="accent-[var(--primary)]"
                  />
                  {t(`filters.website.${v}`)}
                </label>
              ))}
            </fieldset>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="hide-nf" className="text-[13px] font-normal">
                {t("filters.hideNotFound")}
              </Label>
              <Switch
                id="hide-nf"
                checked={filters.hideNotFound}
                onCheckedChange={(v) => set("hideNotFound", v)}
              />
            </div>
          </div>
        </FilterButton>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <Switch
            checked={ex.onlyInView}
            onCheckedChange={ex.setOnlyInView}
            aria-label={t("filters.onlyInView")}
          />
          {t("filters.onlyInView")}
        </label>
        <div className="flex items-center gap-1">
          {filters.scanId !== undefined && (
            <button
              type="button"
              onClick={() => set("scanId", undefined)}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-primary px-2.5 text-[12px] font-medium text-primary-foreground"
            >
              {t("filters.scan", { id: filters.scanId })} <X className="size-3.5" />
            </button>
          )}
          {ex.activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px]"
              onClick={ex.resetFilters}
            >
              {t("filters.clear")} ({ex.activeFilterCount})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
