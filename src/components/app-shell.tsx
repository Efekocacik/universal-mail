"use client";

import { Compass, Layers, Mail, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/misc";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { fmtUsd } from "@/lib/client/format";
import { useStatus } from "@/lib/client/queries";
import { t } from "@/lib/i18n";

/** Gezinme öğeleri: sonraki fazlar (Şablonlar, Suppression) buraya eklenir. */
export const NAV_ITEMS = [
  { href: "/", key: "nav.explore", icon: Compass },
  { href: "/scans", key: "nav.scans", icon: Layers },
  { href: "/campaigns", key: "nav.campaigns", icon: Mail },
  { href: "/settings", key: "nav.settings", icon: Settings },
] as const;

function BudgetPill() {
  const { data } = useStatus();
  if (!data) return <div className="h-8 w-24 animate-pulse rounded-full bg-muted sm:w-36" />;
  const b = data.budget;
  const tone = b.level === "blocked" ? "danger" : b.level === "warning" ? "warning" : "primary";
  return (
    <Tip
      content={
        <span>
          {t("budget.tip", {
            spent: fmtUsd(b.spentUsd),
            limit: fmtUsd(b.monthlyUsd),
            month: b.month,
          })}
        </span>
      }
    >
      <Link
        href="/settings#budget"
        className="flex h-8 items-center gap-2.5 rounded-full border bg-card px-3 text-[12px] hover:bg-accent"
        aria-label={t("budget.label")}
      >
        <span className="hidden text-muted-foreground sm:inline">{t("budget.label")}</span>
        <span className="tabular font-semibold">
          {fmtUsd(b.spentUsd)}{" "}
          <span className="font-normal text-muted-foreground">/ {fmtUsd(b.monthlyUsd)}</span>
        </span>
        <Progress value={b.pct} tone={tone} className="hidden w-12 sm:block" />
      </Link>
    </Tip>
  );
}

function ProviderBadge() {
  const { data } = useStatus();
  if (data?.provider !== "mock") return null;
  return (
    <Tip content={t("provider.demo.tip")}>
      <Badge variant="future" className="cursor-help">
        {t("provider.demo")}
      </Badge>
    </Tip>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-card px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
              U
            </span>
            <span className="hidden sm:inline">Universal Mail</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label={t("nav.label")}>
            {NAV_ITEMS.map(({ href, key, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  <span className="hidden md:inline">{t(key)}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ProviderBadge />
            <BudgetPill />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <Toaster position="bottom-right" richColors closeButton />
      </div>
    </TooltipProvider>
  );
}
