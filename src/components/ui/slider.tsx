"use client";

import { Slider as SliderPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/cn";

export function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn("relative flex h-5 w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-control/40">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-primary bg-thumb shadow transition-[box-shadow,transform] duration-150 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50" />
    </SliderPrimitive.Root>
  );
}
