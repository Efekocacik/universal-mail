"use client";

import { CircleHelp } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/cn";

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
          className="z-[60] max-w-72 rounded-md bg-foreground px-2.5 py-1.5 text-[12px] leading-snug text-background shadow-lg"
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
          "inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
          className,
        )}
        aria-label="Bu nedir?"
      >
        <CircleHelp className="size-3.5" />
      </button>
    </Tip>
  );
}
