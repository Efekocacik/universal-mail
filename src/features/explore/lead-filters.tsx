"use client";

import { ChevronDown, Search, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { countryLabel, fmtDate, fmtNumber, NOVELTY_ORDER } from "@/lib/client/format";
import { useCategories, useFacets } from "@/lib/client/queries";
import { t } from "@/lib/i18n";
import { LIFECYCLE_OPTIONS } from "@/lib/leads/saved-filter-payload";
import { SavedFiltersMenu } from "./saved-filters-menu";
import { SEARCH_INPUT_ID, useExplore, type UiFilters } from "./state";

const DAY_MS = 86_400_000;
const DETECTED_PERIODS = [7, 30] as const;

/** Tespit dönemi etiketi (saf): son N gün veya bağlantıdan gelen tarih. */
function detectedLabel(d: NonNullable<UiFilters["detected"]>): string {
  if (d.days === 7 || d.days === 30) return t(`filters.detected.${d.days}`);
  if (d.days !== undefined) return t("filters.detected.days", { n: d.days });
  return t("filters.detected.since", { date: fmtDate(d.since) });
}

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
            "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[12px] font-medium transition-colors hover:bg-accent",
            active
              ? "border-primary/50 bg-accent text-accent-foreground"
              : "bg-card text-muted-foreground",
          )}
        >
          {label}
          {summary && (
            <span className="max-w-24 truncate rounded-full bg-primary px-1.5 text-[11px] leading-4 text-primary-foreground">
              {summary}
            </span>
          )}
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
    <ul className="um-scroll max-h-64 overflow-y-auto">
      {options.map((o) => {
        const checked = selected.includes(o.value);
        const id = `f-${o.value}`;
        return (
          <li key={o.value}>
            <label
              htmlFor={id}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-accent"
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

// Kalıcı bayraklardan türetilen durumlar; geçici kapalı gibi ayrıntılar yalnızca önbellekteki Google verisinde bulunur.
const BUSINESS_STATUSES = ["OPERATIONAL", "FUTURE_OPENING", "CLOSED_PERMANENTLY"] as const;
// Faz 2: e-posta durumu (SRS email_status) ve işlem durumları.
const EMAIL_STATES = [
  "found_verified",
  "generic",
  "found_unverified",
  "invalid",
  "not_found",
  "unchecked",
  "queued",
  "running",
  "no_website",
  "needs_google",
  "blocked",
  "failed",
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

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="um-enter inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-accent pl-2.5 pr-1 text-[12px] font-medium text-accent-foreground">
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={t("filters.removeOne", { name: label })}
        onClick={onRemove}
        className="flex size-5 items-center justify-center rounded-full transition-colors hover:bg-foreground/10"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

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
    emailStatus: undefined,
  };
  const { data: facets } = useFacets(facetFilters);
  const { data: categories } = useCategories();
  const [cityQuery, setCityQuery] = useState("");

  const chips: { key: string; label: string; remove: () => void }[] = [];
  const without = <T,>(arr: T[], v: T) => arr.filter((x) => x !== v);
  for (const v of filters.countries)
    chips.push({
      key: `co-${v}`,
      label: countryLabel(v),
      remove: () => setFilters({ countries: without(filters.countries, v) }),
    });
  if (filters.city)
    chips.push({ key: "city", label: filters.city, remove: () => setFilters({ city: "" }) });
  for (const v of filters.categories)
    chips.push({
      key: `ca-${v}`,
      label: categories?.find((c) => c.key === v)?.name ?? v,
      remove: () => setFilters({ categories: without(filters.categories, v) }),
    });
  for (const v of filters.novelty)
    chips.push({
      key: `no-${v}`,
      label: t(`novelty.${v}`),
      remove: () => setFilters({ novelty: without(filters.novelty, v) }),
    });
  for (const v of filters.businessStatus)
    chips.push({
      key: `bs-${v}`,
      label: t(`businessStatus.${v as (typeof BUSINESS_STATUSES)[number]}`),
      remove: () => setFilters({ businessStatus: without(filters.businessStatus, v) }),
    });
  for (const v of filters.emailStatus)
    chips.push({
      key: `em-${v}`,
      label: t(`emailState.${v as (typeof EMAIL_STATES)[number]}`),
      remove: () => setFilters({ emailStatus: without(filters.emailStatus, v) }),
    });
  for (const v of filters.leadStatus)
    chips.push({
      key: `ls-${v}`,
      label: t(`leadStatus.${v}`),
      remove: () => setFilters({ leadStatus: without(filters.leadStatus, v) }),
    });
  if (filters.hasWebsite !== "any")
    chips.push({
      key: "web",
      label: t(`filters.website.${filters.hasWebsite}`),
      remove: () => setFilters({ hasWebsite: "any" }),
    });
  if (filters.hideNotFound)
    chips.push({
      key: "nf",
      label: t("filters.hideNotFound"),
      remove: () => setFilters({ hideNotFound: false }),
    });
  for (const v of filters.lifecycle)
    chips.push({
      key: `lc-${v}`,
      label: t(`lifecycle.${v}`),
      remove: () => setFilters({ lifecycle: without(filters.lifecycle, v) }),
    });
  if (filters.detected)
    chips.push({
      key: "det",
      label: detectedLabel(filters.detected),
      remove: () => setFilters({ detected: null }),
    });
  if (filters.archived)
    chips.push({
      key: "arc",
      label: t("filters.archived.chip"),
      remove: () => setFilters({ archived: false }),
    });
  if (filters.scanId !== undefined)
    chips.push({
      key: "scan",
      label: t("filters.scan", { id: filters.scanId }),
      remove: () => setFilters({ scanId: undefined }),
    });

  const set = <K extends keyof UiFilters>(k: K, v: UiFilters[K]) =>
    setFilters({ [k]: v } as Partial<UiFilters>);

  const cityOptions = (facets?.cities ?? [])
    .filter((c) => c.name.toLowerCase().includes(cityQuery.toLowerCase()))
    .slice(0, 60);

  return (
    <div className="space-y-2 border-b px-4 py-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          id={SEARCH_INPUT_ID}
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder={t("filters.search")}
          aria-label={t("filters.search")}
          className="h-10 pl-9 pr-9 text-sm"
        />
        {filters.q && (
          <button
            type="button"
            aria-label={t("filters.clearSearch")}
            onClick={() => set("q", "")}
            className="absolute right-2 top-2.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent"
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
          <ul className="um-scroll max-h-56 overflow-y-auto">
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
            options={(categories ?? []).map((c) => ({
              value: c.key,
              label: c.name,
              count: facets?.categories.find((f) => f.key === c.key)?.count ?? 0,
            }))}
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
          label={t("filters.emailStatus")}
          active={filters.emailStatus.length > 0}
          summary={summaryOf(filters.emailStatus.length)}
        >
          <MultiList
            options={EMAIL_STATES.map((s) => ({
              value: s,
              label: t(`emailState.${s}`),
              count: facets?.emailStatus?.[s] ?? 0,
            }))}
            selected={filters.emailStatus}
            onChange={(v) => set("emailStatus", v)}
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
          label={t("filters.lifecycle")}
          active={filters.lifecycle.length > 0 || filters.detected !== null}
          summary={summaryOf(filters.lifecycle.length + (filters.detected ? 1 : 0))}
        >
          <MultiList
            options={LIFECYCLE_OPTIONS.map((v) => ({ value: v, label: t(`lifecycle.${v}`) }))}
            selected={filters.lifecycle}
            onChange={(v) => set("lifecycle", v as UiFilters["lifecycle"])}
          />
          <fieldset className="mt-2 border-t px-1 pt-2">
            <legend className="mb-1 px-1 pt-2 text-[12px] font-medium text-muted-foreground">
              {t("filters.detected")}
            </legend>
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1 text-[13px]">
              <input
                type="radio"
                name="detected"
                checked={filters.detected === null}
                onChange={() => set("detected", null)}
                className="accent-[var(--primary)]"
              />
              {t("filters.detected.any")}
            </label>
            {DETECTED_PERIODS.map((n) => (
              <label
                key={n}
                className="flex cursor-pointer items-center gap-2 px-1 py-1 text-[13px]"
              >
                <input
                  type="radio"
                  name="detected"
                  checked={filters.detected?.days === n}
                  onChange={() => set("detected", { since: Date.now() - n * DAY_MS, days: n })}
                  className="accent-[var(--primary)]"
                />
                {t(`filters.detected.${n}`)}
              </label>
            ))}
            {filters.detected && filters.detected.days !== 7 && filters.detected.days !== 30 && (
              <label className="flex cursor-pointer items-center gap-2 px-1 py-1 text-[13px]">
                <input
                  type="radio"
                  name="detected"
                  checked
                  readOnly
                  className="accent-[var(--primary)]"
                />
                {detectedLabel(filters.detected)}
              </label>
            )}
          </fieldset>
        </FilterButton>

        <FilterButton
          label={t("filters.more")}
          active={filters.hasWebsite !== "any" || filters.hideNotFound || filters.archived}
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
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="show-archived" className="text-[13px] font-normal">
                {t("filters.archived")}
              </Label>
              <Switch
                id="show-archived"
                checked={filters.archived}
                onCheckedChange={(v) => set("archived", v)}
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
        <SavedFiltersMenu />
      </div>

      {chips.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("filters.active")}
        >
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} onRemove={c.remove} />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={ex.resetFilters}
            aria-label={t("filters.activeCount", { n: ex.activeFilterCount })}
          >
            {t("filters.clear")} ({ex.activeFilterCount})
          </Button>
        </div>
      )}
    </div>
  );
}
