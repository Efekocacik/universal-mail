"use client";

import { CircleHelp } from "lucide-react";
import { Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tip({
  content,
  children,
  side = "top",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-72 rounded-md bg-foreground px-2.5 py-1.5 text-[12px] leading-snug text-background shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:duration-150"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * "Bu nedir?" açıklaması (FR-UI-07): teknik olmayan kullanıcılar için kısa bilgi balonu.
 *
 * Faz 4 (10a-6): Radix Popover üzerine kuruldu; yalnızca fareyle üzerine gelince değil, TIKLAMA, dokunma ve Enter/Boşluk
 * ile de açılır, Esc veya dışarı tıklamayla kapanır (WCAG 1.4.13: kalıcı ve kapatılabilir içerik). Fareyle üzerine
 * gelince kısa gecikmeyle açılır ve imleç ayrılınca kapanır; tıklanarak açıldıysa kullanıcı kapatana kadar açık kalır.
 * Odak tetikleyicide kalır (okuma sırasında sayfa zıplamaz). Genel API değişmedi: `<HelpTip>{metin}</HelpTip>`.
 *
 * Ekran okuyucu: içerik `<body>` sonundaki bir portalda çizildiği için (Sekme ile ulaşılamaz) metin iki yoldan duyurulur:
 *  - açıkken tetikleyici `aria-describedby` ile içeriğe bağlanır (odak geri geldiğinde açıklama okunur);
 *  - tetikleyicinin yanındaki, HER ZAMAN DOM'da duran görünmez `aria-live="polite"` bölgesi açılınca metni alır;
 *    Enter/Boşluk ile açan kullanıcı odak değişmeden metni duyar.
 */
export function HelpTip({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  /** İsteğe bağlı kalın ilk satır. */
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();
  const pinned = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => clear, []);
  const hover = (next: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || pinned.current) return;
    clear();
    timer.current = setTimeout(() => setOpen(next), next ? 200 : 150);
  };
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        clear();
        if (!o) pinned.current = false;
        setOpen(o);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "relative inline-flex size-4 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2",
            className,
          )}
          aria-label={t("common.whatIsThis")}
          aria-describedby={open ? contentId : undefined}
          data-help-tip
          onClick={(e) => {
            // Tıklama: açıksa ve fareyle açıldıysa sabitle; değilse aç/kapat (Radix varsayılanı).
            if (open && !pinned.current) {
              e.preventDefault();
              pinned.current = true;
              return;
            }
            pinned.current = !open;
          }}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
        >
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <span className="sr-only" aria-live="polite" data-help-tip-live>
        {open ? (
          <>
            {title ? `${title}. ` : null}
            {children}
          </>
        ) : null}
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="note"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={() => clear()}
          onPointerLeave={(e) => hover(false)(e)}
          className="z-[60] max-w-72 rounded-md border bg-popover px-3 py-2 text-[12px] leading-snug text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150"
        >
          {/* Kimlik iç kapta: Radix içerik kimliği (tetikleyicinin aria-controls'u) bozulmasın. */}
          <div id={contentId}>
            {title && <p className="mb-0.5 font-semibold">{title}</p>}
            {children}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
