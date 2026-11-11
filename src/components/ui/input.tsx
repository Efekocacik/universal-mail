import * as React from "react";
import { cn } from "@/lib/cn";

const field =
  "w-full rounded-md border border-control bg-card px-3 text-sm shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-muted-foreground/50 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 disabled:hover:border-control aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:outline-destructive";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-20 resize-y py-2", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        field,
        "h-9 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-8",
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23646872' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-[13px] font-medium leading-none", className)} {...props} />;
}

/** Alanın altında kısa, sönük yardım metni. */
export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("text-[12px] leading-snug text-muted-foreground", className)} {...props} />
  );
}

/** Alanın altında kırmızı hata metni (ekran okuyucuya hemen bildirilir). */
export function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      role="alert"
      className={cn("text-[12px] leading-snug font-medium text-destructive", className)}
      {...props}
    />
  );
}
