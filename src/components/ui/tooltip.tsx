"use client";

import { CircleHelp } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
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

/** "Bu nedir?" açıklaması (FR-UI-07): teknik olmayan kullanıcılar için kısa bilgi balonu. */
export function HelpTip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tip content={children}>
      <button
        type="button"
        className={cn(
          "relative inline-flex size-4 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2",
          className,
        )}
        aria-label={t("common.whatIsThis")}
      >
        <CircleHelp className="size-3.5" />
      </button>
    </Tip>
  );
}
