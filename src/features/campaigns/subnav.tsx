"use client";

import { FileText, Mail, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/**
 * Kampanya alanının alt gezinmesi: Kampanyalar · Şablonlar · Uyum. Üst çubuk (docs/07-UI-REHBERI.md) 4 sabit
 * öğede kalır; bu üç ekran "Kampanyalar" altında bulunur ve üst çubukta "Kampanyalar" etkin görünür.
 */
export const SUBNAV = [
  { href: "/campaigns", key: "subnav.campaigns", icon: Mail },
  { href: "/templates", key: "subnav.templates", icon: FileText },
  { href: "/compliance", key: "subnav.compliance", icon: ShieldCheck },
] as const;

export function CampaignsSubnav() {
  const pathname = usePathname();
  return (
    <nav aria-label={t("subnav.label")} className="-mx-1 flex flex-wrap gap-1">
      {SUBNAV.map(({ href, key, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
