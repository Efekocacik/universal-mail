"use client";

import { Compass, LayoutDashboard, Layers, Mail, Settings } from "lucide-react";
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
import { WorkerStatusBanner } from "./worker-status-banner";

/**
 * Gezinme öğeleri (docs/07-UI-REHBERI.md §4: 5 sabit öğe). Şablonlar ve Uyum ekranları "Kampanyalar" altındadır
 * (sayfa içi alt gezinme); bu yüzden o yollarda "Kampanyalar" etkin görünür. Gösterge paneli (Faz 4) ilk sıradadır;
 * açılış ekranı ve logo bağlantısı Keşif (`/`) olarak kalır (`/?scan=` bağlantıları buna dayanır).
 */
export const NAV_ITEMS = [
  { href: "/dashboard", key: "nav.dashboard", icon: LayoutDashboard },
  { href: "/", key: "nav.explore", icon: Compass },
  { href: "/scans", key: "nav.scans", icon: Layers },
  {
    href: "/campaigns",
    key: "nav.campaigns",
    icon: Mail,
    also: ["/templates", "/compliance", "/mail-log"],
  },
  { href: "/settings", key: "nav.settings", icon: Settings },
] as const satisfies readonly {
  href: string;
  key: string;
  icon: unknown;
  also?: readonly string[];
}[];

function BudgetPill() {
  const { data } = useStatus();
  if (!data) return <div className="h-8 w-24 animate-pulse rounded-full bg-muted sm:w-40" />;
  const b = data.budget;
  const tone = b.level === "blocked" ? "danger" : b.level === "warning" ? "warning" : "primary";
  const text = t("budget.pill", { spent: fmtUsd(b.spentUsd), limit: fmtUsd(b.monthlyUsd) });
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
        className={cn(
          "flex h-8 items-center gap-2.5 rounded-full border bg-card px-3 text-[12px] transition-colors duration-150 hover:bg-accent",
          tone === "warning" && "border-nov-likely/60 bg-nov-likely/10",
          tone === "danger" && "border-destructive/50 bg-destructive/10",
        )}
        aria-label={text}
      >
        <span className="tabular font-semibold">
          <span className="hidden sm:inline">{text}</span>
          <span className="sm:hidden">
            {fmtUsd(b.spentUsd)}
            <span className="font-normal text-muted-foreground"> / {fmtUsd(b.monthlyUsd)}</span>
          </span>
        </span>
        <Progress value={b.pct} tone={tone} label={text} className="hidden w-12 sm:block" />
      </Link>
    </Tip>
  );
}

function ProviderBadge() {
  const { data } = useStatus();
  if (data?.provider !== "mock") return null;
  return (
    <Tip content={t("provider.demo.tip")}>
      <Badge variant="future" className="cursor-help" tabIndex={0}>
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
        <a
          href="#icerik"
          className="sr-only z-[70] rounded-md bg-card px-3 py-2 text-sm font-medium shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          {t("a11y.skip")}
        </a>
        <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 border-b bg-card/90 px-4 shadow-[0_1px_8px_rgb(0_0_0/0.04)] backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:gap-4">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md font-semibold tracking-tight"
            aria-label="Universal Mail"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground shadow-sm">
              U
            </span>
            <span className="hidden lg:inline">Universal Mail</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label={t("nav.label")}>
            {NAV_ITEMS.map((item) => {
              const { href, key, icon: Icon } = item;
              const also: readonly string[] = "also" in item ? item.also : [];
              const active =
                href === "/"
                  ? pathname === "/"
                  : [href, ...also].some((p) => pathname === p || pathname.startsWith(`${p}/`));
              return (
                <Tip key={href} content={t(key)} side="bottom">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    aria-label={t(key)}
                    className={cn(
                      "relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150",
                      active
                        ? "bg-accent text-accent-foreground after:absolute after:inset-x-2.5 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-primary"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="hidden md:inline">{t(key)}</span>
                  </Link>
                </Tip>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ProviderBadge />
            <BudgetPill />
          </div>
        </header>
        <WorkerStatusBanner />
        <main id="icerik" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {children}
        </main>
        <Toaster position="bottom-right" richColors closeButton duration={8000} />
      </div>
    </TooltipProvider>
  );
}
