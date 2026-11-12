"use client";

import {
  Bell,
  CalendarClock,
  Gauge,
  type LucideIcon,
  Mailbox,
  RefreshCw,
  Sparkles,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { HelpTip } from "@/components/ui/tooltip";
import { countryLabel, typeLabel } from "@/lib/client/format";
import {
  useDashboard,
  type DashboardBudget,
  type DashboardCounters,
  type DashboardMailboxQueue,
  type DashboardResponse,
  type DashboardSection,
} from "@/lib/client/dashboard";
import { getLocale, t, type Locale } from "@/lib/i18n";
import {
  budgetTone,
  clockTime,
  exploreLink,
  formatCount,
  formatUsd,
  queueState,
  relativeTime,
  scheduleState,
  usagePct,
  utcDayStart,
} from "./model";

/**
 * Gösterge paneli (Faz 4, Paket E): sayaçlar, bugünkü gönderim sırası, aylık Google harcaması, bu hafta yeni
 * açılanlar, yaklaşan taramalar ve son bildirimler. Yalnızca okur; her bölüm ayrı yüklenir ve biri başarısız olsa da
 * diğerleri görünür.
 */
export function DashboardPage() {
  const q = useDashboard();
  const locale = getLocale();
  const data = q.data;
  return (
    <div className="um-scroll min-h-0 flex-1" data-testid="dash-page">
      <div className="um-enter mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <PageHeader
          title={t("dash.title")}
          description={t("dash.desc")}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
              data-testid="dash-refresh"
            >
              <RefreshCw className={q.isFetching ? "animate-spin" : undefined} />
              {t("dash.refresh")}
            </Button>
          }
        />
        {!data && q.isPending && <DashboardSkeleton />}
        {!data && q.isError && <DashboardLoadError onRetry={() => void q.refetch()} />}
        {data && <DashboardBody data={data} locale={locale} />}
      </div>
    </div>
  );
}

function DashboardBody({ data, locale }: { data: DashboardResponse; locale: Locale }) {
  const now = data.generatedAt;
  return (
    <>
      <p className="text-[12px] text-muted-foreground" data-testid="dash-updated">
        {t("dash.updated", { time: clockTime(now, locale) })}
      </p>
      <Section name="counters" data={data}>
        {data.counters && (
          <CounterGrid
            c={data.counters}
            weekStart={data.weekStart}
            generatedAt={now}
            locale={locale}
          />
        )}
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          icon={Mailbox}
          title={t("dash.queue.title")}
          help={t("dash.queue.help")}
          testId="dash-queue"
        >
          <Section name="queue" data={data}>
            {data.queue && <QueueList rows={data.queue.mailboxes} now={now} locale={locale} />}
          </Section>
        </Panel>
        <Panel
          icon={Wallet}
          title={t("dash.budget.title")}
          help={t("dash.budget.help")}
          testId="dash-budget"
        >
          <Section name="budget" data={data}>
            {data.budget && <BudgetView b={data.budget} locale={locale} />}
          </Section>
        </Panel>
        <Panel
          icon={Sparkles}
          title={t("dash.new.title")}
          description={t("dash.new.desc")}
          help={t("dash.new.help")}
          testId="dash-new"
        >
          <Section name="newThisWeek" data={data}>
            {data.newThisWeek && (
              <NewList
                items={data.newThisWeek.items}
                total={data.newThisWeek.total}
                weekStart={data.weekStart}
                now={now}
                locale={locale}
              />
            )}
          </Section>
        </Panel>
        <Panel
          icon={CalendarClock}
          title={t("dash.scans.title")}
          help={t("dash.scans.help")}
          testId="dash-scans"
        >
          <Section name="scans" data={data}>
            {data.scans && <ScanList s={data.scans} now={now} locale={locale} />}
          </Section>
        </Panel>
        <Panel
          icon={Bell}
          title={t("dash.notif.title")}
          help={t("dash.notif.help")}
          testId="dash-notif"
          badge={
            data.notifications && data.notifications.unread > 0 ? (
              <Badge variant="info">
                {t("dash.notif.unread", { n: formatCount(data.notifications.unread, locale) })}
              </Badge>
            ) : null
          }
          className="lg:col-span-2"
        >
          <Section name="notifications" data={data}>
            {data.notifications && (
              <NotificationList items={data.notifications.items} now={now} locale={locale} />
            )}
          </Section>
        </Panel>
      </div>
    </>
  );
}

/* Ortak parçalar ---------------------------------------------------------------------------------------------------- */

