import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/cn";

/** Sayfa başlığı: tek tutarlı biçim (başlık + tek cümlelik açıklama + sağda ana eylemler). */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Boş durum: ne olduğunu söyler ve tek net eylem sunar. `compact`: kart veya açılır menü içinde (simgesiz değilse küçük
 * simge, sola yaslı, dolgusuz); tam sayfa/liste boşluğunda varsayılan biçim kullanılır.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
  compact = false,
  testId,
}: {
  icon?: LucideIcon;
  /** Varsayılan biçimde zorunlu sayılır; `compact` biçimde tek cümlelik boşlukta yalnızca `body` yeterlidir. */
  title?: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
  testId?: string;
}) {
  if (compact)
    return (
      <div className={cn("flex flex-col items-start gap-2 py-2", className)} data-testid={testId}>
        <div className="flex items-start gap-2">
          {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div>
            {title && <p className="text-[13px] font-medium">{title}</p>}
            {body && (
              <p
                className={cn(
                  "text-muted-foreground",
                  title ? "mt-0.5 text-[12px]" : "text-[13px]",
                )}
              >
                {body}
              </p>
            )}
          </div>
        </div>
        {action}
      </div>
    );
  return (
    <div
      className={cn(
        "um-enter flex flex-col items-center justify-center gap-3 p-8 text-center",
        className,
      )}
      data-testid={testId}
    >
      {Icon && (
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <div>
        {title && <p className="text-sm font-semibold">{title}</p>}
        {body && <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/** Klavye kısayolu ipucu (örn. Esc). */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
