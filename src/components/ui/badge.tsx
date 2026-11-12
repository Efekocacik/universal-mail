import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "bg-card text-muted-foreground",
        primary: "border-transparent bg-primary text-primary-foreground",
        future: "border-transparent bg-nov-future/12 text-future-text",
        high: "border-transparent bg-nov-high/12 text-success-text",
        likely: "border-transparent bg-nov-likely/16 text-warning-text",
        low: "border-transparent bg-nov-low/18 text-low-text",
        contacted: "border-transparent bg-contacted/12 text-info-text",
        success: "border-transparent bg-success/12 text-success-text",
        info: "border-transparent bg-info/10 text-info-text",
        danger: "border-transparent bg-destructive/8 text-danger-text",
        warning: "border-transparent bg-nov-likely/16 text-warning-text",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