function Section({
  name,
  data,
  children,
}: {
  name: DashboardSection;
  data: DashboardResponse;
  children: React.ReactNode;
}) {
  if (data.errors.includes(name)) {
    return (
      // `status` (kibar): 60 sn'lik yenilemede aynı hata yeniden "uyarı" olarak okunmaz.
      <p
        role="status"
        className="rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground"
        data-testid={`dash-section-error-${name}`}
      >
        {t("dash.sectionError")}
      </p>
    );
  }
  return <>{children}</>;
}

function Panel({
  icon: Icon,
  title,
  description,
  help,
  badge,
  testId,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  help?: string;
  badge?: React.ReactNode;
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className} data-testid={testId}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>{title}</CardTitle>
          {help && <HelpTip>{help}</HelpTip>}
          {badge && <span className="ml-auto">{badge}</span>}
        </div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({
  children,
  action,
  testId,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  testId: string;
}) {
  // Ortak boş durum bileşeninin kart içi biçimi (tasarım sistemi; metin tek cümle, varsa tek eylem).
  return <EmptyState compact body={children} action={action} testId={testId} />;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  );
}

function DashboardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="um-enter rounded-xl border border-dashed bg-card p-6 text-center"
      data-testid="dash-load-error"
    >
      <p className="text-sm font-semibold">{t("dash.loadError")}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{t("dash.loadError.next")}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw /> {t("error.retry")}
      </Button>
    </div>
  );
}

/* Sayaçlar ---------------------------------------------------------------------------------------------------------- */

function CounterGrid({
  c,
  weekStart,
  generatedAt,
  locale,
}: {
  c: DashboardCounters;
  weekStart: number;
  generatedAt: number;
  locale: Locale;
}) {
  const n = (v: number) => formatCount(v, locale);
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={t("dash.stats.label")}>
      <StatTile
        id="businesses"
        label={t("dash.stat.businesses")}
        value={n(c.businesses)}
        href="/"
        help={t("dash.stat.businesses.help")}
      />
      <StatTile
        id="withEmail"
        label={t("dash.stat.withEmail")}
        value={n(c.withEmail)}
        href="/"
        help={t("dash.stat.withEmail.help")}
      />
      <StatTile
        id="newThisWeek"
        label={t("dash.stat.newThisWeek")}
        value={n(c.newThisWeek)}
        href={exploreLink("new", weekStart)}
        help={t("dash.stat.newThisWeek.help")}
      />
      <StatTile
        id="openedThisWeek"
        label={t("dash.stat.openedThisWeek")}
        value={n(c.openedThisWeek)}
        href={exploreLink("opened", weekStart)}
        help={t("dash.stat.openedThisWeek.help")}
      />
      <StatTile
        id="activeCampaigns"
        label={t("dash.stat.activeCampaigns")}
        value={n(c.activeCampaigns)}
        href="/campaigns"
        sub={
          c.pausedCampaigns > 0
            ? t("dash.stat.activeCampaigns.paused", { n: n(c.pausedCampaigns) })
            : undefined
        }
      />
      <StatTile
        id="sentToday"
        label={t("dash.stat.sentToday")}
        value={n(c.sentToday)}
        href="/mail-log"
        help={t("dash.stat.sentToday.help")}
        sub={
          c.sentTodayLimitDay !== c.sentToday
            ? t("dash.stat.sentToday.limitDay", {
                n: n(c.sentTodayLimitDay),
                time: clockTime(utcDayStart(generatedAt), locale),
              })
            : undefined
        }
      />
      <StatTile
        id="sentMonth"
        label={t("dash.stat.sentMonth")}
        value={n(c.sentThisMonth)}
        href="/mail-log"
      />
      <StatTile
        id="replies"
        label={t("dash.stat.replies")}
        value={n(c.repliesThisMonth)}
        href="/mail-log?tab=review"
        help={t("dash.stat.replies.help")}
        sub={
          c.repliesNegative > 0
            ? t("dash.stat.replies.negative", { n: n(c.repliesNegative) })
            : undefined
        }
        warn={
          c.repliesPendingReview > 0
            ? t("dash.stat.replies.pending", { n: n(c.repliesPendingReview) })
            : undefined
        }
      />
    </ul>
  );
}

