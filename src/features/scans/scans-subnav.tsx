"use client";

import { FileSpreadsheet, Landmark, Layers } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { t, type TrKey } from "@/lib/i18n";

/**
 * Faz 5: lead kaynakları alt gezinmesi (harita taramaları / resmî sicil / listeden içe aktarma). Üst gezinmeye yeni öğe
 * EKLENMEZ (Faz 4'te beşinci öğe dar ekranda taşmaya yol açtı); sicil ve içe aktarma `/scans/*` altındadır ve "Taramalar"
 * üst öğesi önek eşleşmesiyle etkin kalır. Dar ekranda yatay kaydırılır, sayfa taşmaz.
 */
const ITEMS: { href: string; key: TrKey; icon: typeof Layers }[] = [
  { href: "/scans", key: "scans.subnav.scans", icon: Layers },
  { href: "/scans/registry", key: "scans.subnav.registry", icon: Landmark },
  { href: "/scans/import", key: "scans.subnav.import", icon: FileSpreadsheet },
];

export function ScansSubnav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label={t("scans.subnav.label")}
      className="um-scroll -mx-1 flex gap-1 overflow-x-auto overflow-y-hidden px-1 pb-1"
      data-testid="scans-subnav"
    >
      {ITEMS.map(({ href, key, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors duration-150",
              active
                ? "bg-accent text-foreground"
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
