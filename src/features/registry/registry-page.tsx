"use client";

import { FlaskConical, Info, Landmark, Play, RefreshCw, Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadError } from "@/features/campaigns/parts";
import { ScansSubnav } from "@/features/scans/scans-subnav";
import { errorText } from "@/lib/client/api";
import { fmtIsoDay, fmtNumber } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import {
  codeLabel,
  companyTitle,
  emptyListKind,
  formatRate,
  isRunActive,
  reasonText,
  REGISTRY_SOURCES,
  runSummary,
  runTone,
  useCreateRegistryRun,
  usePromoteToLead,
  useRegistryCompanies,
  useRegistryAutoRefresh,
  useRegistryRuns,
  useRematch,
  type CompanyStats,
  type RegistryCompanyDto,
  type RegistrySource,
} from "@/lib/client/registry";
import { useDebounced } from "@/lib/client/use-debounced";
import { t } from "@/lib/i18n";
import { codesForScheme } from "@/lib/registry/codes";

/**
 * `/scans/registry`: resmî sicil çalıştırma formu, çalışma listesi, eşleşme oranı, "Haritada eşleşti" ve "Sicilde var,
 * haritada eşleşmedi" sekmeleri, "Yeniden eşleştir". Demo kipinde (Places = mock) anahtarsız çalışır ve kayıtlar
 * "Demo" etiketlidir.
 */
export function RegistryPage() {
  const { data: settings } = useSettings();
  const runs = useRegistryRuns();
  const demo = settings?.settings["places.provider"] === "mock";
  const busy = !!runs.data && (runs.data.matchActive || runs.data.runs.some(isRunActive));
  // Kayıt listeleri yalnızca iş sürerken yoklanır; çalışma/eşleştirme durumu değişince (bitiş dahil) bir kez yenilenir.
  useRegistryAutoRefresh(runs.data);

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <ScansSubnav />
        <PageHeader title={t("registry.title")} description={t("registry.subtitle")} />
        {demo && (
          <p
            className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[13px] text-info-text"
            data-testid="registry-demo-banner"
          >
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("registry.demoBanner")}
          </p>
        )}
        <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("registry.note")}
        </p>
        {settings ? <RunForm demo={demo} /> : <Skeleton className="h-48" />}
        <RunsCard />
        <ResultsCard busy={busy} />
      </div>
    </div>
  );
}