function StatTile({
  id,
  label,
  value,
  href,
  help,
  sub,
  warn,
}: {
  id: string;
  label: string;
  value: string;
  href: string;
  help?: string;
  sub?: string;
  /** Dikkat isteyen ek satır (ör. incelemede bekleyen yanıtlar). */
  warn?: string;
}) {
  return (
    <li
      className="relative rounded-xl border bg-card p-3 shadow-xs"
      data-testid={`dash-stat-${id}`}
    >
      <div className="flex items-center gap-1">
        <p className="text-[12px] text-muted-foreground">{label}</p>
        {help && <HelpTip className="relative z-10">{help}</HelpTip>}
      </div>
      <Link
        href={href}
        aria-label={`${label}: ${value}`}
        className="tabular mt-1 block text-2xl font-semibold after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-2"
      >
        {value}
      </Link>
      {sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
      {warn && <p className="mt-0.5 text-[12px] text-warning">{warn}</p>}
    </li>
  );
}

/* Gönderim sırası --------------------------------------------------------------------------------------------------- */

function QueueList({
  rows,
  now,
  locale,
}: {
  rows: DashboardMailboxQueue[];
  now: number;
  locale: Locale;
}) {
  if (rows.length === 0) {
    return (
      <Empty
        testId="dash-queue-empty"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/settings">{t("dash.queue.empty.cta")}</Link>
          </Button>
        }
      >
        {t("dash.queue.empty")}
      </Empty>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((m) => (
        <li key={m.id} className="space-y-1" data-testid={`dash-queue-row-${m.id}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 truncate text-[13px] font-medium">{m.label}</p>
            <p className="tabular text-[12px] text-muted-foreground">
              {t("dash.queue.used", {
                used: formatCount(m.used, locale),
                cap: formatCount(m.cap, locale),
              })}
              {m.waiting > 0 && (
                <> · {t("dash.queue.waiting", { n: formatCount(m.waiting, locale) })}</>
              )}
            </p>
          </div>
          <Progress
            value={usagePct(m.used, m.cap)}
            tone={m.capReached ? "warning" : "primary"}
            label={t("dash.queue.used", { used: m.used, cap: m.cap })}
          />
          <p className="text-[12px] text-muted-foreground" data-testid={`dash-queue-state-${m.id}`}>
            {queueText(m, now, locale)}
          </p>
        </li>
      ))}
      <li>
        <Link href="/settings" className="text-[12px] text-primary hover:underline">
          <Gauge className="mr-1 inline size-3.5" aria-hidden />
          {t("dash.queue.editLimit")}
        </Link>
      </li>
    </ul>
  );
}

function queueText(m: DashboardMailboxQueue, now: number, locale: Locale): string {
  const s = queueState(m, now);
  switch (s.kind) {
    case "reauth":
      return t("dash.queue.state.reauth");
    case "backoff":
      return t("dash.queue.state.backoff", { when: relativeTime(s.until, now, locale) });
    case "capReached":
      return s.until
        ? t("dash.queue.state.capReached", { time: clockTime(s.until, locale) })
        : t("dash.queue.state.capReachedNoTime");
    case "due":
      return t("dash.queue.state.due", { n: formatCount(s.n, locale) });
    case "next":
      return t("dash.queue.state.next", { when: relativeTime(s.at, now, locale) });
    case "idle":
      return t("dash.queue.state.idle");
  }
}

/* Bütçe ------------------------------------------------------------------------------------------------------------- */

function BudgetView({ b, locale }: { b: DashboardBudget; locale: Locale }) {
  const usd = (n: number) => formatUsd(n, locale);
  const over = b.projectionReliable && b.projectedUsd > b.monthlyUsd;
  return (
    <div className="space-y-2">
      <p className="tabular text-xl font-semibold" data-testid="dash-budget-spent">
        {t("dash.budget.spent", { spent: usd(b.spentUsd), limit: usd(b.monthlyUsd) })}
      </p>
      <Progress value={b.pct} tone={budgetTone(b.level)} label={t("dash.budget.title")} />
      <p className="text-[12px] text-muted-foreground">
        {t("dash.budget.left", { left: usd(b.remainingUsd) })}
      </p>
      {b.provider === "mock" && (
        <p className="text-[12px] text-muted-foreground">{t("dash.budget.mock")}</p>
      )}
      {b.level === "blocked" && (
        <p role="alert" className="text-[13px] text-destructive" data-testid="dash-budget-blocked">
          {t("dash.budget.blocked")}
        </p>
      )}
      {b.level === "warning" && (
        <p className="text-[13px] text-warning">{t("dash.budget.warning")}</p>
      )}
      {b.level !== "blocked" && b.projectionReliable && (
        <p className="text-[12px] text-muted-foreground" data-testid="dash-budget-projection">
          {over
            ? t("dash.budget.projectionOver", { usd: usd(b.projectedUsd) })
            : t("dash.budget.projection", { usd: usd(b.projectedUsd) })}
        </p>
      )}
      <Link href="/settings#budget" className="text-[12px] text-primary hover:underline">
        {t("dash.budget.edit")}
      </Link>
    </div>
  );
}

/* Bu hafta yeni ----------------------------------------------------------------------------------------------------- */

function NewList({
  items,
  total,
  weekStart,
  now,
  locale,
}: {
  items: NonNullable<DashboardResponse["newThisWeek"]>["items"];
  total: number;
  weekStart: number;
  now: number;
  locale: Locale;
}) {
  if (items.length === 0) {
    return (
      <Empty
        testId="dash-new-empty"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/scans">{t("dash.scans.cta")}</Link>
          </Button>
        }
      >
        {t("dash.new.empty")}
      </Empty>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y">
        {items.map((it) => (
          <li
            key={it.leadId}
            className="flex items-center gap-2 py-1.5"
            data-testid="dash-new-item"
          >
            <Badge variant={it.kind === "opened" ? "high" : "future"}>
              {it.kind === "opened" ? t("dash.new.kind.opened") : t("dash.new.kind.new")}
            </Badge>
            <Link
              href={exploreLink(it.kind, weekStart)}
              className="min-w-0 flex-1 truncate text-[13px] hover:underline"
            >
              {it.name ?? <span className="text-muted-foreground">{t("dash.new.unnamed")}</span>}
            </Link>
            <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
              {[typeLabel(it.categoryKey), it.city, countryLabel(it.countryCode)]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {relativeTime(it.detectedAt, now, locale)}
            </span>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="text-[12px] text-muted-foreground">
          {t("dash.new.more", { n: formatCount(total - items.length, locale) })}
        </p>
      )}
      <div className="flex flex-wrap gap-3 text-[12px]">
        <Link
          href={exploreLink("opened", weekStart)}
          className="text-primary hover:underline"
          data-testid="dash-new-opened-link"
        >
          {t("dash.new.seeOpened")}
        </Link>
        <Link
          href={exploreLink("new", weekStart)}
          className="text-primary hover:underline"
          data-testid="dash-new-new-link"
        >
          {t("dash.new.seeNew")}
        </Link>
      </div>
    </div>
  );
}

/* Taramalar --------------------------------------------------------------------------------------------------------- */

function ScanList({
  s,
  now,
  locale,
}: {
  s: NonNullable<DashboardResponse["scans"]>;
  now: number;
  locale: Locale;
}) {
  return (
    <div className="space-y-2">
      {s.active > 0 && (
        <p className="text-[13px]" data-testid="dash-scans-active">
          {t("dash.scans.active", { n: formatCount(s.active, locale) })}
        </p>
      )}
      {s.upcoming.length === 0 ? (
        <Empty
          testId="dash-scans-empty"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/scans">{t("dash.scans.cta")}</Link>
            </Button>
          }
        >
          {t("dash.scans.empty")}
        </Empty>
      ) : (
        <ul className="divide-y">
          {s.upcoming.map((u) => {
            const state = scheduleState(u);
            return (
              <li key={u.id} className="py-1.5" data-testid="dash-scan-item">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-[13px] font-medium">
                    {u.regionName}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {t("dash.scans.every", { days: u.intervalDays })}
                    </span>
                  </p>
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {state === "overdue" ? null : relativeTime(u.nextRunAt, now, locale)}
                  </span>
                </div>
                {state === "overdue" && (
                  <p className="text-[12px] text-warning">{t("dash.scans.overdue")}</p>
                )}
                {state === "skipped" && (
                  <p className="text-[12px] text-muted-foreground">{t("dash.scans.skipped")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* Bildirimler ------------------------------------------------------------------------------------------------------- */

function NotificationList({
  items,
  now,
  locale,
}: {
  items: NonNullable<DashboardResponse["notifications"]>["items"];
  now: number;
  locale: Locale;
}) {
  if (items.length === 0) {
    return <Empty testId="dash-notif-empty">{t("dash.notif.empty")}</Empty>;
  }
  return (
    <ul className="divide-y">
      {items.map((n) => (
        <li key={n.id} className="flex items-start gap-3 py-2" data-testid="dash-notif-item">
          <span
            aria-hidden
            className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt === null ? "bg-primary" : "bg-transparent"}`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">
              {n.readAt === null && <span className="sr-only">{t("dash.notif.unreadItem")}: </span>}
              {n.title}
            </p>
            <p className="text-[12px] text-muted-foreground">{n.body}</p>
          </div>
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {relativeTime(n.createdAt, now, locale)}
          </span>
          <Link
            href={n.url}
            aria-label={t("dash.notif.openLabel", { title: n.title })}
            className="shrink-0 text-[12px] text-primary hover:underline"
          >
            {t("dash.notif.open")}
          </Link>
        </li>
      ))}
    </ul>
  );
}
