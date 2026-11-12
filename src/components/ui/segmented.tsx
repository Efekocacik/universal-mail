"use client";

import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Bölümlü tek seçim (radyo grubu). Ok tuşları seçimi değiştirir (WAI-ARIA radio group); yalnızca seçili seçenek sekme
 * sırasındadır. Seçili seçenek renk dışında onay işaretiyle de belirtilir.
 */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  testId,
}: {
  value: V;
  options: readonly { value: V; label: string; lang?: string }[];
  onChange: (v: V) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    const opt = options[next]!;
    onChange(opt.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className={cn("inline-flex flex-wrap gap-1 rounded-lg border bg-muted p-1", className)}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            lang={o.lang}
            disabled={disabled}
            onClick={() => !selected && onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
              selected
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            {selected && <Check className="size-3.5 text-primary" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
