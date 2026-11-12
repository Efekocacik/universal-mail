"use client";

import { Compass, LayoutDashboard, Layers, Mail, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/misc";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { fmtUsd } from "@/lib/client/format";
import { useStatus } from "@/lib/client/queries";
import { GLOBAL_SHORTCUTS, useShortcuts } from "@/lib/client/shortcuts";
import { t } from "@/lib/i18n";
import { NotificationBell } from "./notification-bell";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useResolvedTheme } from "./providers";
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

/**
 * Bütçe hapı tek satırdır (`whitespace-nowrap`). Uzun metin ("Bu ay: $x / $y") yalnızca `xl` ve üstünde yazılır;
 * daha darda kısa biçim ("$x / $y") kullanılır, tam metin erişilebilir adda ve balonda kalır. Bkz. `AppShell`.
 */
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
        data-testid="budget-pill"
        className={cn(
          "flex h-8 min-w-0 shrink items-center gap-2.5 rounded-full border bg-card px-2.5 text-[12px] transition-colors duration-150 hover:bg-accent sm:px-3",
          tone === "warning" && "border-nov-likely/60 bg-nov-likely/10",
          tone === "danger" && "border-destructive/50 bg-destructive/10",
        )}
        aria-label={text}
      >
        <span className="tabular whitespace-nowrap font-semibold">
          <span className="hidden xl:inline">{text}</span>
          <span className="xl:hidden">
            {fmtUsd(b.spentUsd)}
            <span className="font-normal text-muted-foreground max-[399px]:hidden">
              {" "}
              / {fmtUsd(b.monthlyUsd)}
            </span>
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
      <Badge variant="future" className="hidden cursor-help sm:inline-flex" tabIndex={0}>
        {t("provider.demo")}
      </Badge>
    </Tip>
  );
}

/**
 * Dar ekranda (<640 px, ör. dar tarayıcı penceresi) üst çubukta rozet için yer yoktur (TB-9: 320 px'te taşma). Gösterilen
 * işletmelerin örnek veri olduğu yine de hiçbir genişlikte gizlenmez: üst çubuğun altında tek satırlık ince bir şerit
 * yatay yer kaplamadan aynı açıklamayı yazar.
 */
function ProviderStrip() {
  const { data } = useStatus();
  if (data?.provider !== "mock") return null;
  return (
    <p
      className="border-b bg-nov-future/12 px-3 py-1 text-center text-[11px] font-medium leading-tight text-future-text sm:hidden"
      data-testid="provider-strip"
    >
      {t("provider.demo.tip")}
    </p>
  );
}

/**
 * Üst çubuk genişlik planı (5 gezinme öğesi; Inter gömülü olduğundan ölçüler işletim sisteminden bağımsızdır):
 *  - Gezinme ASLA daraltılmaz (`shrink-0`): daralırsa öğeleri kutusundan taşar ve sağ grup (demo rozeti, zil, bütçe)
 *    üzerine biner. Sığmayan yer sağ gruptan ve aşağıdaki kırılımlardan kazanılır.
 *  - Gezinme etiketleri `lg` (1024 px) ve üstünde görünür; daha darda yalnızca simge (ad `aria-label` ve balonda).
 *  - Logo yazısı ve bütçe hapının uzun metni `xl` (1280 px) ve üstünde.
 * e2e/ui-polish.spec.ts 320–1440 px aralığında, Türkçe ve İngilizce, çakışma olmadığını sınar.
 */
/**
 * Yardımda "Her yerde" diye listelenen `?` kısayolu Keşif dışındaki sayfalarda da çalışır. Keşif ("/") kendi
 * dinleyicisini ve tüm kısayolları gösteren yardımını kurar; iki dinleyici aynı anda etkin olmasın diye burada kapatılır.
 */
function GlobalShortcuts({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  useShortcuts({ help: () => setOpen(true) }, enabled);
  if (!enabled) return null;
  return <ShortcutsDialog open={open} onOpenChange={setOpen} shortcuts={GLOBAL_SHORTCUTS} />;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const theme = useResolvedTheme();
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <a
          href="#icerik"
          className="sr-only z-[70] rounded-md bg-card px-3 py-2 text-sm font-medium shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          {t("a11y.skip")}
        </a>
        <header className="relative z-30 flex h-12 min-w-0 shrink-0 items-center gap-1.5 border-b bg-card/90 px-3 min-[400px]:gap-3 sm:px-4 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:gap-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight max-[359px]:hidden"
            aria-label="Universal Mail"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground shadow-sm">
              U
            </span>
            <span className="hidden xl:inline">Universal Mail</span>
          </Link>
          <nav className="flex shrink-0 items-center gap-0.5 sm:gap-1" aria-label={t("nav.label")}>
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
                      "relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors duration-150 sm:px-2.5",
                      active
                        ? "bg-accent text-accent-foreground after:absolute after:inset-x-2.5 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-primary"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="hidden lg:inline">{t(key)}</span>
                  </Link>
                </Tip>
              );
            })}
          </nav>
          <div
            className="ml-auto flex min-w-0 items-center gap-1.5 min-[400px]:gap-3"
            data-testid="header-actions"
          >
            <ProviderBadge />
            <NotificationBell />
            <BudgetPill />
          </div>
        </header>
        <ProviderStrip />
        <WorkerStatusBanner />
        <main id="icerik" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {children}
        </main>
        <GlobalShortcuts enabled={pathname !== "/"} />
        <Toaster position="bottom-right" richColors closeButton duration={8000} theme={theme} />
      </div>
    </TooltipProvider>
  );
}
