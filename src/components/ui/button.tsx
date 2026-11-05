import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Düğme renk dili (docs/07-UI-REHBERI.md):
 *  - default / success : YEŞİL dolu: kaydet, onayla, başlat, devam et.
 *  - destructive       : KIRMIZI dolu: yalnızca geri alınamaz silme/kaldırma ONAYI (onay penceresinde).
 *  - dangerOutline     : kırmızı çerçeveli: sayfadaki "Sil" gibi eylemler (tıklayınca onay penceresi açılır).
 *  - dangerGhost       : kırmızı metin: satır içi küçük sil/kaldır düğmeleri.
 *  - outline / secondary / ghost : nötr, ikincil eylemler (iptal, kapat, geri, düzenle).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow-md",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90 hover:shadow-md",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        outline: "border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:shadow-md",
        dangerOutline:
          "border border-destructive/40 bg-card text-destructive shadow-xs hover:border-destructive hover:bg-destructive/10",
        dangerGhost: "text-destructive hover:bg-destructive/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-[15px]",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Eylem sürerken dönen simge gösterir, düğmeyi kilitler (çift tıklamayı önler) ve ekran okuyucuya bildirir. */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const cls = cn(buttonVariants({ variant, size }), className);
  if (asChild)
    return (
      <Slot.Root className={cls} {...props}>
        {children}
      </Slot.Root>
    );
  return (
    <button
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export { buttonVariants };