function RunForm({ demo }: { demo: boolean }) {
  const { data } = useSettings();
  const create = useCreateRegistryRun();
  const ids = useId();
  const [source, setSource] = useState<RegistrySource>("companies_house");
  const ch = data!.settings["registry.companiesHouse"];
  const fr = data!.settings["registry.insee"];
  const setting = source === "companies_house" ? ch : fr;
  const options = codesForScheme(source === "companies_house" ? "SIC2007" : "NAFRev2");
  const defaults = source === "companies_house" ? ch.sicCodes : fr.nafCodes;
  // Kaynak başına seçim; kullanıcı değiştirmediyse ayarlardaki varsayılanlar.
  const [picked, setPicked] = useState<Partial<Record<RegistrySource, string[]>>>({});
  const [locality, setLocality] = useState("");
  const [days, setDays] = useState<string>("");
  const codes = picked[source] ?? defaults.filter((c) => options.includes(c));
  const windowDays = days === "" ? setting.windowDays : Number(days);
  const windowOk = Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 365;
  const liveOff = !demo && !setting.enabled;
  const valid = codes.length > 0 && windowOk && !liveOff;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate(
      { source, codes, windowDays, ...(locality.trim() ? { locality: locality.trim() } : {}) },
      {
        onSuccess: () => toast.success(t("registry.form.started")),
        onError: (err) => toast.error(errorText(err)),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("registry.form.title")}</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        <form className="space-y-4" onSubmit={submit} data-testid="registry-run-form">
          <div className="space-y-1.5">
            <span className="text-sm font-medium" id={`${ids}-src`}>
              {t("registry.form.source")}
            </span>
            <Segmented
              label={t("registry.form.source")}
              value={source}
              onChange={setSource}
              options={REGISTRY_SOURCES.map((s) => ({
                value: s,
                label: t(`registry.source.${s}`),
              }))}
              testId="registry-source"
            />
          </div>
          {liveOff && (
            <div
              className="flex flex-wrap items-center gap-2 text-[13px] text-warning-text"
              role="status"
            >
              <span>{t("registry.form.liveOff")}</span>
              <Link
                href="/settings#registry"
                className="inline-flex items-center gap-1 font-medium underline"
              >
                <Settings2 className="size-3.5" aria-hidden />
                {t("registry.form.openSettings")}
              </Link>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-loc`}>{t("registry.form.locality")}</Label>
              <Input
                id={`${ids}-loc`}
                value={locality}
                maxLength={80}
                onChange={(e) => setLocality(e.target.value)}
                aria-describedby={`${ids}-loc-hint`}
              />
              <FieldHint id={`${ids}-loc-hint`}>{t("registry.form.localityHint")}</FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-days`}>{t("registry.form.window")}</Label>
              <Input
                id={`${ids}-days`}
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={days === "" ? String(setting.windowDays) : days}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={!windowOk}
                aria-describedby={`${ids}-days-hint`}
              />
              {windowOk ? (
                <FieldHint id={`${ids}-days-hint`}>{t("registry.form.windowHint")}</FieldHint>
              ) : (
                <FieldError id={`${ids}-days-hint`} role="alert">
                  {t("registry.form.windowInvalid")}
                </FieldError>
              )}
            </div>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("registry.form.codes")}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {options.map((code) => {
                const id = `${ids}-code-${code}`;
                return (
                  <label
                    key={code}
                    htmlFor={id}
                    className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-accent"
                  >
                    <Checkbox
                      id={id}
                      checked={codes.includes(code)}
                      onCheckedChange={(c) =>
                        setPicked((p) => ({
                          ...p,
                          [source]: c ? [...codes, code] : codes.filter((x) => x !== code),
                        }))
                      }
                    />
                    <span className="min-w-0">{codeLabel(code)}</span>
                  </label>
                );
              })}
            </div>
            {codes.length === 0 && (
              <FieldError role="alert">{t("registry.form.codesRequired")}</FieldError>
            )}
          </fieldset>
          <Button type="submit" disabled={!valid} loading={create.isPending}>
            {!create.isPending && <Play />} {t("registry.form.run")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RunsCard() {
  const { data, isLoading, isError, error, refetch } = useRegistryRuns();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("registry.runs.title")}
          {data?.matchActive && (
            <Badge variant="info" role="status">
              <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              {t("registry.runs.matching")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : isError && !data ? (
          <LoadError error={error} onRetry={() => void refetch()} />
        ) : !data?.runs.length ? (
          <EmptyState
            compact
            icon={Landmark}
            title={t("registry.runs.empty")}
            body={t("registry.runs.emptyBody")}
          />
        ) : (
          <ul className="divide-y" data-testid="registry-runs">
            {data.runs.map((r) => {
              const s = runSummary(r);
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                      {t(`registry.source.short.${r.source}`)}
                      {r.locality && <span className="text-muted-foreground">· {r.locality}</span>}
                      {r.isDemo && <Badge variant="outline">{t("registry.list.demoTag")}</Badge>}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {s.window} · {s.counts}
                    </p>
                    {s.error && <p className="text-[12px] text-danger-text">{s.error}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {s.rate && (
                      <Badge variant="default" data-testid={`registry-run-rate-${r.id}`}>
                        {s.rate}
                      </Badge>
                    )}
                    <Badge variant={runTone(r.status)}>{s.status}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ResultsCard({ busy }: { busy: boolean }) {
  const [tab, setTab] = useState<"matched" | "open">("matched");
  const [q, setQ] = useState("");
  // Her tuşta iki yeni sorgu başlamasın; üst sayaçlar (oran, özet, Yeniden eşleştir) aramadan bağımsızdır.
  const search = useDebounced(q.trim(), 300);
  const rematch = useRematch();
  const matched = useRegistryCompanies({ match: "matched", q: search }, busy);
  const open = useRegistryCompanies({ match: "open", q: search }, busy);
  const first = matched.data?.pages[0] ?? open.data?.pages[0];
  const stats = first?.stats;
  // Sekme sayaçları listeyle tutarlıdır: arama varken aramaya uyanlar.
  const tabStats = (search ? first?.searchStats : null) ?? stats;
  const matchedCount = tabStats?.matched ?? 0;
  const openCount = (tabStats?.unmatched ?? 0) + (tabStats?.pending ?? 0);
  const rate = stats && stats.total > 0 ? formatRate(stats.matchRate) : null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-muted-foreground">
              {t("registry.stats.rate")}
            </p>
            <p className="text-2xl font-semibold tabular" data-testid="registry-match-rate">
              {rate ?? "—"}
            </p>
            {stats && stats.total > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("registry.stats.summary", {
                  matched: fmtNumber(stats.matched),
                  total: fmtNumber(stats.total),
                })}
              </p>
            )}
            {search && first?.searchStats && (
              <p className="text-[12px] text-muted-foreground" data-testid="registry-in-search">
                {t("registry.stats.inSearch", { n: fmtNumber(first.searchStats.total) })}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            onClick={() =>
              rematch.mutate(undefined, {
                onSuccess: () => toast.success(t("registry.rematch.started")),
                onError: (err) => toast.error(errorText(err)),
              })
            }
            loading={rematch.isPending}
            disabled={!stats || stats.total === 0}
          >
            {!rematch.isPending && <RefreshCw />} {t("registry.rematch")}
          </Button>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("registry.list.search")}
            aria-label={t("registry.list.search")}
            maxLength={100}
            className="pl-9"
          />
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "matched" | "open")}>
          <TabsList className="flex h-auto w-full flex-wrap">
            <TabsTrigger value="matched" className="min-w-0 flex-1 whitespace-normal">
              {t("registry.tabs.matched")} ({fmtNumber(matchedCount)})
            </TabsTrigger>
            <TabsTrigger
              value="open"
              className="min-w-0 flex-1 whitespace-normal"
              data-testid="registry-tab-open"
            >
              {t("registry.tabs.unmatched")} ({fmtNumber(openCount)})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched">
            <CompanyList query={matched} kind="matched" stats={stats} searching={!!search} />
          </TabsContent>
          <TabsContent value="open">
            <CompanyList query={open} kind="open" stats={stats} searching={!!search} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

const EMPTY_COPY = {
  none: { title: "registry.list.empty.none", body: "registry.list.empty.noneBody" },
  noResults: { title: "registry.list.empty.noResults", body: "registry.list.empty.noResultsBody" },
  matched: { title: "registry.list.empty.matched", body: "registry.list.empty.matchedBody" },
  open: { title: "registry.list.empty.unmatched", body: "registry.list.empty.unmatchedBody" },
} as const;

function CompanyList({
  query,
  kind,
  stats,
  searching,
}: {
  query: ReturnType<typeof useRegistryCompanies>;
  kind: "matched" | "open";
  stats: CompanyStats | undefined;
  searching: boolean;
}) {
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  if (query.isLoading) return <Skeleton className="mt-3 h-24" />;
  // API hatası boş durum gibi görünmez ("hepsi eşleşti" yanlış söylenmez).
  if (query.isError && !query.data)
    return (
      <div className="mt-3">
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  if (items.length === 0) {
    const k = emptyListKind(stats, searching);
    const copy = EMPTY_COPY[k === "tab" ? kind : k];
    return (
      <EmptyState
        compact
        className="mt-3"
        icon={Landmark}
        title={t(copy.title)}
        body={t(copy.body)}
        testId={`registry-empty-${k === "tab" ? kind : k}`}
      />
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <ul className="divide-y" data-testid={`registry-list-${kind}`}>
        {items.map((c) => (
          <CompanyRow key={c.id} c={c} kind={kind} />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.fetchNextPage()}
          loading={query.isFetchingNextPage}
        >
          {t("registry.list.more")}
        </Button>
      )}
    </div>
  );
}

function CompanyRow({ c, kind }: { c: RegistryCompanyDto; kind: "matched" | "open" }) {
  const promote = usePromoteToLead();
  const title = companyTitle(c);
  const reason =
    c.matchStatus === "pending" && !c.matchReason
      ? t("registry.list.pending")
      : reasonText(c.matchReason);
  const leadHref = (id: number) => `/?lead=${id}`;
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-2 py-2.5"
      data-testid="registry-company"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
          <span className="min-w-0 break-words">{title.primary}</span>
          {c.isDemo && <Badge variant="outline">{t("registry.list.demoTag")}</Badge>}
        </p>
        {title.secondary && (
          <p className="break-words text-[12px] text-muted-foreground">{title.secondary}</p>
        )}
        <p className="text-[12px] text-muted-foreground">
          {[c.locality, c.postcode].filter(Boolean).join(" · ")}
          {c.locality || c.postcode ? " · " : ""}
          {t("registry.list.incorporated", { date: fmtIsoDay(c.incorporatedOn) })}
        </p>
        {reason && (
          <p className="text-[12px] text-muted-foreground">
            {reason}
            {kind === "matched" && c.matchScore !== null
              ? ` · ${t("registry.list.score", { score: formatRate(c.matchScore) ?? "" })}`
              : ""}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {kind === "matched" && c.matchedLeadId !== null && (
          <Button asChild variant="outline" size="sm">
            <Link href={leadHref(c.matchedLeadId)}>{t("registry.list.openLead")}</Link>
          </Button>
        )}
        {kind === "open" &&
          (c.leadId !== null ? (
            <Button asChild variant="outline" size="sm">
              <Link href={leadHref(c.leadId)}>{t("registry.list.openCreatedLead")}</Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              loading={promote.isPending}
              aria-label={`${t("registry.list.addLead")}: ${title.primary}`}
              onClick={() =>
                promote.mutate(c.id, {
                  onSuccess: () => toast.success(t("registry.list.leadCreated")),
                  onError: (err) => toast.error(errorText(err)),
                })
              }
            >
              {t("registry.list.addLead")}
            </Button>
          ))}
      </div>
    </li>
  );
}
